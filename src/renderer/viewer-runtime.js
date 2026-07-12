// Eupub chapter viewer runtime. This function is defined in the parent window
// only to obtain its source via .toString(); it never executes here. reader.js
// injects `(<thisFunction>)()` into each chapter iframe, where it runs with
// `document` === the chapter document (after the euspell engine has converted
// the text). It owns everything that needs the chapter DOM: pagination, reading
// position locators, bookmarks anchoring, highlights, in-chapter search marks,
// link routing, and key/selection handling. It talks to the reader purely via
// postMessage. Configuration arrives on window.__eupubConfig.
window.EupubViewerRuntime = function () {
  'use strict';

  var cfg = window.__eupubConfig || {};

  var currentPage = 0;
  var pageCount = 1;
  var lastLocator = cfg.restore || null;

  var BLOCK = 'p,div,section,article,blockquote,li,dd,dt,h1,h2,h3,h4,h5,h6,figure,figcaption,td,th,pre,img,table';

  // Side and vertical page margins (px). The column geometry is derived from a
  // single measured page width so the page-turn transform and the column pitch
  // match exactly — otherwise columns drift and each page shows two half-columns.
  var SIDE = 48;
  var VPAD = 44;
  var pageWidth = 0;

  function post(type, data) {
    var msg = { type: type };
    if (data) for (var k in data) msg[k] = data[k];
    parent.postMessage(msg, '*');
  }
  function pageW() { return pageWidth || document.documentElement.clientWidth; }

  // Owns ALL paginated geometry, in pixels from the true viewport content width
  // (clientWidth excludes any scrollbar). With body box border-box and side
  // padding SIDE, the content box is W − 2·SIDE; a column of that width fits
  // exactly once, and the gap of 2·SIDE makes each column pitch land at exactly
  // W — identical to the transform step. reader.js sets only cosmetics.
  //
  // EPUB chapters routinely style their own <body> (max-width, margin:auto,
  // padding, float, a fixed width, or even column-count). Any of those make the
  // column box differ from the viewport, so columns drift and pages "split". We
  // therefore set the geometry — and neutralize the common offenders — with
  // !important so the book's stylesheet can't win.
  function applyColumns() {
    var W = document.documentElement.clientWidth;
    var H = document.documentElement.clientHeight;
    // Tighter margins on a phone-width viewport, so the text isn't crowded into
    // a narrow central column; a roomier desktop window keeps the wider margins.
    // In landscape (wider than tall) the height is the scarce dimension, so trim
    // the padding — chiefly the vertical — rather than waste it on empty margin.
    var side, vpad;
    if (W < 600) {           // narrow phone (portrait)
      side = 22; vpad = 28;
    } else if (W > H) {      // landscape: phone/tablet rotated, or desktop window
      side = 32; vpad = 22;
    } else {                 // roomy portrait window
      side = SIDE; vpad = VPAD;
    }
    pageWidth = W;
    set(document.documentElement.style, {
      margin: '0', padding: '0', width: W + 'px', height: H + 'px', overflow: 'hidden',
    });
    set(document.body.style, {
      'box-sizing': 'border-box',
      width: '100%', 'max-width': 'none', 'min-width': '0',
      height: H + 'px', 'max-height': 'none', 'min-height': '0',
      margin: '0', padding: vpad + 'px ' + side + 'px',
      float: 'none', position: 'static',
      'column-width': (W - 2 * side) + 'px',
      'column-gap': 2 * side + 'px',
      'column-count': 'auto',
      'column-fill': 'auto',
      overflow: 'visible',
    });
  }
  function set(style, props) {
    for (var k in props) style.setProperty(k, props[k], 'important');
  }

  // --- element-only paths (structure-stable; survive euspell + span wraps) ---

  function elPath(el) {
    var p = [];
    var n = el;
    while (n && n !== document.body && n.parentElement) {
      var par = n.parentElement;
      var idx = 0;
      var c = par.firstElementChild;
      while (c && c !== n) { idx++; c = c.nextElementSibling; }
      p.unshift(idx);
      n = par;
    }
    return p;
  }
  function elResolve(path) {
    var n = document.body;
    for (var i = 0; i < path.length && n; i++) {
      var c = n.firstElementChild;
      var k = path[i];
      while (k > 0 && c) { c = c.nextElementSibling; k--; }
      n = c;
    }
    return n;
  }
  function nearestBlock(node) {
    var el = node.nodeType === 3 ? node.parentElement : node;
    while (el && el !== document.body) {
      if (el.matches && el.matches(BLOCK)) return el;
      el = el.parentElement;
    }
    return document.body.firstElementChild || document.body;
  }

  // Character offset of a boundary within a block's text-only content, and the
  // inverse — robust to text nodes being split by highlight/search spans. Using
  // a Range handles boundaries that land on either a text node or an element
  // (e.g. selectNodeContents), since range.toString() yields text only.
  function charOffsetIn(block, node, offset) {
    var r = document.createRange();
    r.selectNodeContents(block);
    try { r.setEnd(node, offset); } catch (e) { return block.textContent.length; }
    return r.toString().length;
  }
  function resolveCharOffset(block, charOffset) {
    var w = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, null);
    var total = 0, t;
    while ((t = w.nextNode())) {
      var len = t.nodeValue.length;
      if (charOffset <= total + len) return { node: t, offset: charOffset - total };
      total += len;
    }
    return t ? { node: t, offset: t.nodeValue.length } : null;
  }

  // --- pagination ---

  function measure() {
    applyColumns();
    pageCount = Math.max(1, Math.round(document.body.scrollWidth / pageW()));
  }
  function applyTransform(animate) {
    // !important so a book's own body transform can't override the page offset.
    document.body.style.setProperty('transition', animate ? 'transform .18s ease' : 'none', 'important');
    document.body.style.setProperty('transform', 'translateX(' + (-currentPage * pageW()) + 'px)', 'important');
  }
  function goToPage(p, animate) {
    currentPage = Math.max(0, Math.min(p, pageCount - 1));
    applyTransform(animate);
    emitPosition();
  }
  function nextPage() {
    if (currentPage < pageCount - 1) { goToPage(currentPage + 1, true); return true; }
    return false;
  }
  function prevPage() {
    if (currentPage > 0) { goToPage(currentPage - 1, true); return true; }
    return false;
  }

  // --- reading position ---

  // A multi-column element that spans a page break reports a union
  // getBoundingClientRect, so we use its FIRST fragment rect — where it begins.
  function firstRect(el) {
    var rs = el.getClientRects();
    return rs && rs.length ? rs[0] : el.getBoundingClientRect();
  }
  // The element's x WITHIN the body content, independent of the page transform:
  // element and body rects carry the same (possibly mid-transition) transform,
  // so subtracting cancels it. This makes page math immune to transition timing.
  function contentLeft(el) {
    return firstRect(el).left - document.body.getBoundingClientRect().left;
  }
  function pageOf(el) {
    return Math.max(0, Math.floor((contentLeft(el) + 2) / pageW()));
  }

  // The block anchoring the current view: the first block that begins on the
  // current page.
  function currentLocator() {
    var blocks = document.body.querySelectorAll(BLOCK);
    var anchor = null, firstAfter = null;
    for (var i = 0; i < blocks.length; i++) {
      var pg = pageOf(blocks[i]);
      if (pg === currentPage) { anchor = blocks[i]; break; }
      if (pg > currentPage && !firstAfter) firstAfter = blocks[i];
    }
    if (!anchor) anchor = firstAfter || document.body.firstElementChild;
    return anchor ? { path: elPath(anchor) } : { path: [] };
  }
  function gotoEl(el, animate) {
    if (!el) return;
    goToPage(pageOf(el), animate);
  }
  function gotoLocator(loc, animate) {
    if (loc && loc.path) { lastLocator = loc; gotoEl(elResolve(loc.path), animate); }
  }
  function gotoFragment(frag) {
    if (!frag) return;
    // getElementById / getElementsByName take a raw id/name — no selector-string
    // escaping to get wrong (an EPUB fragment can be any string).
    var el = document.getElementById(frag);
    if (!el) {
      var named = document.getElementsByName(frag);
      el = named && named.length ? named[0] : null;
    }
    if (el) gotoEl(el, false);
  }
  function emitPosition() {
    lastLocator = currentLocator();
    post('eupub:position', { page: currentPage, pages: pageCount, locator: lastLocator });
  }

  // --- highlights & search marks (range wrapping) ---

  // Anchor boundaries are stored as WORD indexes, because euspell reforms each
  // word in place (word count and order survive) while char offsets shift with
  // the respelling — a char-offset highlight made in one spelling lands on the
  // wrong text in the other. Boundaries snap to whole words. The char offset is
  // kept alongside as a fallback for anchors saved before word indexes existed
  // (and for word-less blocks).
  function anchorBoundaryOffset(block, b, isEnd) {
    var text = block.textContent || '';
    if (b.word != null) {
      var w = wordRangeCharOffsets(text, b.word, b.word);
      if (w) return isEnd ? w.end : w.start;
    }
    var off = b.off != null ? b.off : 0;
    return Math.max(0, Math.min(off, text.length));
  }
  // Word index containing char offset `off` — or, for a start boundary in
  // whitespace, the next word; for an end boundary (exclusive), the last word
  // beginning before it.
  function wordIndexForStart(text, off) {
    WORD_RE.lastIndex = 0;
    var i = 0, m, last = 0;
    while ((m = WORD_RE.exec(text))) {
      if (m.index + m[0].length > off) return i;
      last = i;
      i++;
    }
    return last; // past the last word — snap to it
  }
  function wordIndexForEnd(text, off) {
    WORD_RE.lastIndex = 0;
    var i = 0, m, last = 0;
    while ((m = WORD_RE.exec(text))) {
      if (m.index >= off) break;
      last = i;
      i++;
    }
    return last;
  }
  function rangeFromAnchor(a) {
    var sBlock = elResolve(a.start.path), eBlock = elResolve(a.end.path);
    if (!sBlock || !eBlock) return null;
    var s = resolveCharOffset(sBlock, anchorBoundaryOffset(sBlock, a.start, false));
    var e = resolveCharOffset(eBlock, anchorBoundaryOffset(eBlock, a.end, true));
    if (!s || !e) return null;
    var r = document.createRange();
    try { r.setStart(s.node, s.offset); r.setEnd(e.node, e.offset); } catch (err) { return null; }
    return r;
  }
  function anchorFromRange(r) {
    var sb = nearestBlock(r.startContainer), eb = nearestBlock(r.endContainer);
    var sOff = charOffsetIn(sb, r.startContainer, r.startOffset);
    var eOff = charOffsetIn(eb, r.endContainer, r.endOffset);
    return {
      start: { path: elPath(sb), off: sOff, word: wordIndexForStart(sb.textContent || '', sOff) },
      end: { path: elPath(eb), off: eOff, word: wordIndexForEnd(eb.textContent || '', eOff) },
    };
  }
  function nodeIntersects(range, node) {
    var nr = document.createRange();
    nr.selectNodeContents(node);
    return (
      range.compareBoundaryPoints(Range.START_TO_END, nr) > 0 &&
      range.compareBoundaryPoints(Range.END_TO_START, nr) < 0
    );
  }
  function wrapRange(range, cls, id) {
    var root = range.commonAncestorContainer;
    if (root.nodeType === 3) root = root.parentNode;
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var targets = [], n;
    while ((n = walker.nextNode())) if (n.nodeValue.length && nodeIntersects(range, n)) targets.push(n);
    targets.forEach(function (tn) {
      var start = tn === range.startContainer ? range.startOffset : 0;
      var end = tn === range.endContainer ? range.endOffset : tn.nodeValue.length;
      if (start >= end) return;
      var mid = start > 0 ? tn.splitText(start) : tn;
      if (end - start < mid.nodeValue.length) mid.splitText(end - start);
      var span = document.createElement('span');
      span.className = cls;
      if (id != null) span.setAttribute('data-eupub-id', String(id));
      mid.parentNode.insertBefore(span, mid);
      span.appendChild(mid);
    });
  }
  function unwrap(cls) {
    var spans = document.querySelectorAll('span.' + cls);
    for (var i = 0; i < spans.length; i++) {
      var s = spans[i];
      var parent = s.parentNode;
      while (s.firstChild) parent.insertBefore(s.firstChild, s);
      parent.removeChild(s);
      parent.normalize();
    }
  }
  function applyHighlights(list) {
    unwrap('eupub-hl');
    (list || []).forEach(function (h) {
      var r = rangeFromAnchor(h.anchor);
      if (r) wrapRange(r, 'eupub-hl', h.id);
    });
  }
  function removeHighlight(id) {
    var spans = document.querySelectorAll('span.eupub-hl[data-eupub-id="' + id + '"]');
    for (var i = 0; i < spans.length; i++) {
      var s = spans[i], p = s.parentNode;
      while (s.firstChild) p.insertBefore(s.firstChild, s);
      p.removeChild(s);
      p.normalize();
    }
  }

  // In-chapter search: mark every match of `query` and scroll to the nth one.
  // Matches the (possibly reformed) on-screen text; case-sensitive when asked.
  function searchMarks(query, occurrence, caseSensitive) {
    unwrap('eupub-search');
    if (!query) return;
    var cs = !!caseSensitive;
    var q = cs ? query : query.toLowerCase();
    var fold = function (s) { return cs ? s : s.toLowerCase(); };
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        var t = node.parentElement && node.parentElement.tagName;
        if (t === 'SCRIPT' || t === 'STYLE') return NodeFilter.FILTER_REJECT;
        return fold(node.nodeValue).indexOf(q) === -1 ? NodeFilter.FILTER_SKIP : NodeFilter.FILTER_ACCEPT;
      },
    });
    var hits = [], node;
    while ((node = walker.nextNode())) {
      var text = fold(node.nodeValue);
      var from = 0, at;
      while ((at = text.indexOf(q, from)) !== -1) { hits.push({ node: node, at: at }); from = at + q.length; }
    }
    // Wrap back-to-front so earlier offsets stay valid as we split nodes.
    for (var i = hits.length - 1; i >= 0; i--) {
      var h = hits[i];
      var r = document.createRange();
      r.setStart(h.node, h.at);
      r.setEnd(h.node, h.at + q.length);
      wrapRange(r, 'eupub-search', null);
    }
    var marks = document.querySelectorAll('span.eupub-search');
    if (marks.length) {
      var idx = Math.max(0, Math.min(occurrence || 0, marks.length - 1));
      marks[idx].classList.add('eupub-search-current');
      gotoEl(marks[idx], false);
    }
    post('eupub:searchmarks', { count: marks.length });
  }

  // Persistent highlight of a clicked search hit, located by WORD INDEX (not by
  // text), since euspell reforms each word in place but keeps word order. So the
  // Nth word of the original block — recorded at search time — is the Nth word
  // here, even though it's now spelled differently.
  var WORD_RE = /[\p{L}\p{N}]+(?:['’ʼ][\p{L}\p{N}]+)*/gu;
  function wordRangeCharOffsets(text, wordStart, wordEnd) {
    WORD_RE.lastIndex = 0;
    var idx = 0, startOff = -1, endOff = -1, m;
    while ((m = WORD_RE.exec(text))) {
      if (idx === wordStart) startOff = m.index;
      if (idx === wordEnd) { endOff = m.index + m[0].length; break; }
      idx++;
    }
    if (startOff === -1) return null;
    if (endOff === -1) endOff = text.length;
    return { start: startOff, end: endOff };
  }
  function applyFind(find) {
    unwrap('eupub-find');
    if (!find || !find.path) return null;
    var block = elResolve(find.path);
    if (!block) return null;
    var off = wordRangeCharOffsets(block.textContent || '', find.wordStart, find.wordEnd);
    if (!off) return null;
    var s = resolveCharOffset(block, off.start);
    var e = resolveCharOffset(block, off.end);
    if (!s || !e) return null;
    var r = document.createRange();
    try { r.setStart(s.node, s.offset); r.setEnd(e.node, e.offset); } catch (err) { return null; }
    wrapRange(r, 'eupub-find', null);
    return document.querySelector('span.eupub-find');
  }

  // --- selection -> reader (offer to highlight) ---

  function onSelectionChange() {
    var sel = document.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim()) {
      var r = sel.getRangeAt(0);
      var rect = r.getBoundingClientRect();
      post('eupub:selection', {
        text: sel.toString(),
        anchor: anchorFromRange(r),
        rect: { x: rect.left, y: rect.top, w: rect.width, h: rect.height },
      });
    } else {
      post('eupub:selection-clear');
    }
  }

  // --- input routing ---

  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    var raw = a.getAttribute('href') || '';
    if (raw.charAt(0) === '#') { e.preventDefault(); gotoFragment(raw.slice(1)); return; }
    e.preventDefault();
    if (/^(https?:|mailto:|tel:)/i.test(raw)) post('eupub:external', { href: raw });
    else post('eupub:navigate', { href: a.href });
  }, true);

  document.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
      e.preventDefault();
      if (!nextPage()) post('eupub:key', { key: 'ArrowRight' });
    } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
      e.preventDefault();
      if (!prevPage()) post('eupub:key', { key: 'ArrowLeft' });
    }
  });

  var wheelLock = 0;
  document.addEventListener('wheel', function (e) {
    var now = Date.now();
    if (now < wheelLock) return;
    var d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (Math.abs(d) < 8) return;
    wheelLock = now + 250;
    if (d > 0) { if (!nextPage()) post('eupub:key', { key: 'ArrowRight' }); }
    else { if (!prevPage()) post('eupub:key', { key: 'ArrowLeft' }); }
  }, { passive: true });

  // Touch: a quick horizontal swipe turns the page; a tap in the left/right
  // third pages back/forward, and a center tap toggles the reader chrome. Both
  // reuse the same next/prev + edge-turn path as wheel/keys. Deferred to native
  // behavior when the gesture is a text selection (long-press) or lands on a
  // link, so highlighting and link-following still work.
  var SWIPE_MIN = 40; // px of horizontal travel that counts as a page swipe
  var TAP_MAX = 10;   // px of travel under which a touch is a tap, not a drag
  var TAP_MS = 250;   // ms under which a stationary touch is a tap
  var tsx = 0, tsy = 0, tst = 0, touchTracking = false;
  document.addEventListener('touchstart', function (e) {
    // Single-finger only — leave pinch-zoom and multi-touch alone.
    touchTracking = e.touches.length === 1;
    if (!touchTracking) return;
    var t = e.changedTouches[0];
    tsx = t.clientX; tsy = t.clientY; tst = Date.now();
  }, { passive: true });
  document.addEventListener('touchend', function (e) {
    if (!touchTracking) return;
    touchTracking = false;
    // An active selection means the user was selecting text, not paging.
    var sel = document.getSelection();
    if (sel && !sel.isCollapsed) return;
    var t = e.changedTouches[0];
    var dx = t.clientX - tsx, dy = t.clientY - tsy;
    if (Math.abs(dx) > SWIPE_MIN && Math.abs(dx) > Math.abs(dy)) {
      if (dx < 0) { if (!nextPage()) post('eupub:key', { key: 'ArrowRight' }); }
      else { if (!prevPage()) post('eupub:key', { key: 'ArrowLeft' }); }
      return;
    }
    // A tap: ignore taps on links (the click handler routes those).
    if (Math.abs(dx) < TAP_MAX && Math.abs(dy) < TAP_MAX && Date.now() - tst < TAP_MS) {
      if (e.target.closest && e.target.closest('a[href]')) return;
      var third = document.documentElement.clientWidth / 3;
      if (tsx < third) { if (!prevPage()) post('eupub:key', { key: 'ArrowLeft' }); }
      else if (tsx > 2 * third) { if (!nextPage()) post('eupub:key', { key: 'ArrowRight' }); }
      else post('eupub:toggleChrome');
    }
  }, { passive: true });
  document.addEventListener('selectionchange', debounce(onSelectionChange, 120));

  window.addEventListener('message', function (e) {
    var m = e.data || {};
    switch (m.type) {
      case 'eupub:next': if (!nextPage()) post('eupub:key', { key: 'ArrowRight' }); break;
      case 'eupub:prev': if (!prevPage()) post('eupub:key', { key: 'ArrowLeft' }); break;
      case 'eupub:setPage': goToPage(m.page, true); break;
      case 'eupub:gotoLocator': gotoLocator(m.locator, false); break;
      case 'eupub:gotoFragment': gotoFragment(m.fragment); break;
      case 'eupub:requestLocator': post('eupub:locator', { locator: currentLocator() }); break;
      case 'eupub:setHighlights': applyHighlights(m.highlights); break;
      case 'eupub:addHighlight': { var r = rangeFromAnchor(m.anchor); if (r) wrapRange(r, 'eupub-hl', m.id); break; }
      case 'eupub:removeHighlight': removeHighlight(m.id); break;
      case 'eupub:search': searchMarks(m.query, m.occurrence, m.caseSensitive); break;
      case 'eupub:clearSearch': unwrap('eupub-search'); break;
    }
  });

  window.addEventListener('resize', debounce(function () {
    measure();
    if (lastLocator) gotoLocator(lastLocator, false);
  }, 150));

  function debounce(fn, ms) {
    var t;
    return function () { clearTimeout(t); var a = arguments, self = this; t = setTimeout(function () { fn.apply(self, a); }, ms); };
  }

  // --- init: lay out, restore position, apply saved marks, announce ready ---

  function init() {
    measure();
    if (cfg.highlights) applyHighlights(cfg.highlights);
    if (cfg.startAtEnd) goToPage(pageCount - 1, false);   // paged back from next chapter
    else if (cfg.restore) gotoLocator(cfg.restore, false);
    else if (cfg.fragment) gotoFragment(cfg.fragment);
    else goToPage(0, false);
    if (cfg.flash) {
      var fe = elResolve(cfg.flash);
      if (fe) { fe.classList.add('eupub-flash'); setTimeout(function () { fe.classList.remove('eupub-flash'); }, 1600); }
    }
    if (cfg.search && cfg.search.query) searchMarks(cfg.search.query, cfg.search.occurrence, cfg.search.caseSensitive);
    if (cfg.find) {
      var hit = applyFind(cfg.find);
      if (hit) gotoEl(hit, false); // scroll to the highlighted word (overrides restore)
    }
    post('eupub:ready', { page: currentPage, pages: pageCount, locator: currentLocator() });
  }
  // Images affect layout/page count, so settle on full load — with a DOM-ready
  // first pass so a slow image can't delay interactivity indefinitely. When the
  // first pass ran before `load`, late-loading images have changed the layout:
  // re-measure and re-settle on the locator the reader is at.
  if (document.readyState === 'complete') init();
  else {
    var inited = false;
    var once = function () { if (inited) return; inited = true; init(); };
    window.addEventListener('load', function () {
      if (!inited) { once(); return; }
      measure();
      if (lastLocator) gotoLocator(lastLocator, false);
    });
    document.addEventListener('DOMContentLoaded', function () { setTimeout(once, 400); });
  }
};
