// Full-pipeline test (offscreen Electron). Exercises the real path end to end:
// build an EPUB -> extract it (shared epub-extract) -> load the real index.html
// with the real preload -> parse OPF/nav in the renderer -> render chapter 1
// into the actual #chapter iframe with the engine injected -> read back the
// converted text. Reuses src/preload.js and the same IPC handlers as main.js.
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { openEpub } = require('../src/epub-extract');
const { makeEpub } = require('./make-epub');

app.disableHardwareAcceleration();

ipcMain.handle('epub:openPath', (_e, p) => openEpub(p));
ipcMain.handle('fs:readText', (_e, p) => fs.readFileSync(p, 'utf8'));
// This test builds its own srcdoc with the full engine; the no-op keeps reader.js's
// auto-open (of any stale last book) from erroring on the new subset channel.
ipcMain.handle('lexicon:subset', () => []);
ipcMain.handle('engine:source', () =>
  fs.readFileSync(path.join(__dirname, '..', 'dist', 'eupub-engine.js'), 'utf8')
);

setTimeout(() => {
  console.log('FAIL — timed out (30s)');
  app.exit(3);
}, 30000);

app.whenReady().then(async () => {
  const epubPath = makeEpub();
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      offscreen: true,
      preload: path.join(__dirname, '..', 'src', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));

  const result = await win.webContents.executeJavaScript(`(async () => {
    const book  = await window.eupub.openPath(${JSON.stringify(epubPath)});
    const model = await window.EupubModel.parseAsync(book);

    // Render chapter 1 into the real #chapter iframe with the engine injected,
    // mirroring reader.renderChapter, then read back the converted body text.
    const item = model.spine[0];
    const html = await window.eupub.readText(item.absPath);
    const base = window.eupub.fileURL(window.eupub.dirname(item.absPath)) + '/';
    const engine = await window.eupub.engineSource();

    const doc = new DOMParser().parseFromString(html, 'text/html');
    const b = doc.createElement('base'); b.setAttribute('href', base);
    doc.head.insertBefore(b, doc.head.firstChild);
    const s = doc.createElement('script'); s.textContent = engine; doc.body.appendChild(s);
    const srcdoc = '<!DOCTYPE html>' + doc.documentElement.outerHTML;

    const iframe = document.getElementById('chapter');
    const after = await new Promise((resolve) => {
      iframe.addEventListener('load', () => {
        // Read only the visible text — clone the body and drop script/style so the
        // injected engine source (a <script>) doesn't pollute the measurement.
        const clone = iframe.contentDocument.body.cloneNode(true);
        clone.querySelectorAll('script, style').forEach((n) => n.remove());
        resolve(clone.textContent.replace(/\\s+/g, ' ').trim());
      }, { once: true });
      iframe.srcdoc = srcdoc;
    });

    return {
      title: model.title,
      spineLen: model.spine.length,
      toc: model.toc.map((t) => t.label),
      after,
    };
  })()`);

  console.log('TITLE   :', result.title);
  console.log('SPINE   :', result.spineLen);
  console.log('TOC     :', result.toc.join(' | '));
  console.log('CH1 OUT :', result.after);

  const ok =
    result.title === 'Eupub Test Book' &&
    result.spineLen === 2 &&
    result.toc.join('|') === 'Chapter One|Chapter Two' &&
    /peeple/.test(result.after) &&
    /thoht/.test(result.after);

  console.log(ok ? 'PASS — pipeline OK' : 'FAIL — pipeline mismatch');
  app.exit(ok ? 0 : 1);
});
