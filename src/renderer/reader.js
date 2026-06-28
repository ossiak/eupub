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
    panelToc: $('panel-toc'),
    panelBookmarks: $('panel-bookmarks'),
    panelHighlights: $('panel-highlights'),
    searchInput: $('search-input'),
    searchResults: $('search-results'),
    popup: $('selection-popup'),
    hlAdd: $('hl-add'),
  };

  // Block-level selector: matches viewer-runtime's BLOCK, used to find the leaf
  // text blocks that search results anchor to.
  const BLOCK_SEL = 'p,div,section,article,blockquote,li,dd,dt,h1,h2,h3,h4,h5,h6,figure,figcaption,td,th,pre,img,table';

  const PREFS_KEY = 'eupub:prefs';
  const LAST_KEY = 'eupub:last';
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
    els.euspell.disabled = false;

    wireEvents();

    const last = localStorage.getItem(LAST_KEY);
    if (last) {
      const book = await window.eupub.openPath(last);
      if (book) await loadBook(book);
    }
  }

  function wireEvents() {
    els.open.addEventListener('click', openBook);
    els.open2.addEventListener('click', openBook);
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

    for (const tab of document.querySelectorAll('.tab')) {
      tab.addEventListener('click', () => switchTab(tab.dataset.tab));
    }
    els.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') runSearch(els.searchInput.value.trim());
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
    if (book) {
      localStorage.setItem(LAST_KEY, book.sourcePath);
      await loadBook(book);
    }
  }

  async function loadBook(book) {
    state.book = book;
    state.model = await window.EupubModel.parseAsync(book);
    for (const s of state.model.spine) s.fileURL = window.eupub.fileURL(s.absPath);

    state.bookmarks = loadJSON(bmKey(book.sourcePath), []);
    state.highlights = loadJSON(hlKey(book.sourcePath), []);
    state.search = { query: '', results: [] };
    els.searchInput.value = '';

    els.bookTitle.textContent = state.model.title;
    document.title = `${state.model.title} — Eupub`;
    renderToc();
    renderBookmarks();
    renderHighlights();
    renderSearchResults([], '');
    enableControls(true);

    const saved = loadJSON(posKey(book.sourcePath), null);
    state.currentLocator = saved && saved.locator ? saved.locator : null;
    const start = saved && Number.isInteger(saved.index) && saved.index < state.model.spine.length ? saved.index : 0;
    go(start, { restore: state.currentLocator });
  }

  // --- chapter rendering ----------------------------------------------

  function go(index, opts) {
    if (!state.model) return;
    opts = opts || {};
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
      // In-chapter live marks only when euspell is off, so the query (original
      // spelling) matches the on-screen text. Otherwise the flash shows the spot.
      search: state.search.query && !prefs.euspell ? { query: state.search.query, occurrence: 0 } : null,
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

  function updateNavState() {
    els.prev.disabled = state.index <= 0 && state.page <= 0;
    els.next.disabled = state.index >= state.model.spine.length - 1 && state.page >= state.pages - 1;
    const chapter = `Ch ${state.index + 1}/${state.model.spine.length}`;
    setStatus('right', `${chapter} · p ${state.page + 1}/${state.pages}`);
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
      a.classList.toggle('active', Number(a.dataset.index) === state.index);
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

  async function runSearch(query) {
    state.search.query = query;
    state.search.results = [];
    if (!query || query.length < 2) {
      renderSearchResults([], query);
      return;
    }
    setStatus('left', `Searching “${query}”…`);
    const q = query.toLowerCase();
    const results = [];

    for (let i = 0; i < state.model.spine.length && results.length < 400; i++) {
      const html = await window.eupub.readText(state.model.spine[i].absPath);
      const doc = new DOMParser().parseFromString(html, 'text/html');
      for (const s of doc.querySelectorAll('script')) s.remove();
      if (!doc.body) continue;

      const blocks = [...doc.body.querySelectorAll(BLOCK_SEL)].filter((b) => !b.querySelector(BLOCK_SEL));
      for (const block of blocks) {
        const text = (block.textContent || '').replace(/\s+/g, ' ').trim();
        const lower = text.toLowerCase();
        let from = 0;
        let at;
        while ((at = lower.indexOf(q, from)) !== -1) {
          results.push({ index: i, path: elPathOf(block, doc.body), snippet: snippet(text, at, q.length) });
          from = at + q.length;
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
      row.innerHTML = `<div class="row-meta">${chapterLabel(r.index)}</div><div class="row-text">${r.snippet}</div>`;
      row.addEventListener('click', () => go(r.index, { restore: { path: r.path }, flash: r.path }));
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
    const defaults = { euspell: true, fontSize: 19, theme: 'light' };
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
