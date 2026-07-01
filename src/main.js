// Eupub — Electron main process.
//
// Responsibilities are deliberately thin: own the window, and provide the
// renderer with (a) an opened EPUB extracted to a temp dir plus its OPF text,
// (b) the bundled euspell engine source to inject into chapter iframes, and
// (c) a couple of filesystem helpers. All EPUB parsing and rendering happens in
// the renderer, where DOMParser and a live DOM are available.
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
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

// Read a UTF-8 text file (chapter XHTML) from the extracted book.
ipcMain.handle('fs:readText', (_e, p) => fs.readFileSync(p, 'utf8'));

// Open a book by extension — extract an EPUB, or synthesize an EPUB-shaped book
// from a .txt — and remember its temp dir so we can clean it up on quit.
function openBook(filePath) {
  const book = /\.txt$/i.test(filePath) ? openText(filePath) : extractEpub(filePath);
  tempDirs.push(book.rootDir);
  return book;
}
