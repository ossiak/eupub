// Preload — the renderer's only bridge to Node/Electron. Runs with Node access
// but exposes a small, explicit surface via contextBridge (contextIsolation on).
const { contextBridge, ipcRenderer } = require('electron');
const path = require('node:path');
const url = require('node:url');

// Buffer 'open-file' deliveries until the renderer attaches its handler.
// ipcRenderer.on has no buffering, and the renderer registers its callback only
// partway through an async init() — so a path sent by main's did-finish-load
// flush could otherwise arrive before anyone is listening and be silently
// dropped. Registering here, at preload time, closes that window for good
// (the Android bridge buffers the same way).
let openFileCb = null;
let anyOpenArrived = false; // see hasPendingOpen
const bufferedOpens = [];
ipcRenderer.on('open-file', (_e, filePath) => {
  anyOpenArrived = true;
  if (openFileCb) openFileCb(filePath);
  else bufferedOpens.push(filePath);
});

contextBridge.exposeInMainWorld('eupub', {
  // EPUB lifecycle.
  pickEpub: () => ipcRenderer.invoke('epub:pick'),
  openPath: (filePath) => ipcRenderer.invoke('epub:openPath', filePath),
  // Absolute path of the bundled first-launch sample, or null if unbuilt.
  samplePath: () => ipcRenderer.invoke('epub:samplePath'),

  // A book opened from outside the app (double-clicked in the file manager, or
  // passed on the command line). The callback receives the absolute path.
  // Deliveries that arrived before the callback was attached are flushed to it
  // immediately, in order.
  onOpenFile: (cb) => {
    openFileCb = cb;
    while (bufferedOpens.length) cb(bufferedOpens.shift());
  },

  // True when a book handed over by the OS (launch argv / open-file event /
  // second instance) is pending or was delivered to this document — init()
  // checks this to skip the "reopen the last book" fallback so the two opens
  // can't race. The load-bearing guarantee is main-side: its answer includes
  // "already flushed to this load", so IPC ordering doesn't matter (an invoke
  // response CAN overtake an earlier webContents.send — measured; see the
  // open:pending handler in main.js). `anyOpenArrived` is belt-and-braces.
  hasPendingOpen: () => ipcRenderer.invoke('open:pending').then((pending) => pending || anyOpenArrived),

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
