// Plain-text pipeline test (offscreen Electron). Mirrors test/pipeline.js but for
// a .txt: synthesize a book with openText -> load the real index.html + preload ->
// parse the synthesized OPF/nav in the renderer -> render chapter 1 into the real
// #chapter iframe with the engine injected -> read back the converted text.
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { openText } = require('../src/text-open');

app.disableHardwareAcceleration();

ipcMain.handle('epub:openPath', (_e, p) => openText(p));
ipcMain.handle('fs:readText', (_e, p) => fs.readFileSync(p, 'utf8'));
ipcMain.handle('engine:source', () =>
  fs.readFileSync(path.join(__dirname, '..', 'dist', 'eupub-engine.js'), 'utf8')
);

// Fixture: a BOM, CRLF newlines, two chapter headings, and a wrapped paragraph
// with words that euspell reforms ("people" -> "peeple", "thought" -> "thoht").
function makeTextFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eupub-txt-'));
  const file = path.join(dir, 'Sample Book.txt');
  fs.writeFileSync(
    file,
    '﻿Chapter One\r\n\r\nThe people thought about\r\nthe light.\r\n\r\nChapter Two\r\n\r\nMore people gathered.\n',
    'utf8'
  );
  return file;
}

setTimeout(() => {
  console.log('FAIL — timed out (30s)');
  app.exit(3);
}, 30000);

app.whenReady().then(async () => {
  const textPath = makeTextFixture();
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
    const book  = await window.eupub.openPath(${JSON.stringify(textPath)});
    const model = await window.EupubModel.parseAsync(book);

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
    result.title === 'Sample Book' &&
    result.spineLen === 2 &&
    result.toc.join('|') === 'Chapter One|Chapter Two' &&
    /peeple/.test(result.after) &&
    /thoht/.test(result.after);

  console.log(ok ? 'PASS — text pipeline OK' : 'FAIL — text pipeline mismatch');
  app.exit(ok ? 0 : 1);
});
