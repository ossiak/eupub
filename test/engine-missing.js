// Reader behaviour when the euspell engine bundle is unavailable (a fresh clone
// before `npm run build:engine`, or a broken build). The reader must degrade to
// original spelling WITHOUT recording that as the user's preference: `prefs` is
// the object savePrefs() serializes, so a launch-time failure that clears
// prefs.euspell gets written to localStorage by the next unrelated control the
// user touches — and then survives the engine being rebuilt.
//
//   run with:  npx electron test/engine-missing.js
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { openEpub } = require('../src/epub-extract');
const { makeEpub } = require('./make-epub');

app.disableHardwareAcceleration();
// Isolate userData so this test never reads or overwrites real reading state.
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'eupub-test-')));
setTimeout(() => { console.log('FAIL — timed out (30s)'); app.exit(3); }, 30000);

ipcMain.handle('epub:pick', () => null);
ipcMain.handle('epub:openPath', (_e, p) => openEpub(p));
ipcMain.handle('open:pending', () => false);
ipcMain.handle('fs:readText', (_e, p) => fs.readFileSync(p, 'utf8'));
ipcMain.handle('system:naturalScroll', () => true);
ipcMain.handle('lexicon:subset', () => []);
// The point of this harness: the engine channel fails, exactly as main.js's
// handler does when dist/eupub-engine.mobile.js is missing.
ipcMain.handle('engine:source', () => {
  throw new Error('dist/eupub-engine.mobile.js is missing — run "npm run build:engine:mobile".');
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

  // Seed euspell:true (the default) plus the last-book pointer, then reload so
  // reader.js runs its real init() against the failing engine channel.
  await win.webContents.executeJavaScript(`
    localStorage.clear();
    localStorage.setItem('eupub:prefs', JSON.stringify({ euspell: true, fontSize: 14, theme: 'light' }));
    localStorage.setItem('eupub:last', ${JSON.stringify(epubPath)});
    true`);
  await win.loadFile(indexHtml);

  const result = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const box = document.getElementById('euspell-checkbox');
    const iframe = document.getElementById('chapter');

    // Wait for the book to open: the chapter renders, unreformed.
    let body = '';
    for (let i = 0; i < 120; i++) {
      const d = iframe.contentDocument;
      if (d && d.body && d.body.textContent.trim()) {
        const clone = d.body.cloneNode(true);
        clone.querySelectorAll('script,style').forEach((n) => n.remove());
        body = clone.textContent.replace(/\\s+/g, ' ').trim();
        if (body) break;
      }
      await sleep(100);
    }

    const boxBefore = { checked: box.checked, disabled: box.disabled };
    const prefsBefore = JSON.parse(localStorage.getItem('eupub:prefs') || '{}');

    // Touch an UNRELATED control. changeFont() calls savePrefs(), which writes
    // the whole prefs object — this is the step that used to persist the
    // launch-time failure as a stored preference.
    document.getElementById('font-up').click();
    await sleep(200);
    const prefsAfter = JSON.parse(localStorage.getItem('eupub:prefs') || '{}');

    return {
      body: body.slice(0, 60),
      reformed: /peeple|thoht/.test(body),
      boxBefore,
      prefsBefore,
      prefsAfter,
      fontChanged: prefsAfter.fontSize === 15,
    };
  })()`);

  const checks = [
    // The book still opens and reads, just in original spelling.
    ['renders-unreformed', result.body.length > 0 && !result.reformed, 'body="' + result.body + '"'],
    // The toggle is off and unavailable, so it can't silently do nothing.
    ['toggle-off-and-disabled', result.boxBefore.checked === false && result.boxBefore.disabled === true,
      'checked=' + result.boxBefore.checked + ' disabled=' + result.boxBefore.disabled],
    // Nothing wrote to prefs merely because the engine was missing.
    ['pref-untouched-at-boot', result.prefsBefore.euspell === true, 'euspell=' + result.prefsBefore.euspell],
    // Proves the save actually happened, so the check below isn't vacuous.
    ['font-change-saved', result.fontChanged, 'fontSize=' + result.prefsAfter.fontSize],
    // The regression: an unrelated save must not carry euspell:false with it.
    ['pref-survives-save', result.prefsAfter.euspell === true, 'euspell=' + result.prefsAfter.euspell],
  ];
  for (const [name, ok, info] of checks) console.log((ok ? 'PASS ' : 'FAIL ') + name.padEnd(24), info);
  const passed = checks.every((c) => c[1]);
  console.log(passed ? 'ALL PASS' : 'SOME FAILED');
  app.exit(passed ? 0 : 1);
});
