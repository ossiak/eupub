// Offscreen tests for the chapter viewer runtime (pagination, position locator,
// search marks, highlight). The runtime runs in the top page (so `parent` is the
// page itself and its postMessages reach our listener), driven over the same
// protocol reader.js uses. The euspell engine is intentionally omitted — these
// mechanics are orthogonal to conversion.
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

app.disableHardwareAcceleration();

setTimeout(() => { console.log('FAIL — timed out (30s)'); app.exit(3); }, 30000);

const runtimeSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'viewer-runtime.js'), 'utf8');

let paras = '';
for (let i = 0; i < 60; i++) {
  paras += `<p id="p${i}">Paragraph ${i}: the people thought they could read through the rough night, again and again, with many words to fill the page and force the columns to overflow. ${i === 12 ? 'Here be Zebras only once.' : ''}</p>\n`;
}
const chapterHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
<h1 id="top">A Long Test Chapter</h1>
${paras}
<p id="hltarget">Highlight me precisely.</p>
<p id="tail">The end of the chapter.</p>
</body></html>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    webPreferences: { offscreen: true, contextIsolation: false, nodeIntegration: false },
  });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(chapterHtml));

  const driver = `(async () => {
    const runtimeSrc = ${JSON.stringify(runtimeSrc)};
    const log = [];
    const inbox = [];
    window.addEventListener('message', (e) => { if (e.data && e.data.type) inbox.push(e.data); });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    async function waitFor(type, ms) {
      const deadline = Date.now() + (ms || 4000);
      while (Date.now() < deadline) {
        const m = inbox.find((x) => x.type === type);
        if (m) return m;
        await sleep(25);
      }
      return null;
    }
    const send = (m) => window.postMessage(m, '*');

    // The runtime now owns the column geometry; the page only needs html sized
    // and clipping (reader.js's readerStyle does this in the real app). We also
    // emulate COMMON EPUB chapter CSS that constrains body (max-width/margin/
    // padding) — the runtime must neutralize it or columns won't span the page.
    const style = document.createElement('style');
    style.textContent =
      'html{height:100%;margin:0;overflow:hidden}' +
      'body{max-width:30em;margin:0 auto;padding:1em;box-sizing:content-box}';
    document.head.appendChild(style);

    function elResolve(path) {
      let n = document.body;
      for (let i = 0; i < path.length && n; i++) {
        let c = n.firstElementChild, k = path[i];
        while (k > 0 && c) { c = c.nextElementSibling; k--; }
        n = c;
      }
      return n;
    }

    // Inject the runtime into this page (paginated). The file defines
    // window.EupubViewerRuntime; set config, then invoke it (reader.js injects
    // the same function via .toString()).
    const boot = document.createElement('script');
    boot.textContent = runtimeSrc + ';window.__eupubConfig=' + JSON.stringify({ mode: 'paginated' }) + ';window.EupubViewerRuntime();';
    document.body.appendChild(boot);

    const ready = await waitFor('eupub:ready', 8000);
    const pages = ready ? ready.pages : 0;
    log.push(['ready', !!ready, 'pages=' + pages]);

    // --- pagination: two pages forward (clear inbox each step so waitFor sees
    //     the fresh position, not a stale one) ---
    inbox.length = 0;
    send({ type: 'eupub:next' });
    await waitFor('eupub:position', 2000);
    inbox.length = 0;
    send({ type: 'eupub:next' });
    const afterNext = await waitFor('eupub:position', 2000);
    const pageAfterTwo = afterNext ? afterNext.page : -1;
    log.push(['paged-forward', pageAfterTwo === 2, 'page=' + pageAfterTwo, document.body.style.transform]);

    // --- locator round-trip ---
    inbox.length = 0;
    send({ type: 'eupub:requestLocator' });
    const locMsg = await waitFor('eupub:locator', 2000);
    const loc = locMsg && locMsg.locator;
    inbox.length = 0;
    send({ type: 'eupub:setPage', page: 0 });
    await waitFor('eupub:position', 2000);
    inbox.length = 0;
    send({ type: 'eupub:gotoLocator', locator: loc });
    const restored = await waitFor('eupub:position', 2000);
    const restoredPage = restored ? restored.page : -1;
    log.push([
      'locator-roundtrip',
      restoredPage === pageAfterTwo && pageAfterTwo > 0,
      'back=' + restoredPage,
      'path=' + JSON.stringify(loc && loc.path),
      'xf=' + document.body.style.transform,
    ]);

    // --- alignment sweep: every page's column must begin at x ≈ the body's left
    //     padding, proving the transform step matches the column pitch (no "split
    //     pages"). The runtime picks the padding responsively, so compare against
    //     the padding it actually applied rather than a fixed constant. ---
    let maxDev = 0;
    const lefts = [];
    const sweep = Math.min(pages, 6);
    const Wmeasured = document.documentElement.clientWidth;
    const bodyPad = parseFloat(getComputedStyle(document.body).paddingLeft);
    const colGap = getComputedStyle(document.body).columnGap;
    const colW = getComputedStyle(document.body).columnWidth;
    for (let p = 0; p < sweep; p++) {
      inbox.length = 0;
      send({ type: 'eupub:setPage', page: p });
      const pos = await waitFor('eupub:position', 2000);
      await sleep(280); // past the 0.18s page transition before measuring
      const el = pos && pos.locator && elResolve(pos.locator.path);
      if (el) {
        const left = el.getBoundingClientRect().left;
        lefts.push(p + ':' + Math.round(left));
        maxDev = Math.max(maxDev, Math.abs(left - bodyPad));
      }
    }
    log.push([
      'alignment',
      maxDev <= 3,
      'maxDev=' + maxDev.toFixed(1) + ' W=' + Wmeasured + ' pad=' + bodyPad + ' gap=' + colGap + ' colW=' + colW + ' lefts=[' + lefts.join(' ') + ']',
    ]);

    // --- search marks ---
    inbox.length = 0;
    send({ type: 'eupub:search', query: 'Zebras', occurrence: 0 });
    const sm = await waitFor('eupub:searchmarks', 2000);
    const marks = document.querySelectorAll('span.eupub-search').length;
    log.push(['search', !!sm && sm.count === 1 && marks === 1, 'count=' + (sm && sm.count)]);

    // --- highlight via selection ---
    inbox.length = 0;
    const target = document.getElementById('hltarget');
    const range = document.createRange();
    range.selectNodeContents(target);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    const selMsg = await waitFor('eupub:selection', 2000);
    let hlOk = false;
    if (selMsg && selMsg.anchor) {
      send({ type: 'eupub:addHighlight', id: 'hl1', anchor: selMsg.anchor });
      await sleep(150);
      const span = document.querySelector('span.eupub-hl[data-eupub-id="hl1"]');
      hlOk = !!span && /Highlight me precisely/.test(span.textContent);
    }
    log.push(['highlight', hlOk, selMsg ? 'sel="' + selMsg.text.trim() + '"' : 'no-selection']);

    // --- touch paging: swipe + tap-zones, and deferral to text selection ---
    // The highlight step left a selection active; clear it so touches page.
    window.getSelection().removeAllRanges();
    await sleep(50);

    function fireTouch(type, x, y) {
      const tt = new Touch({ identifier: 1, target: document.body, clientX: x, clientY: y });
      const ev = new TouchEvent(type, {
        touches: type === 'touchend' ? [] : [tt],
        changedTouches: [tt],
        bubbles: true,
        cancelable: true,
      });
      document.body.dispatchEvent(ev);
    }
    const swipe = (fromX, toX) => { fireTouch('touchstart', fromX, 300); fireTouch('touchend', toX, 300); };
    const tap = (x) => { fireTouch('touchstart', x, 300); fireTouch('touchend', x, 300); };
    const W = document.documentElement.clientWidth;

    // Start from page 0.
    inbox.length = 0; send({ type: 'eupub:setPage', page: 0 }); await waitFor('eupub:position', 2000);

    // Swipe left (finger moves right→left) pages forward.
    inbox.length = 0; swipe(W * 0.7, W * 0.7 - 120);
    const afterSwipeFwd = await waitFor('eupub:position', 2000);
    const swipeFwdPage = afterSwipeFwd ? afterSwipeFwd.page : -1;
    log.push(['touch-swipe-forward', swipeFwdPage === 1, 'page=' + swipeFwdPage]);

    // Swipe right pages back.
    inbox.length = 0; swipe(W * 0.3, W * 0.3 + 120);
    const afterSwipeBack = await waitFor('eupub:position', 2000);
    log.push(['touch-swipe-back', afterSwipeBack && afterSwipeBack.page === 0, 'page=' + (afterSwipeBack && afterSwipeBack.page)]);

    // Tap the right third pages forward.
    inbox.length = 0; tap(W * 0.9);
    const afterTapRight = await waitFor('eupub:position', 2000);
    log.push(['touch-tap-right', afterTapRight && afterTapRight.page === 1, 'page=' + (afterTapRight && afterTapRight.page)]);

    // Tap the left third pages back.
    inbox.length = 0; tap(W * 0.1);
    const afterTapLeft = await waitFor('eupub:position', 2000);
    log.push(['touch-tap-left', afterTapLeft && afterTapLeft.page === 0, 'page=' + (afterTapLeft && afterTapLeft.page)]);

    // Center tap toggles the reader chrome (no paging).
    inbox.length = 0; tap(W * 0.5);
    const chrome = await waitFor('eupub:toggleChrome', 1500);
    log.push(['touch-center-toggle', !!chrome, chrome ? 'posted' : 'no-message']);

    // A swipe while text is selected must NOT page (selection wins).
    inbox.length = 0; send({ type: 'eupub:setPage', page: 1 }); await waitFor('eupub:position', 2000);
    const selRange = document.createRange();
    selRange.selectNodeContents(document.getElementById('p2'));
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(selRange);
    await sleep(50);
    inbox.length = 0; swipe(W * 0.7, W * 0.7 - 120);
    await sleep(250);
    const pagedDuringSelection = inbox.some((m) => m.type === 'eupub:position');
    log.push(['touch-defers-to-selection', !pagedDuringSelection, pagedDuringSelection ? 'PAGED (bad)' : 'held']);
    window.getSelection().removeAllRanges();

    const passed = pages > 1 && log.every((r) => r[1] === true);
    return { passed, pages, log };
  })()`;

  const result = await win.webContents.executeJavaScript(driver);
  for (const [name, ok, ...info] of result.log) {
    console.log((ok ? 'PASS ' : 'FAIL ') + name.padEnd(18), info.join('  '));
  }
  console.log(result.passed ? 'ALL PASS' : 'SOME FAILED', '(pages=' + result.pages + ')');
  app.exit(result.passed ? 0 : 1);
});
