// Eupub — Electron main process.
//
// Responsibilities are deliberately thin: own the window, and provide the
// renderer with (a) an opened EPUB extracted to a temp dir plus its OPF text,
// (b) the bundled euspell engine source to inject into chapter iframes, and
// (c) a couple of filesystem helpers. All EPUB parsing and rendering happens in
// the renderer, where DOMParser and a live DOM are available.
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { openEpub: extractEpub } = require('./epub-extract');
const { openText } = require('./text-open');

/** @type {BrowserWindow | null} */
let win = null;

// Temp dirs we extract books into, removed on quit so we don't litter %TEMP%.
/** @type {string[]} */
const tempDirs = [];

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 860,
    minWidth: 720,
    minHeight: 520,
    backgroundColor: '#1b1d23',
    title: 'Eupub',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // sandbox:false so the preload can use Node (path/url/fs via IPC) to
      // resolve book paths. contextIsolation keeps the preload's Node access off
      // the page's window; untrusted EPUB content runs only inside the sandboxed
      // srcdoc iframe (its own scripts are stripped), never in this top frame.
      sandbox: false,
    },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  sweepStaleTempDirs();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('quit', () => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

// --- IPC -------------------------------------------------------------------

// Show a file picker, then open the chosen book. Returns null if cancelled.
ipcMain.handle('epub:pick', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Open book',
    filters: [
      { name: 'Books', extensions: ['epub', 'txt'] },
      { name: 'EPUB books', extensions: ['epub'] },
      { name: 'Text files', extensions: ['txt'] },
    ],
    properties: ['openFile'],
  });
  if (res.canceled || !res.filePaths[0]) return null;
  return openBook(res.filePaths[0]);
});

// Open a book by absolute path (used to reopen the last book on launch).
ipcMain.handle('epub:openPath', (_e, filePath) => {
  if (!filePath || !fs.existsSync(filePath)) return null;
  return openBook(filePath);
});

// Source of the bundled euspell engine, injected into each chapter iframe.
ipcMain.handle('engine:source', () => {
  const p = path.join(__dirname, '..', 'dist', 'eupub-engine.js');
  if (!fs.existsSync(p)) {
    throw new Error('dist/eupub-engine.js is missing — run "npm run build:engine".');
  }
  return fs.readFileSync(p, 'utf8');
});

// Read a UTF-8 text file (chapter XHTML) from the extracted book. Restricted to
// the extraction dirs of currently open books, so a compromised renderer can't
// use this channel to read arbitrary files.
ipcMain.handle('fs:readText', (_e, p) => {
  const resolved = path.resolve(String(p));
  const inside = tempDirs.some((d) => resolved === d || resolved.startsWith(d + path.sep));
  if (!inside) throw new Error('fs:readText outside the opened book: ' + resolved);
  return fs.promises.readFile(resolved, 'utf8');
});

// Open a web/mail/tel link from a book in the system handler. Scheme-checked
// here (not just in the renderer) so nothing else can be launched.
ipcMain.handle('shell:openExternal', (_e, href) => {
  if (typeof href === 'string' && /^(https?:|mailto:|tel:)/i.test(href.trim())) {
    shell.openExternal(href.trim());
  }
});

// Open a book by extension — extract an EPUB, or synthesize an EPUB-shaped book
// from a .txt — and remember its temp dir so we can clean it up. Once the new
// book has extracted, the previous books' dirs are unreachable from the UI, so
// free them now instead of letting them pile up until quit.
function openBook(filePath) {
  const book = /\.txt$/i.test(filePath) ? openText(filePath) : extractEpub(filePath);
  while (tempDirs.length) {
    try {
      fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  tempDirs.push(book.rootDir);
  return book;
}

// Extraction dirs left behind by crashed sessions. Only sweep dirs old enough
// that no live Eupub instance is plausibly still reading from them.
function sweepStaleTempDirs() {
  const base = os.tmpdir();
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  let names;
  try {
    names = fs.readdirSync(base);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith('eupub-')) continue;
    const p = path.join(base, name);
    try {
      if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}
