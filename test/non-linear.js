// Spine items marked linear="no" (EPUB3 pop-up footnotes, stray cover/ad pages)
// are reachable but are NOT part of the reading sequence. This book is
//
//   spine: 0 ch1 · 1 notea (linear=no) · 2 ch2 · 3 noteb (linear=no)
//
// built without a nav document, so the TOC comes from the spine — which is the
// path where a filtered index used to be written into spineIndex.
//
//   run with:  npx electron test/non-linear.js
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
ipcMain.handle('fs:readText', (_e, p) => fs.readFileSync(p, 'utf8'));
ipcMain.handle('system:naturalScroll', () => true);
ipcMain.handle('engine:source', () => fs.readFileSync(path.join(__dirname, '..', 'dist', 'eupub-engine.mobile.js'), 'utf8'));
ipcMain.handle('lexicon:subset', async (_e, words) => {
  const lex = await getLex();
  const out = [];
  for (const w of words || []) { const e = lex.get(String(w)); if (e) out.push([w, e]); }
  return out;
});

app.whenReady().then(async () => {
  const epubPath = makeEpub(undefined, { nonLinear: true, nav: false });
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
    const text = () => {
      const d = iframe.contentDocument;
      if (!d || !d.body) return '';
      const clone = d.body.cloneNode(true);
      clone.querySelectorAll('script,style').forEach((n) => n.remove());
      return clone.textContent.replace(/\\s+/g, ' ').trim();
    };
    // Wait for a chapter whose text matches \`re\`, returning what was shown.
    const waitFor = async (re, tries = 60) => {
      for (let i = 0; i < tries; i++) {
        const t = text();
        if (re.test(t)) return t;
        await sleep(100);
      }
      return text();
    };

    await waitFor(/Qhapter Wun/);
    const tocLabels = [...document.getElementById('panel-toc').children].map((a) => a.textContent);
    const tocIndexes = [...document.getElementById('panel-toc').children].map((a) => a.dataset.index);
    const statusAtStart = document.getElementById('status-right').textContent;

    // 1. Page forward off the end of ch1. ch1 is one page, so the first
    //    ArrowRight hits the edge and asks the reader to turn the chapter.
    iframe.contentWindow.focus();
    iframe.contentDocument.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    const afterTurn = await waitFor(/Qhapter Twu|Zarquon/);
    const statusAfterTurn = document.getElementById('status-right').textContent;
    // On the last reading-order chapter there is nowhere further to page, even
    // though a non-linear document still follows it in the spine.
    const nextDisabledOnLast = document.getElementById('next-btn').disabled;

    // 2. The second TOC row must open ch2 — not the non-linear document that
    //    sits between them in the spine.
    document.getElementById('panel-toc').children[1].click();
    const afterTocClick = await waitFor(/Qhapter Twu|Zarquon/);

    // 3. A non-linear document is still reachable the way it is meant to be:
    //    by following a link to it. Back to ch1, then click its note link.
    document.getElementById('panel-toc').children[0].click();
    await waitFor(/Qhapter Wun/);
    const link = iframe.contentDocument.getElementById('notelink');
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    const afterLink = await waitFor(/Zarquon/);

    return {
      tocLabels, tocIndexes, statusAtStart, statusAfterTurn, nextDisabledOnLast,
      afterTurn: afterTurn.slice(0, 40),
      afterTocClick: afterTocClick.slice(0, 40),
      afterLink: afterLink.slice(0, 40),
    };
  })()`);

  const checks = [
    // The spine-derived TOC lists only reading-order documents, and each row
    // carries its index into the SPINE (0 and 2), not into the filtered list.
    ['toc-excludes-nonlinear', result.tocLabels.length === 2, 'labels=' + JSON.stringify(result.tocLabels)],
    ['toc-keeps-spine-indexes', result.tocIndexes.join(',') === '0,2', 'indexes=' + result.tocIndexes.join(',')],
    // The chapter counter reports reading-order chapters, not spine files.
    ['counter-excludes-nonlinear', /Ch 1\/2/.test(result.statusAtStart), 'status="' + result.statusAtStart + '"'],
    // The core regression: paging past ch1 lands on ch2, stepping over notea.
    ['page-turn-skips-nonlinear', /Qhapter Twu/.test(result.afterTurn) && !/Zarquon/.test(result.afterTurn),
      'showed="' + result.afterTurn + '"'],
    ['counter-after-turn', /Ch 2\/2/.test(result.statusAfterTurn), 'status="' + result.statusAfterTurn + '"'],
    // A trailing non-linear document is not somewhere › can go.
    ['next-disabled-past-last-chapter', result.nextDisabledOnLast === true, 'disabled=' + result.nextDisabledOnLast],
    // The TOC row for ch2 opens ch2.
    ['toc-row-opens-named-chapter', /Qhapter Twu/.test(result.afterTocClick) && !/Zarquon/.test(result.afterTocClick),
      'showed="' + result.afterTocClick + '"'],
    // …and non-linear content is still reachable by link.
    ['nonlinear-reachable-by-link', /Zarquon/.test(result.afterLink), 'showed="' + result.afterLink + '"'],
  ];
  for (const [name, ok, info] of checks) console.log((ok ? 'PASS ' : 'FAIL ') + name.padEnd(30), info);
  const passed = checks.every((c) => c[1]);
  console.log(passed ? 'ALL PASS' : 'SOME FAILED');
  app.exit(passed ? 0 : 1);
});
