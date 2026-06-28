// End-to-end test of reader.js wiring: load the real index.html with the real
// preload, auto-open a book (via localStorage last-book + reload), then confirm
// the chapter renders in euspell and that the bookmark and search features work.
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { openEpub } = require('../src/epub-extract');
const { makeEpub } = require('./make-epub');

app.disableHardwareAcceleration();
setTimeout(() => { console.log('FAIL — timed out (30s)'); app.exit(3); }, 30000);

ipcMain.handle('epub:pick', () => null);
ipcMain.handle('epub:openPath', (_e, p) => openEpub(p));
ipcMain.handle('fs:readText', (_e, p) => fs.readFileSync(p, 'utf8'));
ipcMain.handle('engine:source', () => fs.readFileSync(path.join(__dirname, '..', 'dist', 'eupub-engine.js'), 'utf8'));

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

  // Seed the last-book pointer, then reload so reader.js auto-opens it on init.
  await win.webContents.executeJavaScript(`localStorage.clear(); localStorage.setItem('eupub:last', ${JSON.stringify(epubPath)}); true`);
  await win.loadFile(indexHtml);

  const result = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const iframe = document.getElementById('chapter');

    // Wait until the chapter iframe has rendered euspelled text.
    let body = '';
    for (let i = 0; i < 120; i++) {
      try {
        const d = iframe.contentDocument;
        if (d && d.body) {
          const clone = d.body.cloneNode(true);
          clone.querySelectorAll('script,style').forEach((n) => n.remove());
          body = clone.textContent.replace(/\\s+/g, ' ').trim();
          if (/peeple/.test(body)) break;
        }
      } catch (e) {}
      await sleep(100);
    }
    const euspellOk = /peeple/.test(body);
    const statusRight = document.getElementById('status-right').textContent;

    // Link coloring: a real link should be blue; an href-less anchor (a link
    // target) must inherit the text color, not turn blue.
    const idoc = iframe.contentDocument;
    const plainA = idoc.getElementById('anchortarget');
    const linkA = idoc.querySelector('a[href]');
    const plainColor = plainA ? getComputedStyle(plainA).color : '(none)';
    const linkColor = linkA ? getComputedStyle(linkA).color : '(none)';

    // Bookmark: click ☆, expect a row + a stored entry.
    document.getElementById('bookmark-btn').click();
    await sleep(150);
    const bmRows = document.querySelectorAll('#panel-bookmarks .row').length;
    const bmStored = Object.keys(localStorage).some((k) => k.startsWith('eupub:bm:') && JSON.parse(localStorage.getItem(k)).length > 0);

    // Search: type a known word + Enter, expect results.
    const input = document.getElementById('search-input');
    input.value = 'through';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    let searchRows = 0;
    for (let i = 0; i < 40; i++) { searchRows = document.querySelectorAll('#search-results .row').length; if (searchRows) break; await sleep(100); }

    // Window-space center points for hover probing (iframe offset + element rect).
    function pt(sel) {
      const el = idoc.querySelector(sel);
      if (!el) return null;
      const ir = iframe.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return { x: Math.round(ir.left + r.left + r.width / 2), y: Math.round(ir.top + r.top + r.height / 2) };
    }

    return {
      euspellOk, statusRight, bmRows, bmStored, searchRows, plainColor, linkColor,
      anchorPt: pt('#anchortarget'), probePt: pt('.probe'),
      sample: body.slice(0, 80),
    };
  })()`);

  // Hover probing: move the mouse over the .probe (control) and the href-less
  // anchor, reading each one's color after it's hovered.
  const teal = 'rgb(0, 128, 128)';
  const colorOf = (sel) =>
    win.webContents.executeJavaScript(
      `getComputedStyle(document.getElementById('chapter').contentDocument.querySelector(${JSON.stringify(sel)})).color`
    );
  const hover = async (p) => {
    if (!p) return;
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 0, y: 0 });
    win.webContents.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y });
    await new Promise((r) => setTimeout(r, 250));
  };

  await hover(result.probePt);
  const probeHoverColor = await colorOf('.probe');
  await hover(result.anchorPt);
  const anchorHoverColor = await colorOf('#anchortarget');

  const checks = [
    ['euspell-render', result.euspellOk, result.sample],
    ['status-wired', !!result.statusRight, 'status="' + result.statusRight + '"'],
    ['bookmark-add', result.bmRows >= 1 && result.bmStored, 'rows=' + result.bmRows],
    ['search', result.searchRows >= 1, 'rows=' + result.searchRows],
    [
      'link-color',
      result.linkColor === 'rgb(31, 111, 235)' && result.plainColor !== 'rgb(31, 111, 235)',
      'link=' + result.linkColor + ' plain=' + result.plainColor,
    ],
    // The probe must turn teal on hover (proves hover works in the harness); the
    // href-less anchor must NOT (proves the fix neutralizes book a:hover).
    ['hover-control', probeHoverColor === teal, 'probe=' + probeHoverColor],
    ['hover-anchor-fix', anchorHoverColor !== teal, 'anchor=' + anchorHoverColor],
  ];
  for (const [name, ok, info] of checks) console.log((ok ? 'PASS ' : 'FAIL ') + name.padEnd(16), info);
  const passed = checks.every((c) => c[1]);
  console.log(passed ? 'ALL PASS' : 'SOME FAILED');
  app.exit(passed ? 0 : 1);
});
