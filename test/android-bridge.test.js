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
