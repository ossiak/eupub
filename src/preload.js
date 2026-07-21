// Preload — the renderer's only bridge to Node/Electron. Runs with Node access
// but exposes a small, explicit surface via contextBridge (contextIsolation on).
const { contextBridge, ipcRenderer } = require('electron');
const path = require('node:path');
const url = require('node:url');

contextBridge.exposeInMainWorld('eupub', {
  // EPUB lifecycle.
  pickEpub: () => ipcRenderer.invoke('epub:pick'),
  openPath: (filePath) => ipcRenderer.invoke('epub:openPath', filePath),

  // A book opened from outside the app (double-clicked in the file manager, or
  // passed on the command line). The callback receives the absolute path.
  onOpenFile: (cb) => ipcRenderer.on('open-file', (_e, filePath) => cb(filePath)),

  // Engine + filesystem.
  engineSource: () => ipcRenderer.invoke('engine:source'),
  readText: (filePath) => ipcRenderer.invoke('fs:readText', filePath),

  // Per-chapter lexicon subset (array of [word, entry]) for the given words.
  lexiconSubset: (words) => ipcRenderer.invoke('lexicon:subset', words),

  // Open a book's web/mail/tel link in the system handler (allowlisted in main).
  openExternal: (href) => ipcRenderer.invoke('shell:openExternal', href),

  // Whether the OS uses "natural" scroll direction, so the renderer can keep the
  // page-turn swipe physical (swipe-left = next) regardless of the setting.
  getNaturalScroll: () => ipcRenderer.invoke('system:naturalScroll'),

  // Path helpers (sync, pure) so the renderer can resolve manifest hrefs and
  // build the file:// base URLs that chapter resources load against.
  join: (...parts) => path.join(...parts),
  dirname: (p) => path.dirname(p),
  basename: (p) => path.basename(p),
  fileURL: (p) => url.pathToFileURL(p).href,
});
