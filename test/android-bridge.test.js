// Unit test for the Android bridge shim (src/renderer/android-bridge.js). Runs
// the shim in a vm context that mimics the WebView global, with a mock native
// AndroidBridge + fetch, and checks the promise-registry round-trip, the
// virtual-origin path mapping, and the served-fetch methods. Pure Node — no
// Electron — so it runs first in `npm test`.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const SHIM = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'android-bridge.js'), 'utf8');

// Build a fresh WebView-like world with the shim loaded.
function makeWorld() {
  const calls = [];
  const fetched = [];
  const window = {
    AndroidBridge: {
      pickEpub: (id, args) => calls.push({ id, method: 'pickEpub', args: JSON.parse(args) }),
      openPath: (id, args) => calls.push({ id, method: 'openPath', args: JSON.parse(args) }),
      openExternal: (id, args) => calls.push({ id, method: 'openExternal', args: JSON.parse(args) }),
    },
    fetch: (url) => {
      fetched.push(url);
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('BODY:' + url) });
    },
  };
  const context = { window, Map, Promise, JSON, encodeURIComponent, Error, String, console };
  vm.runInNewContext(SHIM, context);
  return { window, calls, fetched };
}

test('openPath: native round-trip resolves and captures the book root', async () => {
  const { window, calls } = makeWorld();
  const book = { rootDir: '/data/user/0/app/cache/eupub-x', opfDir: '/data/user/0/app/cache/eupub-x/OEBPS', sourcePath: '/sd/b.epub' };
  const p = window.eupub.openPath('/sd/b.epub');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'openPath');
  assert.deepEqual(calls[0].args, ['/sd/b.epub']);

  window.__eupubResolve(calls[0].id, true, JSON.stringify(book));
  const got = await p;
  assert.deepEqual(got, book);

  // Root captured → fileURL maps an extracted path onto the served origin.
  assert.equal(
    window.eupub.fileURL('/data/user/0/app/cache/eupub-x/OEBPS/ch1.xhtml'),
    'https://eupub.local/book/OEBPS/ch1.xhtml'
  );
});

test('native call rejects when the host reports failure', async () => {
  const { window, calls } = makeWorld();
  const p = window.eupub.openExternal('https://example.com');
  window.__eupubResolve(calls[0].id, false, JSON.stringify({ message: 'blocked scheme' }));
  await assert.rejects(p, /blocked scheme/);
});

test('readText fetches the served virtual-origin URL, not a native call', async () => {
  const { window, calls, fetched } = makeWorld();
  window.__eupubBridge.setRoot('/data/user/0/app/cache/eupub-x');
  const txt = await window.eupub.readText('/data/user/0/app/cache/eupub-x/OEBPS/ch 1.xhtml');
  assert.equal(calls.length, 0); // no bridge round-trip
  assert.equal(fetched[0], 'https://eupub.local/book/OEBPS/ch%201.xhtml'); // encoded space
  assert.equal(txt, 'BODY:https://eupub.local/book/OEBPS/ch%201.xhtml');
});

test('engineSource fetches the engine asset URL', async () => {
  const { window, fetched } = makeWorld();
  const src = await window.eupub.engineSource();
  assert.equal(fetched[0], 'https://eupub.local/assets/eupub-engine.js');
  assert.match(src, /^BODY:/);
});

test('POSIX path helpers match the preload semantics (incl. .. resolution)', () => {
  const { window } = makeWorld();
  assert.equal(window.eupub.join('/a/b', '../c/./d'), '/a/c/d');
  assert.equal(window.eupub.join('/base', 'OEBPS', '../images/p.png'), '/base/images/p.png');
  assert.equal(window.eupub.dirname('/a/b/c.xhtml'), '/a/b');
  assert.equal(window.eupub.basename('/a/b/c.xhtml'), 'c.xhtml');
  assert.equal(window.eupub.dirname('/top.x'), '/');
});

test('concurrent native calls settle independently by id', async () => {
  const { window, calls } = makeWorld();
  const a = window.eupub.pickEpub();
  const b = window.eupub.openPath('/sd/two.epub');
  assert.equal(calls.length, 2);
  // Resolve out of order.
  window.__eupubResolve(calls[1].id, true, JSON.stringify({ rootDir: '/r2' }));
  window.__eupubResolve(calls[0].id, true, JSON.stringify(null));
  assert.deepEqual(await b, { rootDir: '/r2' });
  assert.equal(await a, null);
});

