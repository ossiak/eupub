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
    moreWrap: $('more-wrap'),
    moreBtn: $('more-btn'),
    moreMenu: $('more-menu'),
    sidebar: $('sidebar'),
    sidebarBtn: $('sidebar-btn'),
    searchBtn: $('search-btn'),
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
    // Storage key for this book's saved state (position/bookmarks/highlights):
    // the OPF dc:identifier when it has one — stable when the file is moved or
    // renamed — else the file path. See loadBookState for the legacy fallback.
    bookKey: null,
    index: -1,
    page: 0,
    pages: 1,
    engineSource: '',
    runtimeSource: '',
    currentLocator: null,
    bookmarks: [],
    highlights: [],
    selection: null,
    // `current` is the cursor into results for Enter / Shift+Enter / F3 cycling
    // (-1 = no hit selected yet).
    search: { query: '', results: [], current: -1 },
    // Monotonic render id: a chapter render that finishes its async read after a
    // newer render started must not touch the iframe (fast TOC clicks race).
    renderToken: 0,
    // Chapter HTML cache (absPath -> Promise<string>): the same file is read by
    // rendering, re-renders (font/theme), the progress pass, and the search
    // index — read each chapter from disk once per book session.
    htmlCache: new Map(),
    // Per-chapter lexicon subset (absPath -> Promise<[key,entry][]>): the words a
    // chapter uses, fetched once from the on-disk SQLite lexicon. Injected into
    // the chapter iframe (with the lexicon-excluded engine) and used reader-side
    // for the search index — so the full ~14 MB table is never resident.
    subsetCache: new Map(),
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

    // On a phone the sidebar overlays the reader (see reader.css), so start it
    // closed to keep the book in view; the ☰ button opens it on demand.
    if (isSmallScreen()) els.sidebar.classList.add('hidden');

    // A book opened from the OS (double-clicked in the file manager, or a CLI
    // arg) arrives via this channel; reuse the open-by-path + load flow. Guarded
    // because the Android bridge doesn't provide it.
    if (window.eupub.onOpenFile) {
      window.eupub.onOpenFile((filePath) => openRecent(filePath));
    }

    // Reopen the most recent book on launch. Fall back to the legacy single-slot
    // key so existing users keep their last book before any recent is recorded.
    const recents = loadRecents();
    const last = (recents[0] && recents[0].path) || localStorage.getItem(LAST_KEY);
    if (last) {
      try {
        const book = await window.eupub.openPath(last);
        if (book) await loadBook(book);
        else pruneRecent(last); // file moved/deleted since last session
      } catch (err) {
        console.error(err);
        pruneRecent(last);
        setStatus('left', 'The last book could not be reopened — removed from recent.');
      }
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

    // Overflow ("More") menu: the phone-collapsed display controls. Each item
    // reuses the same handler as its inline button.
    els.moreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleMoreMenu();
    });
    els.moreMenu.addEventListener('click', (e) => {
      const item = e.target.closest('[data-action]');
      if (!item) return;
      closeMoreMenu();
      const act = item.dataset.action;
      if (act === 'bookmark') addBookmark();
      else if (act === 'font-down') changeFont(-1);
      else if (act === 'font-up') changeFont(1);
      else if (act === 'theme') toggleTheme();
    });

    document.addEventListener('click', (e) => {
      if (!els.openWrap.contains(e.target)) closeOpenMenu();
      if (!els.moreWrap.contains(e.target)) closeMoreMenu();
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { closeOpenMenu(); closeMoreMenu(); }
    });
    els.sidebarBtn.addEventListener('click', () => {
      const hidden = els.sidebar.classList.toggle('hidden');
      if (hidden) els.searchBtn.classList.remove('on');
    });
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

    // Page-turn direction must NOT follow the OS "natural scrolling" toggle (see
    // viewer-runtime.js). deltaX's sign bakes that setting in and only the host
    // can read it, so ask the desktop main for it; mobile has no such method and
    // keeps the natural default. Re-checked on focus since the user may flip the
    // setting in System Settings and switch back.
    const refreshScrollDir = () => {
      const get = window.eupub && window.eupub.getNaturalScroll;
      if (typeof get !== 'function') return;
      Promise.resolve(get())
        .then((v) => { if (typeof v === 'boolean') window.__eupubNaturalScroll = v; })
        .catch(() => {});
    };
    refreshScrollDir();
    window.addEventListener('focus', refreshScrollDir);

    for (const tab of document.querySelectorAll('.tab')) {
      tab.addEventListener('click', () => switchTab(tab.dataset.tab));
    }
    els.searchBtn.addEventListener('click', openSearch);
    els.searchInput.addEventListener('keydown', (e) => {
      // Enter runs a new query, or steps to the next hit if the query is
      // unchanged; Shift+Enter steps back. Escape hands focus back to the page.
      if (e.key === 'Enter') {
        e.preventDefault();
        submitSearch(e.shiftKey ? -1 : 1);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        returnFocusToPage();
      }
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
      // Ctrl/Cmd+F opens (or re-focuses) the book search from anywhere, incl.
      // while the input is already focused. F3 / Shift+F3 walk the hits.
      if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        openSearch();
        return;
      }
      if (e.key === 'F3') {
        e.preventDefault();
        cycleResult(e.shiftKey ? -1 : 1);
        return;
      }
      if (document.activeElement === els.searchInput) return;
      handleNavKey(e.key);
    });
  }

  // --- opening / loading ----------------------------------------------

  async function openBook() {
    try {
      const book = await window.eupub.pickEpub();
      if (book) await loadBook(book); // loadBook records it in the recent list
    } catch (err) {
      console.error(err);
      setStatus('left', 'That file could not be opened — it may be corrupt.');
    }
  }

  // Open a book chosen from the recent list. If it can no longer be opened
  // (moved, deleted, or corrupt), drop it from the list and say so.
  async function openRecent(filePath) {
    let book = null;
    try {
      book = await window.eupub.openPath(filePath);
    } catch (err) {
      console.error(err);
    }
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

    // 'id:' prefix so an identifier can't collide with a path-shaped legacy key.
    state.bookKey = state.model.identifier ? `id:${state.model.identifier}` : book.sourcePath;
    state.bookmarks = loadBookState(bmKey, []);
    state.highlights = loadBookState(hlKey, []);
    state.search = { query: '', results: [], current: -1 };
    state.charCounts = null;
    state.cumChars = null;
    state.totalChars = 0;
    state.searchIndex = new Map();
    state.htmlCache = new Map();
    state.subsetCache = new Map();
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

    const saved = loadBookState(posKey, null);
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
        const html = await readChapterHtml(spine[i].absPath);
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
    const token = ++state.renderToken;
    const item = state.model.spine[index];
    let html;
    try {
      html = await readChapterHtml(item.absPath);
    } catch (err) {
      console.error(err);
      setStatus('left', 'This chapter could not be read.');
      return;
    }
    // A newer render (fast TOC clicks, or a new book) started while the read was
    // in flight — that one owns the iframe now.
    if (token !== state.renderToken) return;
    const baseHref = withTrailingSlash(window.eupub.fileURL(window.eupub.dirname(item.absPath)));

    const cfg = {
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

    // When reforming, fetch this chapter's lexicon subset so the iframe's
    // (lexicon-excluded) engine can setLexicon it before converting. null when
    // euspell is off — no engine is injected.
    let subset = null;
    if (prefs.euspell && state.engineSource) {
      try {
        subset = await chapterSubset(item.absPath);
      } catch (err) {
        console.error(err);
        setStatus('left', 'Lexicon unavailable — showing original spelling.');
      }
      if (token !== state.renderToken) return; // superseded during the fetch
    }

    els.iframe.srcdoc = buildSrcdoc(html, baseHref, cfg, subset);
    els.welcome.classList.add('hidden');
    els.iframe.classList.remove('hidden');
    hideSelectionPopup();
  }

  function buildSrcdoc(html, baseHref, cfg, subset) {
    const doc = new DOMParser().parseFromString(html, 'text/html');

    for (const m of doc.querySelectorAll('meta[http-equiv]')) {
      if (/content-security-policy/i.test(m.getAttribute('http-equiv') || '')) m.remove();
    }
    sanitizeChapterDoc(doc);

    let head = doc.head;
    if (!head) {
      head = doc.createElement('head');
      doc.documentElement.insertBefore(head, doc.body);
    }

    const base = doc.createElement('base');
    base.setAttribute('href', baseHref);
    head.insertBefore(base, head.firstChild);

    // A chapter iframe with no viewport meta lays out at the WebView's default
    // ~980px viewport (Android), so the runtime's columns are far wider than the
    // frame and the text overflows the screen. Pin it to the frame's own width.
    // Harmless on desktop, where Chromium ignores the viewport meta.
    for (const m of doc.querySelectorAll('meta[name="viewport" i]')) m.remove();
    const viewport = doc.createElement('meta');
    viewport.setAttribute('name', 'viewport');
    viewport.setAttribute('content', 'width=device-width, initial-scale=1');
    head.insertBefore(viewport, head.firstChild);

    const style = doc.createElement('style');
    style.textContent = readerStyle();
    head.appendChild(style);

    // euspell engine first (converts the text), then the viewer runtime, which
    // lays out / paginates the converted DOM and restores position & marks. The
    // engine is the lexicon-excluded build, so we (1) suppress its auto-run,
    // (2) install this chapter's subset via setLexicon, then (3) convert — all
    // before the runtime measures pagination on the reformed text.
    if (prefs.euspell && state.engineSource && subset) {
      const noAuto = doc.createElement('script');
      noAuto.textContent = 'window.__eupubNoAuto=true;';
      doc.body.appendChild(noAuto);
      const engine = doc.createElement('script');
      engine.textContent = state.engineSource;
      doc.body.appendChild(engine);
    }
    const boot = doc.createElement('script');
    const reform =
      prefs.euspell && state.engineSource && subset
        ? `window.EupubEngine.setLexicon(new Map(${jsonForScript(subset)}));` +
          `window.EupubEngine.walkTextNodes(document.body, window.EupubEngine.convert);`
        : '';
    boot.textContent = `${reform}window.__eupubConfig=${jsonForScript(cfg)};(${state.runtimeSource})();`;
    doc.body.appendChild(boot);

    return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
  }

  // JSON safe to embed in a <script> that will be re-serialized into srcdoc:
  // "<" is escaped so a book-controlled string (e.g. a TOC fragment) containing
  // "</script>" can't close the boot script and inject markup of its own.
  function jsonForScript(value) {
    return JSON.stringify(value).replace(/</g, '\\u003c');
  }

  // Strip anything executable from an untrusted chapter document. The srcdoc
  // iframe runs with allow-same-origin + allow-scripts (our engine/runtime must
  // run there), so any book code that executed could reach this window and its
  // eupub bridge. Removing <script> alone is not enough: inline event handlers
  // (onerror=…) and javascript: URLs run under the inherited 'unsafe-inline'
  // CSP, and nested browsing contexts carry their own unscanned markup.
  function sanitizeChapterDoc(doc) {
    for (const el of doc.querySelectorAll('script, iframe, frame, object, embed')) el.remove();
    // A refresh meta would NAVIGATE the iframe — to another file from the book,
    // whose markup never went through this sanitizer, so its scripts would run.
    for (const m of doc.querySelectorAll('meta[http-equiv]')) {
      if (/refresh/i.test(m.getAttribute('http-equiv') || '')) m.remove();
    }
    for (const el of doc.querySelectorAll('*')) {
      for (const attr of [...el.attributes]) {
        const name = attr.name.toLowerCase();
        if (name.startsWith('on')) {
          el.removeAttribute(attr.name);
        } else if (name === 'action' || name === 'formaction') {
          // Form submission is the same unsanitized-navigation vector as a
          // refresh meta (one click on book-styled content). Forms can't do
          // anything useful offline, so drop their targets entirely.
          el.removeAttribute(attr.name);
        } else if (
          (name === 'href' || name === 'src' || name === 'xlink:href') &&
          /^javascript:/i.test(attr.value.replace(/[\s\u0000-\u001f]/g, ''))
        ) {
          el.removeAttribute(attr.name);
        }
      }
    }
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
    // Only the current chapter iframe may drive the reader.
    if (e.source !== els.iframe.contentWindow) return;
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
      case 'eupub:external':
        // Web/mail/tel links open in the system handler (scheme re-checked in
        // the main process), never inside the reader.
        window.eupub.openExternal(String(m.href || ''));
        break;
      case 'eupub:toggleChrome':
        // Center-tap (touch) immersive toggle: hide/show the toolbar + status
        // bar for distraction-free reading. Only ever sent from touch input.
        document.body.classList.toggle('immersive');
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
  // Chapter turns replace the iframe, which wipes the fresh runtime's own wheel
  // debounce state — so a single long swipe that lands right on a chapter's last
  // page can otherwise cascade into the next (freshly-unlocked) chapter's edge,
  // and the next, for as long as the gesture's momentum tail keeps qualifying.
  // This cooldown is the only state that survives the iframe swap, so it's what
  // actually caps a gesture to one chapter turn.
  let edgeTurnCooldown = 0;
  function handleEdgeTurn(key) {
    const now = Date.now();
    if (now < edgeTurnCooldown) return;
    edgeTurnCooldown = now + 500;
    if (key === 'ArrowRight' && state.index < state.model.spine.length - 1) go(state.index + 1, {});
    else if (key === 'ArrowLeft' && state.index > 0) go(state.index - 1, { startAtEnd: true });
  }
  function handleNavKey(key) {
    if (state.index < 0) return;
    if (key === 'ArrowRight') navNext();
    else if (key === 'ArrowLeft') navPrev();
  }

  // Wheel over the Contents sidebar: never scroll the TOC (click-only), instead
  // page the book — matching the in-iframe wheel feel (threshold + idle-debounce,
  // one page-turn per swipe burst; see viewer-runtime.js's wheel handler for why
  // a fixed-window lock double-fires on longer/momentum swipes). Only acts while
  // the Contents tab is active, so the scrollable Marks/Notes/Search panels keep
  // their normal wheel scrolling.
  let tocWheelIdle = null;
  let tocWheelActedThisBurst = false;
  function onSidebarWheel(e) {
    if (state.index < 0) return;
    if (!els.sidebar.contains(e.target)) return;
    if (!els.panelToc.classList.contains('active')) return;
    e.preventDefault();
    // Horizontal-dominant swipes only — see viewer-runtime.js's wheel handler.
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
    // Normalize away the OS natural-scrolling setting — see viewer-runtime.js.
    const d = window.__eupubNaturalScroll === false ? -e.deltaX : e.deltaX;
    if (Math.abs(d) < 8) return;
    // Only a qualifying event extends the burst — see viewer-runtime.js for why.
    clearTimeout(tocWheelIdle);
    tocWheelIdle = setTimeout(() => { tocWheelActedThisBurst = false; }, 70);
    if (tocWheelActedThisBurst) return;
    tocWheelActedThisBurst = true;
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
    els.searchBtn.classList.toggle('on', name === 'search');
  }

  // True on a phone-width viewport, where the sidebar overlays the reader.
  function isSmallScreen() {
    return window.matchMedia('(max-width: 640px)').matches;
  }
  // After choosing a chapter on a phone, close the overlay so the text shows.
  // (Search/bookmark/note hits don't auto-close — you often browse several.)
  function closeSidebarIfSmall() {
    if (isSmallScreen()) els.sidebar.classList.add('hidden');
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
        if (entry.spineIndex != null) {
          go(entry.spineIndex, { fragment: entry.fragment });
          closeSidebarIfSmall();
        }
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

  // Open the book search (toolbar 🔍 or Ctrl/Cmd+F): reveal the sidebar, switch
  // to the Search tab (which focuses the input) and select any existing text so
  // a new query types straight over it.
  function openSearch() {
    if (!state.book) return;
    switchTab('search');
    els.searchInput.select();
  }

  // Enter in the search box: a changed query (or none run yet) runs a fresh
  // book-wide search and shows the results list — without yanking the reader off
  // its page. An unchanged query means "walk the hits": step to the next one
  // (dir -1 for Shift+Enter), same as F3. So the first Enter searches, and each
  // Enter after that moves through the results.
  function submitSearch(dir) {
    const q = els.searchInput.value.trim();
    if (q !== state.search.query || !state.search.results.length) {
      runSearch(q);
    } else {
      cycleResult(dir);
    }
  }

  // Step the result cursor by `dir` (wrapping) and navigate to that hit.
  function cycleResult(dir) {
    const res = state.search.results;
    if (!res.length) return;
    const cur = state.search.current;
    const next = cur < 0
      ? (dir > 0 ? 0 : res.length - 1)
      : (cur + dir + res.length) % res.length;
    selectResult(next);
  }

  // Navigate to result `i`: mark its row current, show the "n / m" counter, and
  // jump to the chapter with the hit word highlighted. Shared by row clicks and
  // keyboard cycling.
  function selectResult(i) {
    const res = state.search.results;
    const r = res[i];
    if (!r) return;
    state.search.current = i;
    markCurrentRow(i);
    setStatus('left', `${i + 1} / ${res.length} for “${state.search.query}”`);
    go(r.index, {
      restore: { path: r.path },
      find: { index: r.index, path: r.path, wordStart: r.wordStart, wordEnd: r.wordEnd },
    });
  }

  // Highlight the current result row (rows line up 1:1 with results) and keep it
  // in view as the cursor moves through a long list.
  function markCurrentRow(i) {
    const rows = els.searchResults.children;
    for (let k = 0; k < rows.length; k++) rows[k].classList.toggle('current', k === i);
    if (rows[i]) rows[i].scrollIntoView({ block: 'nearest' });
  }

  // Escape from the search box: drop focus so arrow-key paging works again.
  function returnFocusToPage() {
    els.searchInput.blur();
    els.iframe.focus();
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

    let html = '';
    try {
      html = await readChapterHtml(absPath);
    } catch {
      /* unreadable chapter — index it as empty */
    }
    const doc = new DOMParser().parseFromString(html, 'text/html');
    // Full sanitize, not just script removal: importNode below adopts these
    // elements into THIS document, where a surviving onerror handler on an <img>
    // could fire in the reader's own realm.
    sanitizeChapterDoc(doc);
    blocks = [];
    if (doc.body) {
      let refBody = null;
      if (window.EupubEngine) {
        try {
          // Install this chapter's subset so the (lexicon-excluded) reader engine
          // reforms the same way the chapter iframe will.
          const subsetArr = await chapterSubset(absPath);
          window.EupubEngine.setLexicon(new Map(subsetArr));
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

  // Read a chapter's HTML once per book session (see state.htmlCache). Caches
  // the promise so concurrent callers share one read; a failed read is evicted
  // so it can be retried.
  function readChapterHtml(absPath) {
    let p = state.htmlCache.get(absPath);
    if (!p) {
      const cache = state.htmlCache;
      p = window.eupub.readText(absPath);
      p.catch(() => {
        if (cache.get(absPath) === p) cache.delete(absPath);
      });
      cache.set(absPath, p);
    }
    return p;
  }

  // A chapter's lexicon subset — the entries for exactly the words it uses,
  // fetched once from the SQLite lexicon and cached per book session. Returns an
  // array of [key, entry], ready for `new Map(...)`.
  function chapterSubset(absPath) {
    let p = state.subsetCache.get(absPath);
    if (!p) {
      const cache = state.subsetCache;
      p = buildChapterSubset(absPath);
      p.catch(() => { if (cache.get(absPath) === p) cache.delete(absPath); });
      cache.set(absPath, p);
    }
    return p;
  }
  async function buildChapterSubset(absPath) {
    const html = await readChapterHtml(absPath);
    ensureEngine();
    return window.eupub.lexiconSubset([...chapterVocab(html)]);
  }

  // The set of lowercase words a chapter looks up, collected via the engine's OWN
  // block grouping + tokenization: walkTextNodes with a recording function that
  // returns each word unchanged. Using the real walker (not a regex over
  // textContent) means words split across inline elements, or adjacent across
  // block boundaries, are grouped exactly as they are at conversion time — so the
  // subset can't miss a word and diverge from the full-lexicon result. Requires
  // ensureEngine() to have run.
  function chapterVocab(html) {
    const words = new Set();
    if (!window.EupubEngine) return words;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    sanitizeChapterDoc(doc);
    if (!doc.body) return words;
    try {
      const clone = document.importNode(doc.body, true); // reader-owned copy
      window.EupubEngine.walkTextNodes(clone, (w) => { words.add(w.toLowerCase()); return w; });
    } catch (e) {
      console.error(e);
    }
    return words;
  }

  let searchToken = 0; // invalidates in-flight searches (new query or new book)

  async function runSearch(query) {
    const token = ++searchToken;
    const book = state.book;
    state.search.query = query;
    state.search.results = [];
    state.search.current = -1;
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
      // Superseded by a newer search, or the book changed while we were reading
      // — this run's results (and its loop bounds) no longer apply.
      if (token !== searchToken || state.book !== book) return;
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
    results.forEach((r, i) => {
      const row = document.createElement('div');
      row.className = 'row';
      // chapterLabel comes from the EPUB's TOC (untrusted) — escape it. r.snippet
      // is already escaped in snippet()/snippetAtWords.
      row.innerHTML = `<div class="row-meta">${escapeHtml(chapterLabel(r.index))}</div><div class="row-text">${r.snippet}</div>`;
      // Clicking a row and keyboard cycling share one path (selectResult), so the
      // "n / m" counter and the current-row marker stay in sync either way.
      row.addEventListener('click', () => selectResult(i));
      els.searchResults.appendChild(row);
    });
  }

  // --- selection popup ------------------------------------------------

  function showSelectionPopup(rect) {
    if (!rect) return;
    // Keep the popup inside the reader area: clamp horizontally, and flip below
    // the selection when it starts too close to the top to fit above (the
    // reader clips overflow).
    const halfW = 50;
    const x = Math.max(halfW, Math.min(rect.x + rect.w / 2, els.iframe.clientWidth - halfW));
    const flip = rect.y < 44;
    els.popup.style.left = `${x}px`;
    els.popup.style.top = flip ? `${rect.y + rect.h + 8}px` : `${rect.y}px`;
    els.popup.style.transform = flip ? 'translate(-50%, 0)' : 'translate(-50%, -120%)';
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
    for (const b of [els.sidebarBtn, els.searchBtn, els.prev, els.next, els.bookmark, els.fontDown, els.fontUp, els.theme, els.moreBtn]) {
      b.disabled = !on;
    }
  }

  // --- persistence ----------------------------------------------------

  function savePosition() {
    if (!state.book) return;
    localStorage.setItem(posKey(state.bookKey), JSON.stringify({ index: state.index, locator: state.currentLocator }));
  }
  function saveBookmarks() {
    localStorage.setItem(bmKey(state.bookKey), JSON.stringify(state.bookmarks));
  }
  function saveHighlights() {
    localStorage.setItem(hlKey(state.bookKey), JSON.stringify(state.highlights));
  }
  // Saved state for the current book: the stable identifier key first, then the
  // legacy path key (state saved before identifier keys existed — it migrates
  // to the stable key on the next save).
  function loadBookState(keyFn, fallback) {
    const v = loadJSON(keyFn(state.bookKey), null);
    if (v != null) return v;
    const legacy = loadJSON(keyFn(state.book.sourcePath), null);
    return legacy != null ? legacy : fallback;
  }
  function loadPrefs() {
    const defaults = { euspell: true, fontSize: 14, theme: 'light', searchCaseSensitive: false };
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
  function toggleMoreMenu() {
    const open = els.moreMenu.classList.toggle('hidden');
    els.moreBtn.setAttribute('aria-expanded', open ? 'false' : 'true');
  }
  function closeMoreMenu() {
    els.moreMenu.classList.add('hidden');
    els.moreBtn.setAttribute('aria-expanded', 'false');
  }
  function renderOpenMenu() {
    const menu = els.openMenu;
    menu.textContent = '';

    const pick = document.createElement('button');
    pick.className = 'menu-item';
    pick.textContent = 'Open a book…';
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
