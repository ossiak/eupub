// Eupub reader UI. Opens a book, renders each spine document into an iframe with
// the euspell engine + viewer runtime injected, and owns the surrounding chrome:
// paged view, reading-position persistence, bookmarks, highlights, and
// book-wide search. The in-iframe half lives in viewer-runtime.js; the two halves
// talk over postMessage.
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const els = {
    open: $('open-btn'),
    open2: $('open-btn-2'),
    openWrap: $('open-wrap'),
    openMenu: $('open-menu'),
    sidebar: $('sidebar'),
    sidebarBtn: $('sidebar-btn'),
    prev: $('prev-btn'),
    next: $('next-btn'),
    bookmark: $('bookmark-btn'),
    fontDown: $('font-down'),
    fontUp: $('font-up'),
    theme: $('theme-btn'),
    euspell: $('euspell-checkbox'),
    bookTitle: $('book-title'),
    iframe: $('chapter'),
    welcome: $('welcome'),
    statusLeft: $('status-left'),
    statusRight: $('status-right'),
    progress: $('progress'),
    panelToc: $('panel-toc'),
    panelBookmarks: $('panel-bookmarks'),
    panelHighlights: $('panel-highlights'),
    searchInput: $('search-input'),
    searchCase: $('search-case'),
    searchResults: $('search-results'),
    popup: $('selection-popup'),
    hlAdd: $('hl-add'),
  };

  // Block-level selector: matches viewer-runtime's BLOCK, used to find the leaf
  // text blocks that search results anchor to.
  const BLOCK_SEL = 'p,div,section,article,blockquote,li,dd,dt,h1,h2,h3,h4,h5,h6,figure,figcaption,td,th,pre,img,table';
  // Leaf-detection selector: BLOCK_SEL without img. An <img> is atomic (no text
  // to index separately), so a text block that merely contains an inline image
  // (e.g. "<p>text <img></p>") must still count as a leaf — otherwise its text
  // is dropped from the search index. Container blocks (incl. table) still
  // disqualify a leaf, since their text lives in nested leaves (td/th, …).
  const LEAF_BLOCK_SEL = BLOCK_SEL.split(',').filter((t) => t !== 'img').join(',');

  const PREFS_KEY = 'eupub:prefs';
  const LAST_KEY = 'eupub:last'; // legacy single-slot; read once to seed recents
  const RECENT_KEY = 'eupub:recent';
  const RECENT_MAX = 10;
  const posKey = (s) => `eupub:pos:${s}`;
  const bmKey = (s) => `eupub:bm:${s}`;
  const hlKey = (s) => `eupub:hl:${s}`;

  const prefs = loadPrefs();

  const state = {
    book: null,
    model: null,
    index: -1,
    page: 0,
    pages: 1,
    engineSource: '',
    runtimeSource: '',
    currentLocator: null,
    bookmarks: [],
    highlights: [],
    selection: null,
    search: { query: '', results: [] },
    find: null, // clicked search hit currently highlighted { index, path, wordStart, wordEnd }
    // Per-chapter search index: absPath -> [{ path, origText, refText }]. Built
    // lazily on first search and cached for the book session.
    searchIndex: new Map(),
    // Per-chapter text lengths for the whole-book progress %. Filled async on
    // load (character-based, so it's independent of font size / window width).
    charCounts: null,
    cumChars: null,
    totalChars: 0,
  };

  // --- startup --------------------------------------------------------

  init();

  async function init() {
    try {
      state.engineSource = await window.eupub.engineSource();
    } catch (err) {
      console.error(err);
      prefs.euspell = false;
      setStatus('left', 'Engine not built — run "npm run build:engine".');
    }
    // The viewer runtime is defined (not run) in this window; ship its source.
    state.runtimeSource = window.EupubViewerRuntime.toString();

    els.euspell.checked = prefs.euspell;
    // Only offer the toggle if the engine actually loaded; otherwise it would
    // silently do nothing (buildSrcdoc skips conversion with no engine source).
    els.euspell.disabled = !state.engineSource;
    els.euspell.title = state.engineSource
      ? 'Show text in euspell reformed spelling'
      : 'euspell engine not built — run "npm run build:engine"';
    reflectCaseButton();

    wireEvents();

    // Reopen the most recent book on launch. Fall back to the legacy single-slot
    // key so existing users keep their last book before any recent is recorded.
    const recents = loadRecents();
    const last = (recents[0] && recents[0].path) || localStorage.getItem(LAST_KEY);
    if (last) {
      const book = await window.eupub.openPath(last);
      if (book) await loadBook(book);
      else pruneRecent(last); // file moved/deleted since last session
    }
  }

  function wireEvents() {
    // Toolbar Open is a menu: pick a file or reopen a recent one. The welcome
    // screen's Open is the bare picker (its own primary call to action).
    els.open.addEventListener('click', (e) => {
      e.stopPropagation(); // don't let the document handler immediately reclose
      toggleOpenMenu();
    });
    els.open2.addEventListener('click', openBook);
    els.openMenu.addEventListener('click', (e) => e.stopPropagation());
    document.addEventListener('click', (e) => {
      if (!els.openWrap.contains(e.target)) closeOpenMenu();
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeOpenMenu();
    });
    els.sidebarBtn.addEventListener('click', () => els.sidebar.classList.toggle('hidden'));
    els.prev.addEventListener('click', navPrev);
    els.next.addEventListener('click', navNext);
    els.bookmark.addEventListener('click', addBookmark);
    els.fontUp.addEventListener('click', () => changeFont(1));
    els.fontDown.addEventListener('click', () => changeFont(-1));
    els.theme.addEventListener('click', toggleTheme);
    els.euspell.addEventListener('change', () => {
      prefs.euspell = els.euspell.checked;
      savePrefs();
      reRenderKeepingPlace();
    });

    // Over the Contents sidebar the wheel paginates the book rather than
    // scrolling the TOC — the TOC is navigated by clicking. Registered on the
    // window in the CAPTURE phase (passive:false) so it intercepts the wheel
    // before any scroll can start, for the whole sidebar area. Wheel over the
    // book stays in the iframe; wheel over the other (scrollable) tabs is left
    // alone. (See onSidebarWheel.)
    window.addEventListener('wheel', onSidebarWheel, { capture: true, passive: false });

    for (const tab of document.querySelectorAll('.tab')) {
      tab.addEventListener('click', () => switchTab(tab.dataset.tab));
    }
    els.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') runSearch(els.searchInput.value.trim());
    });
    els.searchCase.addEventListener('click', () => {
      prefs.searchCaseSensitive = !prefs.searchCaseSensitive;
      savePrefs();
      reflectCaseButton();
      if (state.search.query) runSearch(els.searchInput.value.trim()); // re-run with new setting
    });
    els.hlAdd.addEventListener('click', addHighlightFromSelection);

    window.addEventListener('message', onChapterMessage);
    window.addEventListener('keydown', (e) => {
      if (document.activeElement === els.searchInput) return;
      handleNavKey(e.key);
    });
  }

  // --- opening / loading ----------------------------------------------

  async function openBook() {
    const book = await window.eupub.pickEpub();
    if (book) await loadBook(book); // loadBook records it in the recent list
  }

  // Open a book chosen from the recent list. If it can no longer be opened
  // (moved or deleted), drop it from the list and say so.
  async function openRecent(filePath) {
    const book = await window.eupub.openPath(filePath);
    if (!book) {
      pruneRecent(filePath);
      setStatus('left', 'That book could not be opened — removed from recent.');
      return;
    }
    await loadBook(book);
  }

  async function loadBook(book) {
    state.book = book;
    state.model = await window.EupubModel.parseAsync(book);
    for (const s of state.model.spine) s.fileURL = window.eupub.fileURL(s.absPath);

    state.bookmarks = loadJSON(bmKey(book.sourcePath), []);
    state.highlights = loadJSON(hlKey(book.sourcePath), []);
    state.search = { query: '', results: [] };
    state.charCounts = null;
    state.cumChars = null;
    state.totalChars = 0;
    state.searchIndex = new Map();
    els.searchInput.value = '';
    els.progress.textContent = '';

    els.bookTitle.textContent = state.model.title;
    document.title = `${state.model.title} — Eupub`;
    pushRecent(book.sourcePath, state.model.title);
    renderToc();
    renderBookmarks();
    renderHighlights();
    renderSearchResults([], '');
    enableControls(true);

    const saved = loadJSON(posKey(book.sourcePath), null);
    state.currentLocator = saved && saved.locator ? saved.locator : null;
    const start = saved && Number.isInteger(saved.index) && saved.index < state.model.spine.length ? saved.index : 0;
    go(start, { restore: state.currentLocator });

    computeCharCounts(book); // async; fills the progress %
  }

  // Reads every spine document once and records its visible-text length, so
  // whole-book progress can be weighted by content. Character-based, so it never
  // needs recomputing on font/window changes. Aborts if the book changes.
  async function computeCharCounts(book) {
    const spine = state.model.spine;
    const counts = new Array(spine.length).fill(0);
    for (let i = 0; i < spine.length; i++) {
      if (state.book !== book) return;
      try {
        const html = await window.eupub.readText(spine[i].absPath);
        const doc = new DOMParser().parseFromString(html, 'text/html');
        for (const s of doc.querySelectorAll('script,style')) s.remove();
        counts[i] = ((doc.body && doc.body.textContent) || '').replace(/\s+/g, ' ').trim().length;
      } catch {
        counts[i] = 0;
      }
    }
    if (state.book !== book) return;
    const cum = new Array(spine.length).fill(0);
    let total = 0;
    for (let i = 0; i < spine.length; i++) {
      cum[i] = total;
      total += counts[i];
    }
    state.charCounts = counts;
    state.cumChars = cum;
    state.totalChars = Math.max(1, total);
    updateProgress();
  }

  // --- chapter rendering ----------------------------------------------

  function go(index, opts) {
    if (!state.model) return;
    opts = opts || {};
    state.find = opts.find || null; // a fresh navigation clears any prior find hit
    index = Math.max(0, Math.min(index, state.model.spine.length - 1));
    state.index = index;
    renderChapter(index, opts);
    updateNavState();
    highlightToc();
  }

  // Re-render the current chapter while keeping the reader's place (used after a
  // font/theme/euspell/view change).
  function reRenderKeepingPlace() {
    if (state.index < 0) return;
    renderChapter(state.index, { restore: state.currentLocator });
  }

  async function renderChapter(index, opts) {
    const item = state.model.spine[index];
    const html = await window.eupub.readText(item.absPath);
    const baseHref = withTrailingSlash(window.eupub.fileURL(window.eupub.dirname(item.absPath)));

    const cfg = {
      mode: 'paginated',
      fragment: opts.fragment || '',
      restore: opts.restore || null,
      startAtEnd: !!opts.startAtEnd,
      flash: opts.flash || null,
      highlights: state.highlights
        .filter((h) => h.index === index)
        .map((h) => ({ id: h.id, anchor: h.anchor })),
      // Persistently highlight a clicked search hit, by word index so it works
      // whether or not the on-screen text is reformed. Survives page turns; kept
      // across re-renders (font/theme) while it belongs to the current chapter.
      find:
        state.find && state.find.index === index
          ? { path: state.find.path, wordStart: state.find.wordStart, wordEnd: state.find.wordEnd }
          : null,
    };

    els.iframe.srcdoc = buildSrcdoc(html, baseHref, cfg);
    els.welcome.classList.add('hidden');
    els.iframe.classList.remove('hidden');
    hideSelectionPopup();
  }

  function buildSrcdoc(html, baseHref, cfg) {
    const doc = new DOMParser().parseFromString(html, 'text/html');

    for (const m of doc.querySelectorAll('meta[http-equiv]')) {
      if (/content-security-policy/i.test(m.getAttribute('http-equiv') || '')) m.remove();
    }
    for (const s of doc.querySelectorAll('script')) s.remove();

    let head = doc.head;
    if (!head) {
      head = doc.createElement('head');
      doc.documentElement.insertBefore(head, doc.body);
    }

    const base = doc.createElement('base');
    base.setAttribute('href', baseHref);
    head.insertBefore(base, head.firstChild);

    const style = doc.createElement('style');
    style.textContent = readerStyle();
    head.appendChild(style);

    // euspell engine first (converts the text), then the viewer runtime, which
    // lays out / paginates the converted DOM and restores position & marks.
    if (prefs.euspell && state.engineSource) {
      const engine = doc.createElement('script');
      engine.textContent = state.engineSource;
      doc.body.appendChild(engine);
    }
    const boot = doc.createElement('script');
    boot.textContent = `window.__eupubConfig=${JSON.stringify(cfg)};(${state.runtimeSource})();`;
    doc.body.appendChild(boot);

    return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
  }

  function readerStyle() {
    const dark = prefs.theme === 'dark';
    const bg = dark ? '#1b1d23' : '#fbf9f3';
    const fg = dark ? '#d9dce3' : '#1a1a1a';
    const link = dark ? '#7fb0e0' : '#1f6feb';
    const fs = prefs.fontSize;

    // Paged layout only. Geometry (width/height/padding/columns) is set in px by
    // the viewer runtime so the page transform and column pitch match exactly;
    // here we set only cosmetics. html clips; body is transformed horizontally.
    return `
      html { font-size:${fs}px; height:100%; margin:0; overflow:hidden; }
      body {
        line-height:1.6; background:${bg}; color:${fg};
        font-family:Georgia,"Times New Roman",serif; will-change:transform;
      }
      img,svg { max-width:100%; max-height:84vh; height:auto; }
      table { max-width:100%; }
      a[href] { color:${link}; }
      /* Href-less <a> are link TARGETS that EPUBs scatter through the prose; force
         them to behave as plain text in every state so the book's own a:hover /
         a:link rules can't recolor paragraphs on hover. */
      a:not([href]),
      a:not([href]):hover,
      a:not([href]):active,
      a:not([href]):focus {
        color:inherit !important; text-decoration:none !important;
        background:transparent !important; cursor:inherit !important;
      }
      ::selection { background:rgba(91,155,213,0.35); }
      .eupub-hl { background:rgba(255,214,82,0.45); border-radius:2px; }
      .eupub-search { background:rgba(91,155,213,0.35); border-radius:2px; }
      .eupub-search.eupub-search-current { background:rgba(255,170,60,0.7); }
      .eupub-find { background:rgba(255,165,0,0.55); border-radius:2px; box-shadow:0 0 0 1px rgba(255,140,0,0.45); }
      .eupub-flash { animation:eupubflash 1.6s ease; }
      @keyframes eupubflash { 0%,100%{ background:transparent } 12%,55%{ background:rgba(255,214,82,0.5) } }`;
  }

  // --- messages from the chapter --------------------------------------

  function onChapterMessage(e) {
    const m = e.data || {};
    switch (m.type) {
      case 'eupub:ready':
      case 'eupub:position':
        state.page = m.page || 0;
        state.pages = m.pages || 1;
        if (m.locator) state.currentLocator = m.locator;
        updateNavState();
        savePosition();
        // After a chapter loads (e.g. via a TOC/bookmark/search click, which
        // leaves focus on a sidebar element), hand keyboard focus to the reader
        // so arrow keys page the text instead of moving/scrolling the TOC.
        if (m.type === 'eupub:ready') focusReader();
        break;
      case 'eupub:navigate': {
        const target = String(m.href).split('#')[0];
        const frag = String(m.href).split('#')[1] || '';
        const idx = state.model.spine.findIndex((s) => s.fileURL === target);
        if (idx !== -1) go(idx, { fragment: frag });
        break;
      }
      case 'eupub:key':
        handleEdgeTurn(m.key);
        break;
      case 'eupub:selection':
        state.selection = m;
        showSelectionPopup(m.rect);
        break;
      case 'eupub:selection-clear':
        hideSelectionPopup();
        break;
      case 'eupub:searchmarks':
        // (reserved: per-chapter match count; flash already conveys location)
        break;
    }
  }

  function sendToChapter(msg) {
    if (els.iframe.contentWindow) els.iframe.contentWindow.postMessage(msg, '*');
  }

  // Move keyboard focus into the chapter so arrow-key paging is handled by the
  // viewer runtime (and not by a focused sidebar element).
  function focusReader() {
    try {
      els.iframe.focus();
      if (els.iframe.contentWindow) els.iframe.contentWindow.focus();
    } catch (e) {
      /* iframe not ready */
    }
  }

  // --- navigation -----------------------------------------------------

  function navNext() {
    if (state.index >= 0) sendToChapter({ type: 'eupub:next' });
  }
  function navPrev() {
    if (state.index >= 0) sendToChapter({ type: 'eupub:prev' });
  }
  // The runtime posts a key back when it can't page further: turn the chapter.
  function handleEdgeTurn(key) {
    if (key === 'ArrowRight' && state.index < state.model.spine.length - 1) go(state.index + 1, {});
    else if (key === 'ArrowLeft' && state.index > 0) go(state.index - 1, { startAtEnd: true });
  }
  function handleNavKey(key) {
    if (state.index < 0) return;
    if (key === 'ArrowRight') navNext();
    else if (key === 'ArrowLeft') navPrev();
  }

  // Wheel over the Contents sidebar: never scroll the TOC (click-only), instead
  // page the book — matching the in-iframe wheel feel (threshold + 250ms lock).
  // Only acts while the Contents tab is active, so the scrollable Marks/Notes/
  // Search panels keep their normal wheel scrolling.
  let tocWheelLock = 0;
  function onSidebarWheel(e) {
    if (state.index < 0) return;
    if (!els.sidebar.contains(e.target)) return;
    if (!els.panelToc.classList.contains('active')) return;
    e.preventDefault();
    const now = Date.now();
    if (now < tocWheelLock) return;
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (Math.abs(d) < 8) return;
    tocWheelLock = now + 250;
    if (d > 0) navNext();
    else navPrev();
  }

  function updateNavState() {
    els.prev.disabled = state.index <= 0 && state.page <= 0;
    els.next.disabled = state.index >= state.model.spine.length - 1 && state.page >= state.pages - 1;
    const chapter = `Ch ${state.index + 1}/${state.model.spine.length}`;
    setStatus('right', `${chapter} · p ${state.page + 1}/${state.pages}`);
    updateProgress();
  }

  // Whole-book reading progress as a percentage, weighted by chapter text length.
  // Within a chapter, progress runs 0 (first page) → 1 (last page); a single-page
  // chapter counts as done only when it's the last one, so the book ends at 100%.
  function bookProgress() {
    if (!state.charCounts || state.index < 0 || !state.totalChars) return null;
    const i = state.index;
    const last = state.model.spine.length - 1;
    let frac = state.pages > 1 ? state.page / (state.pages - 1) : i === last ? 1 : 0;
    frac = Math.min(1, Math.max(0, frac));
    const chars = state.cumChars[i] + frac * state.charCounts[i];
    return Math.min(100, Math.max(0, Math.round((chars / state.totalChars) * 100)));
  }
  function updateProgress() {
    const p = bookProgress();
    els.progress.textContent = p == null ? '' : `${p}%`;
  }

  // --- sidebar panels -------------------------------------------------

  function switchTab(name) {
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.tab === name);
    for (const p of document.querySelectorAll('.panel')) p.classList.toggle('active', p.id === `panel-${name}`);
    els.sidebar.classList.remove('hidden');
    if (name === 'search') els.searchInput.focus();
  }

  function renderToc() {
    els.panelToc.innerHTML = '';
    for (const entry of state.model.toc) {
      const a = document.createElement('a');
      a.textContent = entry.label;
      a.className = `depth-${entry.depth}`;
      a.dataset.index = entry.spineIndex ?? '';
      a.addEventListener('click', (e) => {
        e.preventDefault();
        if (entry.spineIndex != null) go(entry.spineIndex, { fragment: entry.fragment });
      });
      els.panelToc.appendChild(a);
    }
  }

  function highlightToc() {
    for (const a of els.panelToc.children) {
      // dataset.index is '' for non-navigable entries (no spineIndex); guard so
      // Number('') === 0 doesn't mark them active while on the first chapter.
      const active = a.dataset.index !== '' && Number(a.dataset.index) === state.index;
      a.classList.toggle('active', active);
    }
  }

  // --- bookmarks ------------------------------------------------------

  function addBookmark() {
    if (!state.model) return;
    state.bookmarks.push({
      id: uid(),
      index: state.index,
      locator: state.currentLocator,
      label: chapterLabel(state.index),
      created: Date.now(),
    });
    saveBookmarks();
    renderBookmarks();
    switchTab('bookmarks');
  }

  function renderBookmarks() {
    const list = state.bookmarks;
    if (!list.length) {
      els.panelBookmarks.innerHTML = '<div class="empty">No bookmarks yet. Use ☆ to mark your spot.</div>';
      return;
    }
    els.panelBookmarks.innerHTML = '';
    list
      .slice()
      .reverse()
      .forEach((bm) => {
        const row = makeRow(bm.label, '', () =>
          go(bm.index, { restore: bm.locator, flash: bm.locator ? bm.locator.path : null })
        );
        addDelete(row, () => {
          state.bookmarks = state.bookmarks.filter((b) => b.id !== bm.id);
          saveBookmarks();
          renderBookmarks();
        });
        els.panelBookmarks.appendChild(row);
      });
  }

  // --- highlights -----------------------------------------------------

  function addHighlightFromSelection() {
    const sel = state.selection;
    if (!sel || !sel.anchor) return;
    const hl = { id: uid(), index: state.index, anchor: sel.anchor, text: sel.text.slice(0, 200), created: Date.now() };
    state.highlights.push(hl);
    saveHighlights();
    sendToChapter({ type: 'eupub:addHighlight', id: hl.id, anchor: hl.anchor });
    renderHighlights();
    hideSelectionPopup();
    state.selection = null;
  }

  function renderHighlights() {
    const list = state.highlights;
    if (!list.length) {
      els.panelHighlights.innerHTML = '<div class="empty">No highlights yet. Select text to highlight it.</div>';
      return;
    }
    els.panelHighlights.innerHTML = '';
    list
      .slice()
      .reverse()
      .forEach((hl) => {
        const row = makeRow(chapterLabel(hl.index), `“${hl.text}”`, () =>
          go(hl.index, { restore: { path: hl.anchor.start.path }, flash: hl.anchor.start.path })
        );
        addDelete(row, () => {
          state.highlights = state.highlights.filter((h) => h.id !== hl.id);
          saveHighlights();
          if (hl.index === state.index) sendToChapter({ type: 'eupub:removeHighlight', id: hl.id });
          renderHighlights();
        });
        els.panelHighlights.appendChild(row);
      });
  }

  // --- search ---------------------------------------------------------

  function reflectCaseButton() {
    const on = !!prefs.searchCaseSensitive;
    els.searchCase.classList.toggle('on', on);
    els.searchCase.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  // Loads the euspell engine into the reader process (API only, no auto-run) so
  // search can reform text. Inline <script> injection (allowed by our CSP's
  // 'unsafe-inline') — no eval, which the CSP forbids.
  function ensureEngine() {
    if (window.EupubEngine || !state.engineSource) return;
    try {
      window.__eupubNoAuto = true;
      const s = document.createElement('script');
      s.textContent = state.engineSource;
      document.head.appendChild(s);
      s.remove();
    } catch (e) {
      console.error('Could not initialize euspell engine for search', e);
    }
  }

  // Builds (and caches) a chapter's search index: each leaf block's original text
  // plus its euspell-reformed text (so either spelling can match). The reformed
  // copy is reformed in a detached, reader-owned element via the engine.
  async function getChapterIndex(i) {
    const absPath = state.model.spine[i].absPath;
    let blocks = state.searchIndex.get(absPath);
    if (blocks) return blocks;

    const html = await window.eupub.readText(absPath);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    for (const s of doc.querySelectorAll('script')) s.remove();
    blocks = [];
    if (doc.body) {
      let refBody = null;
      if (window.EupubEngine) {
        try {
          refBody = document.importNode(doc.body, true); // reader-owned copy
          window.EupubEngine.walkTextNodes(refBody, window.EupubEngine.convert);
        } catch (e) {
          refBody = null;
        }
      }
      const isLeaf = (b) => !b.querySelector(LEAF_BLOCK_SEL);
      const norm = (b) => (b.textContent || '').replace(/\s+/g, ' ').trim();
      const origBlocks = [...doc.body.querySelectorAll(BLOCK_SEL)].filter(isLeaf);
      // refBody is a deep clone, so its leaf blocks line up 1:1 with origBlocks.
      const refBlocks = refBody ? [...refBody.querySelectorAll(BLOCK_SEL)].filter(isLeaf) : [];
      for (let j = 0; j < origBlocks.length; j++) {
        blocks.push({
          path: elPathOf(origBlocks[j], doc.body),
          origText: norm(origBlocks[j]),
          refText: refBlocks[j] ? norm(refBlocks[j]) : null,
        });
      }
    }
    state.searchIndex.set(absPath, blocks);
    return blocks;
  }

  async function runSearch(query) {
    state.search.query = query;
    state.search.results = [];
    if (!query || query.length < 2) {
      renderSearchResults([], query);
      return;
    }
    setStatus('left', `Searching “${query}”…`);
    ensureEngine(); // enables matching the euspell spelling too
    const cs = !!prefs.searchCaseSensitive;
    const q = cs ? query : query.toLowerCase();
    const fold = (s) => (cs ? s : s.toLowerCase());
    const results = [];

    for (let i = 0; i < state.model.spine.length && results.length < 400; i++) {
      const blocks = await getChapterIndex(i);
      for (const b of blocks) {
        // Collect word spans that match the query in EITHER spelling, deduped by
        // word position (an unchanged word matches both at the same index).
        const spans = new Map();
        const scan = (text) => {
          if (!text) return;
          const hay = fold(text);
          let from = 0;
          let at;
          while ((at = hay.indexOf(q, from)) !== -1) {
            const span = wordSpanAt(text, at, q.length);
            spans.set(span.wordStart + '-' + span.wordEnd, span);
            from = at + q.length;
            if (spans.size > 60) break;
          }
        };
        scan(b.origText);
        scan(b.refText);
        if (!spans.size) continue;

        // Snippet from the text the reader currently displays.
        const shown = prefs.euspell && b.refText != null ? b.refText : b.origText;
        for (const span of spans.values()) {
          results.push({
            index: i,
            path: b.path,
            wordStart: span.wordStart,
            wordEnd: span.wordEnd,
            snippet: snippetAtWords(shown, span.wordStart, span.wordEnd),
          });
          if (results.length >= 400) break;
        }
        if (results.length >= 400) break;
      }
    }

    state.search.results = results;
    renderSearchResults(results, query);
    setStatus('left', `${results.length} result${results.length === 1 ? '' : 's'} for “${query}”`);
  }

  function renderSearchResults(results, query) {
    if (!query) {
      els.searchResults.innerHTML = '<div class="empty">Type a phrase and press Enter to search the whole book.</div>';
      return;
    }
    if (!results.length) {
      els.searchResults.innerHTML = `<div class="empty">No matches for “${escapeHtml(query)}”.</div>`;
      return;
    }
    els.searchResults.innerHTML = '';
    results.forEach((r) => {
      const row = document.createElement('div');
      row.className = 'row';
      // chapterLabel comes from the EPUB's TOC (untrusted) — escape it. r.snippet
      // is already escaped in snippet()/snippetAtWords.
      row.innerHTML = `<div class="row-meta">${escapeHtml(chapterLabel(r.index))}</div><div class="row-text">${r.snippet}</div>`;
      row.addEventListener('click', () =>
        go(r.index, {
          restore: { path: r.path },
          find: { index: r.index, path: r.path, wordStart: r.wordStart, wordEnd: r.wordEnd },
        })
      );
      els.searchResults.appendChild(row);
    });
  }

  // --- selection popup ------------------------------------------------

  function showSelectionPopup(rect) {
    if (!rect) return;
    els.popup.style.left = `${rect.x + rect.w / 2}px`;
    els.popup.style.top = `${rect.y}px`;
    els.popup.classList.remove('hidden');
  }
  function hideSelectionPopup() {
    els.popup.classList.add('hidden');
  }

  // --- prefs ----------------------------------------------------------

  function changeFont(dir) {
    prefs.fontSize = Math.max(12, Math.min(30, prefs.fontSize + dir));
    savePrefs();
    reRenderKeepingPlace();
  }
  function toggleTheme() {
    prefs.theme = prefs.theme === 'dark' ? 'light' : 'dark';
    savePrefs();
    reRenderKeepingPlace();
  }
  function enableControls(on) {
    for (const b of [els.sidebarBtn, els.prev, els.next, els.bookmark, els.fontDown, els.fontUp, els.theme]) {
      b.disabled = !on;
    }
  }

  // --- persistence ----------------------------------------------------

  function savePosition() {
    if (!state.book) return;
    localStorage.setItem(posKey(state.book.sourcePath), JSON.stringify({ index: state.index, locator: state.currentLocator }));
  }
  function saveBookmarks() {
    localStorage.setItem(bmKey(state.book.sourcePath), JSON.stringify(state.bookmarks));
  }
  function saveHighlights() {
    localStorage.setItem(hlKey(state.book.sourcePath), JSON.stringify(state.highlights));
  }
  function loadPrefs() {
    const defaults = { euspell: true, fontSize: 19, theme: 'light', searchCaseSensitive: false };
    try {
      return Object.assign(defaults, JSON.parse(localStorage.getItem(PREFS_KEY) || '{}'));
    } catch {
      return defaults;
    }
  }
  function savePrefs() {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  }
  function loadJSON(key, fallback) {
    try {
      const v = JSON.parse(localStorage.getItem(key));
      return v == null ? fallback : v;
    } catch {
      return fallback;
    }
  }

  // Recent books: [{ path, title }], most-recent-first, deduped by path, capped.
  function loadRecents() {
    const v = loadJSON(RECENT_KEY, []);
    return Array.isArray(v) ? v.filter((r) => r && r.path) : [];
  }
  function saveRecents(list) {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  }
  function pushRecent(filePath, title) {
    if (!filePath) return;
    const list = loadRecents().filter((r) => r.path !== filePath);
    list.unshift({ path: filePath, title: title || window.eupub.basename(filePath) });
    saveRecents(list.slice(0, RECENT_MAX));
  }
  function pruneRecent(filePath) {
    saveRecents(loadRecents().filter((r) => r.path !== filePath));
    if (!els.openMenu.classList.contains('hidden')) renderOpenMenu();
  }

  // --- open menu ------------------------------------------------------

  function toggleOpenMenu() {
    if (els.openMenu.classList.contains('hidden')) {
      renderOpenMenu();
      els.openMenu.classList.remove('hidden');
      els.open.setAttribute('aria-expanded', 'true');
    } else {
      closeOpenMenu();
    }
  }
  function closeOpenMenu() {
    els.openMenu.classList.add('hidden');
    els.open.setAttribute('aria-expanded', 'false');
  }
  function renderOpenMenu() {
    const menu = els.openMenu;
    menu.textContent = '';

    const pick = document.createElement('button');
    pick.className = 'menu-item';
    pick.textContent = 'Open EPUB…';
    pick.addEventListener('click', () => {
      closeOpenMenu();
      openBook();
    });
    menu.appendChild(pick);

    const sep = document.createElement('div');
    sep.className = 'menu-sep';
    menu.appendChild(sep);

    const recents = loadRecents();
    if (!recents.length) {
      const empty = document.createElement('div');
      empty.className = 'menu-empty';
      empty.textContent = 'No recent books';
      menu.appendChild(empty);
      return;
    }
    for (const r of recents) {
      const item = document.createElement('button');
      item.className = 'menu-item recent';
      item.title = r.path;
      const label = document.createElement('span');
      label.className = 'menu-item-label';
      label.textContent = r.title || window.eupub.basename(r.path);
      item.appendChild(label);
      item.addEventListener('click', () => {
        closeOpenMenu();
        openRecent(r.path);
      });
      const del = document.createElement('span');
      del.className = 'menu-del';
      del.textContent = '×';
      del.title = 'Remove from recent';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        pruneRecent(r.path);
      });
      item.appendChild(del);
      menu.appendChild(item);
    }
  }

  // --- helpers --------------------------------------------------------

  function chapterLabel(index) {
    const t = state.model.toc.find((e) => e.spineIndex === index);
    return t ? t.label : `Chapter ${index + 1}`;
  }
  function makeRow(meta, text, onClick) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<div class="row-meta">${escapeHtml(meta)}</div>${text ? `<div class="row-text">${escapeHtml(text)}</div>` : ''}`;
    row.addEventListener('click', onClick);
    return row;
  }
  function addDelete(row, onDelete) {
    const del = document.createElement('button');
    del.className = 'row-del';
    del.textContent = '×';
    del.title = 'Remove';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      onDelete();
    });
    row.appendChild(del);
  }
  // Word index span (0-based, within the block's text) that a match at
  // [at, at+len) falls on — recorded at search time so the runtime can highlight
  // the corresponding (reformed) word by position. Same word regex as the runtime.
  function wordSpanAt(text, at, len) {
    const re = /[\p{L}\p{N}]+(?:['’ʼ][\p{L}\p{N}]+)*/gu;
    const end = at + len;
    let idx = 0;
    let start = -1;
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      const ws = m.index;
      const we = ws + m[0].length;
      if (ws >= end) break;
      if (we > at) {
        if (start === -1) start = idx;
        last = idx;
      }
      idx++;
    }
    if (start === -1) start = 0;
    return { wordStart: start, wordEnd: last };
  }
  // Inverse of wordSpanAt: the character range of words [wordStart, wordEnd].
  function wordRangeToChars(text, wordStart, wordEnd) {
    const re = /[\p{L}\p{N}]+(?:['’ʼ][\p{L}\p{N}]+)*/gu;
    let idx = 0;
    let start = -1;
    let end = -1;
    let m;
    while ((m = re.exec(text))) {
      if (idx === wordStart) start = m.index;
      if (idx === wordEnd) { end = m.index + m[0].length; break; }
      idx++;
    }
    if (start === -1) return null;
    if (end === -1) end = text.length;
    return { start, end };
  }
  // A snippet with the matched word(s) marked, built from whichever text is shown.
  function snippetAtWords(text, wordStart, wordEnd) {
    const range = wordRangeToChars(text, wordStart, wordEnd);
    if (!range) return escapeHtml(text.slice(0, 70)) + ' …';
    return snippet(text, range.start, range.end - range.start);
  }
  function elPathOf(el, body) {
    const p = [];
    let n = el;
    while (n && n !== body && n.parentElement) {
      const par = n.parentElement;
      let idx = 0;
      let c = par.firstElementChild;
      while (c && c !== n) { idx++; c = c.nextElementSibling; }
      p.unshift(idx);
      n = par;
    }
    return p;
  }
  function snippet(text, at, len) {
    const before = text.slice(Math.max(0, at - 34), at);
    const match = text.slice(at, at + len);
    const after = text.slice(at + len, at + len + 44);
    return (
      (at > 34 ? '… ' : '') +
      escapeHtml(before) +
      '<mark>' +
      escapeHtml(match) +
      '</mark>' +
      escapeHtml(after) +
      ' …'
    );
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  function uid() {
    return 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }
  function setStatus(side, text) {
    (side === 'left' ? els.statusLeft : els.statusRight).textContent = text;
  }
  function withTrailingSlash(url) {
    return url.endsWith('/') ? url : url + '/';
  }
})();
