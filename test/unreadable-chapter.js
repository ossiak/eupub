// A chapter that can't be read (deleted mid-session, a permissions change, a
// corrupt extraction) must leave the reader where it was. go() commits the new
// spine index synchronously — the toolbar and TOC update immediately — while the
// chapter's own render is async, so a failed read has to put the index back or
// everything keyed by it describes a chapter that is not on screen.
//
//   run with:  npx electron test/unreadable-chapter.js
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { openEpub } = require('../src/epub-extract');
const { makeEpub } = require('./make-epub');

app.disableHardwareAcceleration();
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'eupub-test-')));
setTimeout(() => { console.log('FAIL — timed out (40s)'); app.exit(3); }, 40000);

const { pathToFileURL } = require('node:url');
let lexP = null;
const getLex = () => (lexP ||= import(pathToFileURL(path.join(__dirname, '..', 'dist', 'lexicon.mjs')).href).then((m) => m.data));

ipcMain.handle('epub:pick', () => null);
ipcMain.handle('epub:openPath', (_e, p) => openEpub(p));
ipcMain.handle('open:pending', () => false);
ipcMain.handle('system:naturalScroll', () => true);
ipcMain.handle('engine:source', () => fs.readFileSync(path.join(__dirname, '..', 'dist', 'eupub-engine.mobile.js'), 'utf8'));
ipcMain.handle('lexicon:subset', async (_e, words) => {
  const lex = await getLex();
  const out = [];
  for (const w of words || []) { const e = lex.get(String(w)); if (e) out.push([w, e]); }
  return out;
});
// Chapter two is unreadable; everything else (the OPF, the nav, chapter one)
// reads normally, so the book opens and only the navigation to ch2 fails.
ipcMain.handle('fs:readText', (_e, p) => {
  if (/ch2\.xhtml$/i.test(String(p))) throw new Error('simulated unreadable chapter');
  return fs.readFileSync(p, 'utf8');
});

app.whenReady().then(async () => {
  const epubPath = makeEpub();
  const win = new BrowserWindow({
    width: 900,
    height: 700,
    show: false,
    webPreferences: {
      offscreen: true,
      preload: path.join(__dirname, '..', 'src', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  const indexHtml = path.join(__dirname, '..', 'src', 'renderer', 'index.html');
  await win.loadFile(indexHtml);
  await win.webContents.executeJavaScript(`localStorage.clear(); localStorage.setItem('eupub:last', ${JSON.stringify(epubPath)}); true`);
  await win.loadFile(indexHtml);

  const result = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const iframe = document.getElementById('chapter');
    const toc = document.getElementById('panel-toc');
    const text = () => {
      const d = iframe.contentDocument;
      if (!d || !d.body) return '';
      const clone = d.body.cloneNode(true);
      clone.querySelectorAll('script,style').forEach((n) => n.remove());
      return clone.textContent.replace(/\\s+/g, ' ').trim();
    };
    const activeToc = () => {
      const rows = [...toc.children];
      return rows.findIndex((a) => a.classList.contains('active'));
    };

    for (let i = 0; i < 60 && !/Qhapter Wun/.test(text()); i++) await sleep(100);
    const before = { status: document.getElementById('status-right').textContent, toc: activeToc() };

    // Navigate to the unreadable chapter via its TOC row.
    toc.children[1].click();
    for (let i = 0; i < 60; i++) {
      if (/could not be read/.test(document.getElementById('status-left').textContent)) break;
      await sleep(100);
    }
    await sleep(300); // let any (incorrect) render settle before sampling

    const after = {
      statusLeft: document.getElementById('status-left').textContent,
      status: document.getElementById('status-right').textContent,
      toc: activeToc(),
      body: text().slice(0, 30),
    };

    // The reader must still be usable: paging on from where it actually is goes
    // nowhere (ch1 is one page and ch2 is unreadable), but must not throw, and a
    // bookmark must be filed against the chapter on screen.
    document.getElementById('bookmark-btn').click();
    await sleep(200);
    const bmLabel = (JSON.parse(localStorage.getItem('eupub:bm:id:urn:uuid:eupub-test-0001') || '[]')[0] || {});

    return { before, after, bookmarkIndex: bmLabel.index };
  })()`);

  const { before, after } = result;
  const checks = [
    ['opened-on-ch1', /Ch 1\/2/.test(before.status) && before.toc === 0,
      'status="' + before.status + '" tocRow=' + before.toc],
    ['error-reported', /could not be read/.test(after.statusLeft), 'status="' + after.statusLeft + '"'],
    // The chapter on screen never changed…
    ['chapter-still-displayed', /Qhapter Wun/.test(after.body), 'body="' + after.body + '"'],
    // …so neither may the counter, the TOC highlight, or the index a bookmark
    // is filed under.
    ['counter-not-advanced', /Ch 1\/2/.test(after.status), 'status="' + after.status + '"'],
    ['toc-highlight-not-moved', after.toc === 0, 'tocRow=' + after.toc],
    ['bookmark-files-visible-chapter', result.bookmarkIndex === 0, 'index=' + result.bookmarkIndex],
  ];
  for (const [name, ok, info] of checks) console.log((ok ? 'PASS ' : 'FAIL ') + name.padEnd(30), info);
  const passed = checks.every((c) => c[1]);
  console.log(passed ? 'ALL PASS' : 'SOME FAILED');
  app.exit(passed ? 0 : 1);
});
