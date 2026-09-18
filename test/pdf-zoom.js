// End-to-end test of PDF magnification: open a real PDF in the real reader,
// drive the A−/A+ buttons, and confirm the pages actually re-rasterize larger,
// stay reachable, and come back at the saved zoom on the next open.
//
// The toolbar buttons live in the reader (file://) but the pages live in the
// embedded viewer (app://eupub), which is CROSS-ORIGIN to it — contentDocument
// is unreachable, by design. So the reader half is driven through the window's
// webContents and the page half through the child WebFrameMain, which crosses
// the origin boundary the way the postMessage channel under test does.
//
//   run with:  npx electron test/pdf-zoom.js
const { app, BrowserWindow, ipcMain, protocol } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { makePdf } = require('./make-pdf');
const { makeEpub } = require('./make-epub');
const { openEpub } = require('../src/epub-extract');

app.disableHardwareAcceleration();
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'eupub-pdfzoom-')));
setTimeout(() => { console.log('FAIL — timed out (60s)'); app.exit(3); }, 60000);

// Mirrors main.js: the viewer page needs a real (standard, secure) origin to
// fetch its worker/wasm/fonts and the PDF same-origin under its own CSP.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

const ROOT = path.join(__dirname, '..');
const pdfRegistry = new Map();

/** The PDF book descriptor main.js's pdfDescriptor returns. */
function pdfDescriptor(filePath) {
  const id = crypto.randomUUID();
  pdfRegistry.set(id, filePath);
  return {
    kind: 'pdf',
    sourcePath: filePath,
    url: `app://eupub/pdf/${id}/${encodeURIComponent(path.basename(filePath))}`,
    title: path.basename(filePath).replace(/\.pdf$/i, ''),
  };
}

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript', // the pdf.js module worker refuses octet-stream
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
};

// The same two asset mounts plus the by-id PDF route main.js serves.
function registerAppProtocol() {
  const mounts = [
    { prefix: '/assets/pdf/', dir: path.join(ROOT, 'dist', 'pdf') },
    { prefix: '/assets/pdfjs/', dir: path.join(ROOT, 'dist', 'pdfjs') },
  ];
  const notFound = () => new Response('', { status: 404 });
  const fileResponse = (p, type) =>
    new Response(Readable.toWeb(fs.createReadStream(p)), {
      headers: { 'content-type': type || MIME[path.extname(p).toLowerCase()] || 'application/octet-stream' },
    });
  protocol.handle('app', (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== 'eupub') return notFound();
      const pathname = decodeURIComponent(url.pathname);
      const m = /^\/pdf\/([0-9a-f-]+)\//.exec(pathname);
      if (m) {
        const p = pdfRegistry.get(m[1]);
        return p && fs.existsSync(p) ? fileResponse(p, 'application/pdf') : notFound();
      }
      for (const { prefix, dir } of mounts) {
        if (!pathname.startsWith(prefix)) continue;
        const p = path.resolve(dir, pathname.slice(prefix.length));
        if (p !== dir && !p.startsWith(dir + path.sep)) return notFound();
        return fs.existsSync(p) && fs.statSync(p).isFile() ? fileResponse(p) : notFound();
      }
      return notFound();
    } catch {
      return notFound();
    }
  });
}

ipcMain.handle('epub:pick', () => null);
// Both kinds, so the last step can leave PDF mode for a chapter book the way
// main.js's openBook does — by extension.
ipcMain.handle('epub:openPath', (_e, p) => (/\.pdf$/i.test(p) ? pdfDescriptor(p) : openEpub(p)));
ipcMain.handle('open:pending', () => false);
ipcMain.handle('fs:readText', (_e, p) => fs.readFileSync(p, 'utf8'));
ipcMain.handle('engine:source', () => fs.readFileSync(path.join(ROOT, 'dist', 'eupub-engine.mobile.js'), 'utf8'));
ipcMain.handle('system:naturalScroll', () => false);
// No bundled sample in the harness: the reader must reopen what the test seeded,
// not fall through to a first-run sample.
ipcMain.handle('epub:samplePath', () => null);
// The viewer asks for its vocabulary through the desktop bridge relay. Served
// for real, not stubbed: reforming is what exercises the rest of renderPage —
// the text layer, the pristine snapshot, and the per-word colour sampling that
// reads back from the canvas in backing-store pixels.
const { pathToFileURL } = require('node:url');
let lexP = null;
const getLex = () =>
  (lexP ||= import(pathToFileURL(path.join(ROOT, 'dist', 'lexicon.mjs')).href).then((m) => m.data));
