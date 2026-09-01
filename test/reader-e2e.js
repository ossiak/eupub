// End-to-end test of reader.js wiring: load the real index.html with the real
// preload, auto-open a book (via localStorage last-book + reload), then confirm
// the chapter renders in euspell and that the bookmark and search features work.
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { openEpub } = require('../src/epub-extract');
const { makeEpub } = require('./make-epub');

app.disableHardwareAcceleration();
// Isolate userData so this test seeds its own last-book state instead of
// reading — or overwriting — the user's real reading state.
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'eupub-test-')));
setTimeout(() => { console.log('FAIL — timed out (30s)'); app.exit(3); }, 30000);

// Mirror main.js: the reader now uses the lexicon-excluded engine plus a
// per-chapter subset sliced from the full lexicon Map held in the main process.
const { pathToFileURL } = require('node:url');
let lexP = null;
const getLex = () => (lexP ||= import(pathToFileURL(path.join(__dirname, '..', 'dist', 'lexicon.mjs')).href).then((m) => m.data));

ipcMain.handle('epub:pick', () => null);
ipcMain.handle('epub:openPath', (_e, p) => openEpub(p));
ipcMain.handle('open:pending', () => false); // no OS-opened book in the harness
ipcMain.handle('fs:readText', (_e, p) => fs.readFileSync(p, 'utf8'));
ipcMain.handle('engine:source', () => fs.readFileSync(path.join(__dirname, '..', 'dist', 'eupub-engine.mobile.js'), 'utf8'));
ipcMain.handle('lexicon:subset', async (_e, words) => {
  const lex = await getLex();
  const out = [];
  for (const w of words || []) { const e = lex.get(String(w)); if (e) out.push([w, e]); }
  return out;
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

    // After a chapter loads, focus should be in the reader (chapter iframe), not
    // a sidebar element — so arrow keys page the text. Capture before any later
    // test step (bookmark/search clicks) moves focus.
    await sleep(150);
    const focusedId = document.activeElement ? document.activeElement.id : '';

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
    const runFind = (term) => {
      input.value = term;
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    };
    const countRows = async () => {
      let n = 0;
      for (let i = 0; i < 40; i++) { n = document.querySelectorAll('#search-results .row').length; if (n) break; await sleep(100); }
      return n;
    };
    runFind('through');
    const searchRows = await countRows();

    // Case sensitivity: "The" matches "The"/"the"/"they" when off, only exact
    // "The" when on. Wait a fixed beat after each (re-)search so the count
    // reflects the NEW query, not the previous results still on screen.
    const rows = () => document.querySelectorAll('#search-results .row').length;
    runFind('The');
    await sleep(700);
    const caseOffCount = rows();                       // insensitive (default)
    document.getElementById('search-case').click();    // toggle ON -> auto re-runs
    await sleep(700);
    const caseOnCount = rows();
    document.getElementById('search-case').click();    // restore default (off)
    await sleep(400);

    // The euspell spelling is searchable too: 'peeple' (reform of 'people')
    // matches via the reformed index, not just the original 'people'.
    runFind('peeple');
    await sleep(900);
    const euspellSearchRows = rows();

    // Window-space center points for hover probing (iframe offset + element rect).
    // Aim at the element's FIRST line fragment, not its bounding box: an inline
    // element that wraps reports the UNION of its fragments, and that union's
    // midpoint lands in the gap between them — on the parent <p>, so the hover
    // never reaches the element and the probe reads as un-hovered. (Same reason
    // viewer-runtime.js has firstRect(). This started biting when the reading-
    // measure cap narrowed the column from 611px to 476px, enough to wrap the
    // probe onto two lines.)
    function pt(sel) {
      const el = idoc.querySelector(sel);
      if (!el) return null;
      const ir = iframe.getBoundingClientRect();
      const rects = el.getClientRects();
      const r = rects.length ? rects[0] : el.getBoundingClientRect();
      return { x: Math.round(ir.left + r.left + r.width / 2), y: Math.round(ir.top + r.top + r.height / 2) };
    }

    // Sidebar should be open by default.
    const sidebarOpen = !document.getElementById('sidebar').classList.contains('hidden');

    // Whole-book progress % appears in the toolbar once char counts load (async).
    let progressText = '';
    for (let i = 0; i < 40; i++) {
      progressText = document.getElementById('progress').textContent;
      if (progressText) break;
      await sleep(100);
    }

    return {
      euspellOk, statusRight, bmRows, bmStored, searchRows, caseOffCount, caseOnCount, euspellSearchRows, plainColor, linkColor, sidebarOpen, focusedId, progressText,
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

  // Clicking a result highlights the term itself, by word index, so it works even
  // though the page shows reformed spelling: 'people' -> highlighted 'peeple'.
  // (Run after hover probing, since the result-click reloads the chapter.)
  const findText = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const input = document.getElementById('search-input');
    input.value = 'people';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await sleep(700);
    const row = document.querySelector('#search-results .row');
    if (!row) return '(no result)';
    row.click();
    const iframe = document.getElementById('chapter');
    for (let i = 0; i < 60; i++) {
      const sp = iframe.contentDocument && iframe.contentDocument.querySelector('span.eupub-find');
      if (sp) return sp.textContent.trim();
      await sleep(100);
    }
    return '(no highlight)';
  })()`);

  // Search box wiring: Ctrl+F opens/focuses the search from the page; a second
  // Enter (unchanged query) and F3 walk the hits with an "n / m" counter, and
  // the 🔍 toolbar button opens the search too. (Runs after hover probing since
  // cycling navigates chapters.)
  const searchNav = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const input = document.getElementById('search-input');
    const status = () => document.getElementById('status-left').textContent;
    const enter = (shift) => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: !!shift, bubbles: true }));

    // Ctrl+F from the page opens the Search tab and focuses the input.
    document.getElementById('chapter').focus();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }));
    await sleep(60);
    const ctrlFOpens = document.querySelector('.tab[data-tab="search"]').classList.contains('active')
      && document.activeElement === input;

    // First Enter runs the search (list appears, no navigation yet).
    input.value = 'the';
    enter(false);
    let rows = 0;
    for (let i = 0; i < 40; i++) { rows = document.querySelectorAll('#search-results .row').length; if (rows >= 2) break; await sleep(100); }

    // Second Enter walks to hit 1, third to hit 2, Shift+Enter back to hit 1.
    enter(false);
    await sleep(200);
    const counter1 = status();
    const firstCurrent = [...document.querySelectorAll('#search-results .row')].findIndex((r) => r.classList.contains('current'));
    enter(false);
    await sleep(200);
    const counter2 = status();
    enter(true);
    await sleep(200);
    const counter3 = status();

    // F3 also advances from anywhere (dispatch on window, not the input).
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F3', bubbles: true }));
    await sleep(200);
    const counterF3 = status();

    // The 🔍 toolbar button opens the search after the sidebar is hidden.
    document.getElementById('sidebar-btn').click();
    await sleep(30);
    const hidden = document.getElementById('sidebar').classList.contains('hidden');
    document.getElementById('search-btn').click();
    await sleep(30);
    const btnOpens = !document.getElementById('sidebar').classList.contains('hidden')
      && document.querySelector('.tab[data-tab="search"]').classList.contains('active');

    return { ctrlFOpens, rows, counter1, firstCurrent, counter2, counter3, counterF3, hidden, btnOpens };
  })()`);

  // Recent-files menu: loading the book should have recorded it under
  // 'eupub:recent'; clicking Open opens a menu whose first item is the picker
  // and which lists the recent book; an outside click closes it.
  const recentMenu = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const stored = JSON.parse(localStorage.getItem('eupub:recent') || '[]');
    document.getElementById('open-btn').click();   // open the menu
    await sleep(50);
    const menu = document.getElementById('open-menu');
    const opened = !menu.classList.contains('hidden');
    const first = menu.querySelector('.menu-item') ? menu.querySelector('.menu-item').textContent : '';
    const labels = [...menu.querySelectorAll('.menu-item.recent .menu-item-label')].map((n) => n.textContent);
    document.body.click();                          // outside click closes it
    await sleep(20);
    const closed = menu.classList.contains('hidden');
    return { storedLen: stored.length, opened, first, recentCount: labels.length, firstLabel: labels[0] || '', closed };
  })()`);

  // The TOC comes from the EPUB nav rather than a chapter, so it does not pass
  // through the chapter pipeline and needs reforming of its own. Check both
  // states: reformed while euspell is on, back to the original when toggled off.
  const toc = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('.tab[data-tab="toc"]').click();
    const read = () => [...document.getElementById('panel-toc').children].map((a) => a.textContent);
    for (let i = 0; i < 40; i++) {           // wait for the async subset load
      if (read().some((t) => /Qhapter/.test(t))) break;
      await sleep(100);
    }
    const on = read();
    const box = document.getElementById('euspell-checkbox');
    box.checked = false; box.dispatchEvent(new Event('change', { bubbles: true }));
    for (let i = 0; i < 20; i++) { if (read().some((t) => /Chapter/.test(t))) break; await sleep(50); }
    const off = read();
    box.checked = true; box.dispatchEvent(new Event('change', { bubbles: true }));
    for (let i = 0; i < 20; i++) { if (read().some((t) => /Qhapter/.test(t))) break; await sleep(50); }
    return { on, off, back: read() };
  })()`);

  // Wheel over Contents must do NOTHING to the book: it is not prevented (so the
  // panel keeps whatever native scrolling it has — none, when the list fits) and
  // the chapter does not move. The reader owns no wheel handler at all now.
  const tocWheel = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // An earlier step switched to Marks; Contents is the tab under test.
    document.querySelector('.tab[data-tab="toc"]').click();
    await sleep(50);
    const before = document.getElementById('status-right').textContent;
    const panel = document.getElementById('panel-toc');
    const evt = new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true });
    panel.dispatchEvent(evt);
    await sleep(400);
    return {
      prevented: evt.defaultPrevented,
      moved: document.getElementById('status-right').textContent !== before,
      // A list that fits its window must not be scrollable at all.
      scrolled: panel.scrollTop !== 0,
    };
  })()`);

  // Wheel over the book pages it, on a plain vertical (mouse-wheel) delta with
  // no deltaX. This must be checked on a MULTI-page chapter: the old code let a
  // vertical delta through on single-page sections, so a one-page chapter — what
  // the sample book has by default — passes either way and proves nothing. The
  // test chapter is one sentence, so no font size splits it in a 900px window:
  // the window is shrunk instead, which reflows it across several columns.
  // Run last: it ends by advancing the chapter.
  win.setContentSize(300, 220);
  await new Promise((r) => setTimeout(r, 600));

  const wheel = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const status = () => document.getElementById('status-right').textContent;
    const pages = () => (status().match(/p \\d+\\/(\\d+)/) || [0, 0])[1] | 0;
    const page = () => (status().match(/p (\\d+)\\//) || [0, 0])[1] | 0;
    const wheelIt = () => document.getElementById('chapter').contentDocument
      .dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }));

    for (let i = 0; i < 8 && pages() < 2; i++) {
      document.getElementById('font-up').click();
      await sleep(250);
    }
    const multi = pages() >= 2;

    // Within a multi-page chapter: p 1/N -> p 2/N.
    wheelIt();
    let turned = false;
    for (let i = 0; i < 30; i++) {
      if (page() > 1) { turned = true; break; }
      await sleep(100);
    }

    // And off the end of the chapter, to the next one.
    let advanced = false;
    for (let i = 0; i < 30 && !advanced; i++) {
      wheelIt();
      for (let j = 0; j < 8; j++) {
        if (/Ch 2\\//.test(status())) { advanced = true; break; }
        await sleep(60);
      }
    }
    return { multi, turned, advanced };
  })()`);

  const checks = [
    ['euspell-render', result.euspellOk, result.sample],
    ['status-wired', !!result.statusRight, 'status="' + result.statusRight + '"'],
    ['bookmark-add', result.bmRows >= 1 && result.bmStored, 'rows=' + result.bmRows],
    ['search', result.searchRows >= 1, 'rows=' + result.searchRows],
    [
      'search-case-sensitive',
      result.caseOnCount >= 1 && result.caseOffCount > result.caseOnCount,
      'off=' + result.caseOffCount + ' on=' + result.caseOnCount,
    ],
    ['search-euspell-form', result.euspellSearchRows >= 1, 'peeple rows=' + result.euspellSearchRows],
    // The highlighted hit is the reformed word (people -> peeple), proving the
    // term itself stays highlighted rather than the whole paragraph flashing.
    ['search-highlights-term', findText === 'peeple', 'find="' + findText + '"'],
    [
      'link-color',
      result.linkColor === 'rgb(31, 111, 235)' && result.plainColor !== 'rgb(31, 111, 235)',
      'link=' + result.linkColor + ' plain=' + result.plainColor,
    ],
    // The probe must turn teal on hover (proves hover works in the harness); the
    // href-less anchor must NOT (proves the fix neutralizes book a:hover).
    ['hover-control', probeHoverColor === teal, 'probe=' + probeHoverColor],
    ['hover-anchor-fix', anchorHoverColor !== teal, 'anchor=' + anchorHoverColor],
    ['sidebar-default-open', result.sidebarOpen, 'open=' + result.sidebarOpen],
    ['reader-focused-after-load', result.focusedId === 'chapter', 'activeElement=#' + result.focusedId],
    [
      'progress-percent',
      /^\d+%$/.test(result.progressText) && parseInt(result.progressText, 10) >= 0 && parseInt(result.progressText, 10) <= 100,
      'progress="' + result.progressText + '"',
    ],
    [
      'toc-reformed',
      toc.on.join('|') === 'Qhapter Wun|Qhapter Twu',
      'labels="' + toc.on.join(' | ') + '"',
    ],
    [
      'toc-respects-toggle',
      toc.off.join('|') === 'Chapter One|Chapter Two' && toc.back.join('|') === 'Qhapter Wun|Qhapter Twu',
      'off="' + toc.off.join(' | ') + '" back="' + toc.back.join(' | ') + '"',
    ],
    [
      'toc-wheel-inert',
      !tocWheel.prevented && !tocWheel.moved && !tocWheel.scrolled,
      'prevented=' + tocWheel.prevented + ' moved=' + tocWheel.moved + ' scrolled=' + tocWheel.scrolled,
    ],
    [
      'book-wheel-paginates',
      wheel.multi && wheel.turned && wheel.advanced,
      'multiPage=' + wheel.multi + ' turnedWithin=' + wheel.turned + ' advancedChapter=' + wheel.advanced,
    ],
    ['recent-stored', recentMenu.storedLen >= 1, 'recent=' + recentMenu.storedLen],
    [
      'recent-menu-opens',
      recentMenu.opened && recentMenu.first === 'Open a book…' && recentMenu.recentCount >= 1,
      'opened=' + recentMenu.opened + ' first="' + recentMenu.first + '" recents=' + recentMenu.recentCount + ' label="' + recentMenu.firstLabel + '"',
    ],
    ['recent-menu-closes', recentMenu.closed, 'closed=' + recentMenu.closed],
    ['search-ctrlf-opens', searchNav.ctrlFOpens, 'rows=' + searchNav.rows],
    [
      'search-cycle',
      /^1 \/ /.test(searchNav.counter1) && searchNav.firstCurrent === 0
        && /^2 \/ /.test(searchNav.counter2) && /^1 \/ /.test(searchNav.counter3)
        && /^2 \/ /.test(searchNav.counterF3),
      'c1="' + searchNav.counter1 + '" cur=' + searchNav.firstCurrent + ' c2="' + searchNav.counter2 + '" back="' + searchNav.counter3 + '" f3="' + searchNav.counterF3 + '"',
    ],
    ['search-button-opens', searchNav.hidden && searchNav.btnOpens, 'hidden=' + searchNav.hidden + ' opens=' + searchNav.btnOpens],
  ];
  for (const [name, ok, info] of checks) console.log((ok ? 'PASS ' : 'FAIL ') + name.padEnd(16), info);
  const passed = checks.every((c) => c[1]);
  console.log(passed ? 'ALL PASS' : 'SOME FAILED');
  app.exit(passed ? 0 : 1);
});