// A top window + a child frame linked by postMessage, each with the shim loaded.
// The child cannot be resolved by native directly (webView.evaluateJavascript
// only reaches the top frame), so its calls must relay through the top.
function makeFramePair() {
  const ORIGIN = 'https://eupub.local';
  const mkWin = () => ({ _h: [], addEventListener: function (t, fn) { if (t === 'message') this._h.push(fn); } });
  const top = mkWin();
  const child = mkWin();
  top.top = top; // a top frame's top is itself
  child.top = top; // the child's top is the top window
  top.AndroidBridge = { calls: [], lexiconSubset: (id, args) => top.AndroidBridge.calls.push({ id, args: JSON.parse(args) }) };
  // Deliver async, mirroring real postMessage; only the child ever posts to the
  // top, so a message arriving at the top is sourced from the child.
  const deliver = (win, source) => (data) =>
    queueMicrotask(() => win._h.forEach((h) => h({ data, origin: ORIGIN, source })));
  top.postMessage = deliver(top, child);
  child.postMessage = deliver(child, top);
  vm.runInNewContext(SHIM, { window: top, Map, Promise, JSON, encodeURIComponent, Error, String, console, queueMicrotask });
  vm.runInNewContext(SHIM, { window: child, Map, Promise, JSON, encodeURIComponent, Error, String, console, queueMicrotask });
  return { top, child };
}

test('onOpenFile delivers an OS-opened path, buffering until a handler registers', () => {
  // Deliver-before-register (cold-start intent): the path is buffered and
  // replayed when the reader registers its handler.
  const early = makeWorld();
  const seenEarly = [];
  early.window.__eupubOpenFile('/data/user/0/app/files/pdfs/a.pdf');
  early.window.eupub.onOpenFile((p) => seenEarly.push(p));
  assert.deepEqual(seenEarly, ['/data/user/0/app/files/pdfs/a.pdf']);

  // Register-before-deliver (warm start): the handler fires on delivery.
  const late = makeWorld();
  const seenLate = [];
  late.window.eupub.onOpenFile((p) => seenLate.push(p));
  late.window.__eupubOpenFile('/data/user/0/app/files/pdfs/b.pdf');
  assert.deepEqual(seenLate, ['/data/user/0/app/files/pdfs/b.pdf']);
});

test('hasPendingOpen combines the native answer with already-arrived opens', async () => {
  // Native says pending → true, regardless of arrival.
  const pending = makeWorld();
  pending.window.AndroidBridge.hasPendingOpen = (id) =>
    pending.window.__eupubResolve(id, true, 'true');
  assert.equal(await pending.window.eupub.hasPendingOpen(), true);

  // Native says not pending, but the open already arrived (delivery ordered
  // before the answer, as the UI-thread serialization guarantees) → still true.
  const arrived = makeWorld();
  arrived.window.AndroidBridge.hasPendingOpen = (id) =>
    arrived.window.__eupubResolve(id, true, 'false');
  arrived.window.__eupubOpenFile('/data/user/0/app/files/pdfs/c.pdf');
  assert.equal(await arrived.window.eupub.hasPendingOpen(), true);

  // No intent open at all → false: the reader keeps its auto-reopen.
  const idle = makeWorld();
  idle.window.AndroidBridge.hasPendingOpen = (id) =>
    idle.window.__eupubResolve(id, true, 'false');
  assert.equal(await idle.window.eupub.hasPendingOpen(), false);

  // A host without the native method rejects — the reader's catch keeps the
  // auto-reopen (same graceful fallback as the desktop preload contract).
  const old = makeWorld();
  await assert.rejects(old.window.eupub.hasPendingOpen());
});

test('a child frame relays native calls through the top frame', async () => {
  const { top, child } = makeFramePair();
  const p = child.eupub.lexiconSubset(['the', 'people']);

  // The relay reaches the top's real bridge, not the child's (the child has none).
  await new Promise((r) => queueMicrotask(r)); // let the relay message deliver
  assert.equal(top.AndroidBridge.calls.length, 1);
  assert.deepEqual(top.AndroidBridge.calls[0].args, [['the', 'people']]);

  // The top settles it (as native would), and the result relays back to the child.
  top.__eupubResolve(top.AndroidBridge.calls[0].id, true, JSON.stringify([['people', { encoding: 101 }]]));
  assert.deepEqual(await p, [['people', { encoding: 101 }]]);
});