ipcMain.handle('lexicon:subset', async (_e, words) => {
  const lex = await getLex();
  const out = [];
  for (const w of words || []) {
    const e = lex.get(String(w));
    if (e) out.push([w, e]);
  }
  return out;
});

const INDEX = path.join(ROOT, 'src', 'renderer', 'index.html');

/** The viewer frame inside the reader window, once it has been created. */
function pdfFrame(win) {
  return win.webContents.mainFrame.framesInSubtree.find((f) => f.url.includes('/assets/pdf/viewer.html'));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One reading of page 1's box, or null before the viewer has laid one out. */
function samplePage(win) {
  const frame = pdfFrame(win);
  if (!frame) return null;
  return frame.executeJavaScript(`(() => {
    const p = document.querySelector('#pages > div');
    if (!p) return null;
    const r = p.getBoundingClientRect();
    return { width: Math.round(r.width), left: Math.round(r.left), scrollWidth: document.documentElement.scrollWidth };
  })()`);
}

/**
 * The laid-out width of page 1, in CSS px, plus how far its left edge sits from
 * the viewport's — negative means clipped into unreachable overflow.
 *
 * Waits for the width to STOP moving, not merely to exist. The first layout can
 * be a scrollbar-width too wide: pages are fitted to the container before the
 * document is tall enough to need a vertical scrollbar, and the resize that
 * appearing scrollbar triggers re-fits them ~17px narrower. Sampling on the
 * first non-zero width caught that intermediate value (862px for a page that
 * settles at 845px) and made the ratio checks flaky under load.
 *
 * Three agreeing samples is 300ms of quiet, past both the resize debounce
 * (200ms) and the zoom one (150ms). `changedFrom` additionally refuses the
 * pre-click width, so a step is never measured before it has been applied.
 */
async function pageGeometry(win, { changedFrom = null } = {}) {
  let last = null;
  let stable = 0;
  for (let i = 0; i < 200; i++) {
    const g = await samplePage(win);
    if (g && g.width > 0 && g.width !== changedFrom) {
      stable = last && g.width === last.width ? stable + 1 : 0;
      last = g;
      if (stable >= 2) return g;
    } else {
      stable = 0;
      if (g) last = g;
    }
    await sleep(150);
  }
  throw new Error(`the PDF viewer never settled on a page width (last: ${JSON.stringify(last)})`);
}

const readerEval = (win, js) => win.webContents.executeJavaScript(js);
const prefs = (win) => readerEval(win, `JSON.parse(localStorage.getItem('eupub:prefs') || '{}')`);

app.whenReady().then(async () => {
  registerAppProtocol();
  const pdfPath = makePdf(path.join(app.getPath('userData'), 'zoom-sample.pdf'));

  const win = new BrowserWindow({
    width: 900,
    height: 700,
    show: false,
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  await win.loadFile(INDEX);
  await readerEval(win, `localStorage.clear(); localStorage.setItem('eupub:last', ${JSON.stringify(pdfPath)}); true`);
  await win.loadFile(INDEX);

  const fails = [];
  const check = (ok, label, detail) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} — ${label}${detail ? `  (${detail})` : ''}`);
    if (!ok) fails.push(label);
  };

  // --- 1. the PDF opens, and the magnify buttons come alive ----------------
  const firstLayout = await pageGeometry(win);
  check(firstLayout.width > 0, 'the PDF lays out a page', `${firstLayout.width}px wide`);

  // Enabled only once the viewer has reported its ladder with 'ready'; there is
  // nothing to step before that, and enableControls(false) left them disabled.
  const buttons = await readerEval(win, `({
    down: !document.getElementById('font-down').disabled,
    up: !document.getElementById('font-up').disabled,
    downTitle: document.getElementById('font-down').title,
    upTitle: document.getElementById('font-up').title,
  })`);
  check(buttons.down && buttons.up, 'A− and A+ are enabled in PDF mode');
  check(
    buttons.downTitle === 'Zoom out' && buttons.upTitle === 'Zoom in',
    'the tooltips say zoom, not text size',
    `${buttons.downTitle} / ${buttons.upTitle}`
  );

  // The baseline is taken AFTER one round trip, not from the first layout.
  // Pages are first fitted to a container that has no vertical scrollbar yet —
  // the one they cause — and nothing re-fits them until something calls
  // relayout, so the opening width is ~17px wider than the settled fit (862 vs
  // 845 here). Pre-existing, and unrelated to zoom, but it would make every
  // ratio below compare an unsettled width against a settled one.
  await readerEval(win, `document.getElementById('font-up').click(); true`);
  const settling = await pageGeometry(win, { changedFrom: firstLayout.width });
  await readerEval(win, `document.getElementById('font-down').click(); true`);
  const at100 = await pageGeometry(win, { changedFrom: settling.width });
  check(
    at100.width > 0 && (await prefs(win)).pdfZoom === 1,
    'a round trip returns to 100%',
    `first layout ${firstLayout.width}px, settled ${at100.width}px`
  );

  // --- 1b. the page really renders, in euspell, at full device resolution --
  // Guards the raster path the zoom cap now sits in: the canvas must still be
  // backed at devicePixelRatio for an ordinary page (the cap is a ceiling, not
  // a target), and the reformed text layer must still be produced.
  // Polled, not sampled once: the round trip above re-rendered every page, so
  // the canvas can be back before its text layer has been rebuilt and reformed.
  let render = { backingRatio: 0, dpr: 0, text: '' };
  for (let i = 0; i < 100; i++) {
    render = await pdfFrame(win).executeJavaScript(`(() => {
      const canvas = document.querySelector('#pages canvas');
      const layer = document.querySelector('#pages .textLayer');
      return {
        backingRatio: canvas ? canvas.width / parseFloat(canvas.style.width) : 0,
        dpr: window.devicePixelRatio,
        text: layer ? layer.textContent.replace(/\\s+/g, ' ').trim().slice(0, 60) : '',
      };
    })()`);
    if (render.text) break;
    await sleep(150);
  }
  check(
    Math.abs(render.backingRatio - render.dpr) < 0.01,
    'an ordinary page is still backed at full device resolution',
    `${render.backingRatio.toFixed(2)}x vs dpr ${render.dpr}`
  );
  check(/peeple|thoht/.test(render.text), 'the page is reformed into euspell', `"${render.text}"`);

  // --- 2. A+ re-rasterizes the page larger --------------------------------
  await readerEval(win, `document.getElementById('font-up').click(); true`);
  const at125 = await pageGeometry(win, { changedFrom: at100.width });
  const ratio = at125.width / at100.width;
  check(
    Math.abs(ratio - 1.25) < 0.02,
    'A+ steps one stop up the ladder (100% -> 125%)',
    `${at100.width}px -> ${at125.width}px, x${ratio.toFixed(3)}`
  );
  check((await prefs(win)).pdfZoom === 1.25, 'the factor is persisted, not the ladder index', JSON.stringify((await prefs(win)).pdfZoom));

  // --- 3. a magnified page stays reachable --------------------------------
  // The regression guard for #pages' centring: plain `align-items: center`
  // overflows a too-wide page symmetrically and pins its left edge off-screen
  // where no scroll can reach it (measured -215px on an 800px window).
  check(
    at125.width > at100.width && at125.left >= 0,
    'a page wider than the window is not clipped off its left edge',
    `left=${at125.left}px, scrollWidth=${at125.scrollWidth}px`
  );
  check(
    at125.scrollWidth >= at125.width,
    'the document scrolls far enough to show the whole page',
    `${at125.scrollWidth}px >= ${at125.width}px`
  );

  // --- 4. A− comes back, and the ceiling disables A+ ----------------------
  await readerEval(win, `document.getElementById('font-down').click(); true`);
  const back = await pageGeometry(win, { changedFrom: at125.width });
  check(back.width === at100.width, 'A− returns to exactly the width it started at', `${back.width}px vs ${at100.width}px`);

  // Ten clicks is past the top of any sane ladder; the button must end disabled
  // rather than keep stepping.
  await readerEval(win, `for (let i = 0; i < 10; i++) document.getElementById('font-up').click(); true`);
  const ceiling = await readerEval(win, `({
    up: document.getElementById('font-up').disabled,
    down: document.getElementById('font-down').disabled,
    zoom: JSON.parse(localStorage.getItem('eupub:prefs')).pdfZoom,
  })`);
  check(ceiling.up && !ceiling.down, 'at the ceiling A+ is disabled and A− is not', `zoom=${ceiling.zoom}`);

  // --- 5. the saved zoom is restored on the next open ---------------------
  await readerEval(win, `document.getElementById('font-down').click(); true`);
  await pageGeometry(win);
  const saved = (await prefs(win)).pdfZoom;
  await win.loadFile(INDEX); // reopens eupub:last from scratch, like a relaunch
  const reopened = await pageGeometry(win);
  check(
    Math.abs(reopened.width / at100.width - saved) < 0.02,
    'reopening restores the saved zoom',
    `saved ${saved}, got x${(reopened.width / at100.width).toFixed(3)}`
  );

  // --- 6. leaving PDF mode hands the buttons back to the font size --------
  // The two magnifications are separate state on the same two buttons, so the
  // handover has to go both ways: titles back to text, A+ moving fontSize again,
  // and the PDF's zoom left untouched for the next PDF.
  // Through the recent list, not the legacy eupub:last slot — the first open
  // consumed that into recents, and recents[0] is what init reopens from then on.
  const epubPath = makeEpub();
  await readerEval(
    win,
    `localStorage.setItem('eupub:recent', JSON.stringify([{ path: ${JSON.stringify(epubPath)}, title: 'Chapters' }])); true`
  );
  await win.loadFile(INDEX);
  for (let i = 0; i < 100 && !(await readerEval(win, `!document.getElementById('font-up').disabled`)); i++) {
    await sleep(100);
  }
  const beforeFont = (await prefs(win)).fontSize;
  await readerEval(win, `document.getElementById('font-up').click(); true`);
  const after = await readerEval(win, `({
    upTitle: document.getElementById('font-up').title,
    downTitle: document.getElementById('font-down').title,
    prefs: JSON.parse(localStorage.getItem('eupub:prefs')),
  })`);
  check(
    after.upTitle === 'Larger text' && after.downTitle === 'Smaller text',
    'leaving PDF mode restores the text-size tooltips',
    `${after.downTitle} / ${after.upTitle}`
  );
  check(
    after.prefs.fontSize === beforeFont + 1,
    'A+ moves the font size again once a chapter book is open',
    `${beforeFont} -> ${after.prefs.fontSize}`
  );
  check(
    after.prefs.pdfZoom === saved,
    'the chapter font size and the PDF zoom are independent',
    `pdfZoom still ${after.prefs.pdfZoom}`
  );

  console.log(fails.length ? `\nFAILED: ${fails.join('; ')}` : '\nAll PDF zoom checks passed.');
  app.exit(fails.length ? 1 : 0);
});
