// Captures store screenshots of the reader, straight from the real renderer.
//
// Run with Electron, not node:
//   npx electron build/capture-store-shots.js
//
// Output: build/store-shots/*.png at 1600x900 logical pixels (16:9, comfortably
// above the 1366x768 the Microsoft Store wants), captured at the display's
// device pixel ratio, so a 1.5x screen yields 2400x1350.
//
// Pass a book to shoot:
//   npx electron build/capture-store-shots.js path/to/book.epub
//
// Without one it falls back to the bundled test fixture, which is fine for
// checking the script and useless as a screenshot: it is titled "Eupub Test
// Book", it is two sentences long, and it leaves most of the page empty. A
// store screenshot has to show the reader full of real prose, or it advertises
// an empty app. Use a public-domain book — Project Gutenberg's are ideal.
//
// Uses webContents.capturePage() rather than a screen grab, so the images are
// exactly the window's pixels — no desktop behind them, no scaling, no cursor,
// and reproducible on any machine. The IPC stubs mirror test/reader-e2e.js:
// this boots the renderer without main.js, which keeps the capture independent
// of window chrome and of whatever book the developer happens to have open.
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { openEpub } = require('../src/epub-extract');
const { makeEpub } = require('../test/make-epub');

app.disableHardwareAcceleration();
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'eupub-shots-')));
setTimeout(() => { console.log('FAIL — timed out'); app.exit(3); }, 90000);

const OUT = path.join(__dirname, 'store-shots');
const WIDTH = 1600;
const HEIGHT = 900;

let lexP = null;
const getLex = () => (lexP ||= import(pathToFileURL(path.join(__dirname, '..', 'dist', 'lexicon.mjs')).href).then((m) => m.data));

ipcMain.handle('epub:pick', () => null);
ipcMain.handle('epub:openPath', (_e, p) => openEpub(p));
ipcMain.handle('epub:samplePath', () => null);
ipcMain.handle('open:pending', () => false);
ipcMain.handle('fs:readText', (_e, p) => fs.readFileSync(p, 'utf8'));
ipcMain.handle('engine:source', () => fs.readFileSync(path.join(__dirname, '..', 'dist', 'eupub-engine.mobile.js'), 'utf8'));
ipcMain.handle('lexicon:subset', async (_e, words) => {
  const lex = await getLex();
  const out = [];
  for (const w of words || []) { const e = lex.get(String(w)); if (e) out.push([w, e]); }
  return out;
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A book usually opens on its cover, which is the one page with no prose on it —
// exactly what a screenshot of a reading app must not show. This clicks into the
// table of contents and waits for a chapter with real text.
//
// Two traps, both learned the hard way. A chapter's total text is not what is on
// screen — front matter is one long "chapter" whose visible page is a title page,
// so the size threshold has to be big enough to skip it. And even inside a real
// chapter the first page is mostly a heading, so page forward before shooting.
const gotoProse = (minChars = 6000, pagesIn = 2) => `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const text = () => {
    try {
      const d = document.getElementById('chapter').contentDocument;
      return d && d.body ? d.body.textContent.replace(/\\s+/g, ' ').trim() : '';
    } catch (e) { return ''; }
  };
  const links = [...document.querySelectorAll('#panel-toc a')].filter((a) => a.dataset.index !== '');
  for (const a of links.slice(2, 20)) {
    a.click();
    let ok = false;
    for (let i = 0; i < 60; i++) {
      await sleep(100);
      if (text().length >= ${minChars}) { ok = true; break; }
    }
    if (!ok) continue;
    for (let p = 0; p < ${pagesIn}; p++) {
      const next = document.getElementById('next');
      if (next && !next.disabled) next.click();
      await sleep(700);
    }
    return document.getElementById('status-right').textContent;
  }
  return false;
})()`;

async function shot(win, name) {
  await sleep(400); // let any transition settle before the frame is taken
  const img = await win.webContents.capturePage();
  const file = path.join(OUT, `${name}.png`);
  fs.writeFileSync(file, img.toPNG());
  const { width, height } = img.getSize();
  console.log(`  ${name}.png  ${width}x${height}  ${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
}

// One window per shot, with the preferences seeded before load. Driving the
// live UI instead — clicking the toggle and waiting — hangs the offscreen
// renderer partway through the re-render, and a screenshot script has no
// business being the thing that discovers that.
async function capture(win, indexHtml, epubPath, prefs, marker, name, after) {
  await win.webContents.executeJavaScript(
    `localStorage.clear();
     localStorage.setItem('eupub:last', ${JSON.stringify(epubPath)});
     localStorage.setItem('eupub:prefs', ${JSON.stringify(JSON.stringify(prefs))});
     true`,
  );
  await win.loadFile(indexHtml);

  const ready = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const iframe = document.getElementById('chapter');
    for (let i = 0; i < 150; i++) {
      try {
        const d = iframe.contentDocument;
        if (d && d.body && ${marker}.test(d.body.textContent)) return true;
      } catch (e) {}
      await sleep(100);
    }
    return false;
  })()`);
  if (!ready) throw new Error(`${name}: the chapter never rendered as expected`);

  if (after) await win.webContents.executeJavaScript(after);
  await shot(win, name);
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const arg = process.argv.slice(2).find((a) => /\.epub$/i.test(a));
  const epubPath = arg ? path.resolve(arg) : makeEpub();
  if (!arg) console.log('No book given — using the test fixture (not fit for a listing).');
  else console.log('Book:', epubPath);
  const indexHtml = path.join(__dirname, '..', 'src', 'renderer', 'index.html');
  const on = { euspell: true, fontSize: 14, theme: 'light', searchCaseSensitive: false };
  const off = Object.assign({}, on, { euspell: false });
  const dark = Object.assign({}, on, { theme: 'dark' });

  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    show: false,
    webPreferences: {
      offscreen: true,
      preload: path.join(__dirname, '..', 'src', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  await win.loadFile(indexHtml);

  console.log(`Capturing at ${WIDTH}x${HEIGHT} logical pixels:`);
  try {
    // The pair is the product. One screenshot of reformed text alone reads as a
    // typo; the same page either way reads as a feature.
    // The marker is just "some prose rendered": a real book will not contain
    // the fixture's words, and waiting on a specific reformed spelling would
    // make the script book-specific.
    const hideSidebar = `document.getElementById('sidebar').classList.add('hidden'); true`;
    const prose = gotoProse();
    // Reader first, chrome second: the page of text is what the listing is
    // selling, so the sidebar is out of the way for the pair.
    await capture(win, indexHtml, epubPath, on, '/\\w{4}/', '01-reformed', `${prose}.then(() => { ${hideSidebar} })`);
    await capture(win, indexHtml, epubPath, off, '/\\w{4}/', '02-original', `${prose}.then(() => { ${hideSidebar} })`);
    await capture(win, indexHtml, epubPath, on, '/\\w{4}/', '03-contents', prose);
    await capture(win, indexHtml, epubPath, dark, '/\\w{4}/', '04-dark', `${prose}.then(() => { ${hideSidebar} })`);
  } catch (err) {
    console.log('FAIL —', err.message);
    app.exit(1);
  }

  console.log(`Wrote ${OUT}`);
  app.exit(0);
});