// --- the baked-in version (build/bridge-version.mjs) ------------------------
// The About panel asks window.eupub.version(). The desktop preload forwards it
// to app.getVersion(); a WebView host has no such channel, so the value is
// substituted into the shim at asset-prep time rather than costing a Kotlin
// @JavascriptInterface method and a Swift message-handler case.

const os = require('node:os');
const PKG_VERSION = require('../package.json').version;
const RENDERER_DIR = path.join(__dirname, '..', 'src', 'renderer');
const bridgeVersion = () => import('../build/bridge-version.mjs');
const tmpdir = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), tag));

/** The shim as prepare-assets writes it, running in the WebView-like world. */
async function makeBakedWorld(version) {
  const { copyBridgeWithVersion } = await bridgeVersion();
  const dest = path.join(tmpdir('eupub-ver-'), 'android-bridge.js');
  copyBridgeWithVersion(path.join(RENDERER_DIR, 'android-bridge.js'), dest, version);
  const window = { AndroidBridge: {}, fetch: () => Promise.reject(new Error('unused')) };
  vm.runInNewContext(fs.readFileSync(dest, 'utf8'), {
    window, Map, Promise, JSON, encodeURIComponent, Error, String, console,
  });
  return window;
}

test('an unprepped shim reports no version rather than inventing one', async () => {
  // Reading the shim straight out of src/ with no asset prep is a real case, and
  // a hardcoded placeholder would be a number the About panel could show that
  // was never shipped.
  const { window } = makeWorld();
  assert.equal(await window.eupub.version(), null);
});

test('asset prep bakes package.json version into the shim', async () => {
  const window = await makeBakedWorld(PKG_VERSION);
  assert.equal(await window.eupub.version(), PKG_VERSION);
});

test('the substitution survives being re-run over its own output', async () => {
  // prepare-assets is run repeatedly and Android's output directory is not
  // cleared first, so the marker has to still match after a substitution —
  // otherwise the second run throws on a file that is already correct.
  const { copyBridgeWithVersion } = await bridgeVersion();
  const dir = tmpdir('eupub-ver2-');
  const once = path.join(dir, 'once.js');
  const twice = path.join(dir, 'twice.js');
  copyBridgeWithVersion(path.join(RENDERER_DIR, 'android-bridge.js'), once, '9.9.9');
  copyBridgeWithVersion(once, twice, '9.9.9');
  assert.equal(fs.readFileSync(once, 'utf8'), fs.readFileSync(twice, 'utf8'));
});

test('a shim with no marker is refused, not silently passed through', async () => {
  const { copyBridgeWithVersion } = await bridgeVersion();
  const dir = tmpdir('eupub-ver3-');
  const src = path.join(dir, 'no-marker.js');
  fs.writeFileSync(src, '(function (root) { root.eupub = {}; })(window);\n');
  assert.throws(
    () => copyBridgeWithVersion(src, path.join(dir, 'out.js'), '1.0.0'),
    /version marker not found/
  );
});

test('the desktop half asks Electron for the app version', () => {
  // test/about.js cannot cover this: run as `electron <script>` there is no
  // application package.json loaded, so app.getVersion() reports Electron's own
  // version and an assertion there would pin that instead of the contract. The
  // contract is that main asks Electron (which reads package.json for the real
  // app, packaged or via `electron .`) and preload forwards it under the same
  // name the mobile bridges use.
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
  assert.match(main, /ipcMain\.handle\('app:version', \(\) => app\.getVersion\(\)\)/);
  assert.match(preload, /version: \(\) => ipcRenderer\.invoke\('app:version'\)/);
});

test('both bridges carry the marker asset prep looks for', () => {
  // The two shims are maintained by hand and are meant to be identical apart
  // from their transport; a marker dropped from one would ship that platform's
  // About panel stuck on "unknown", with the build still passing.
  for (const f of ['android-bridge.js', 'ios-bridge.js']) {
    const js = fs.readFileSync(path.join(RENDERER_DIR, f), 'utf8');
    assert.match(js, /var VERSION = .*; \/\/ __EUPUB_VERSION__/, f + ' must carry the version marker');
    assert.match(
      js,
      /version: function \(\) \{ return Promise\.resolve\(VERSION\); \}/,
      f + ' must expose version()'
    );
  }
});
