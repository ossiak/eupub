// EPUB model — parses the OPF package and the navigation document into a flat
// spine (reading order) and a table of contents. Runs in the renderer, so it
// uses DOMParser. Pure data only; no DOM rendering here.
//
// Exposes window.EupubModel = { parse(book) }, where `book` is the object the
// main process returns from openEpub().
(function () {
  'use strict';

  const xml = new DOMParser();

  /**
   * @param {{ opfDir: string, opfXml: string }} book
   * @param {Document} [opfDoc] already-parsed OPF, so callers that also need the
   *   nav/ncx items (parseAsync) parse the package document only once
   * @returns {{ title: string, identifier: string, spine: SpineItem[], toc: TocEntry[] }}
   */
  function parse(book, opfDoc) {
    const doc = opfDoc || xml.parseFromString(book.opfXml, 'application/xml');
    const pkg = doc.documentElement;

    const title =
      text(doc.querySelector('metadata > title, metadata title')) || 'Untitled';

    // dc:identifier — a stable key for per-book saved state (position,
    // bookmarks, highlights) that survives the file being moved or renamed.
    // Prefer the identifier the package names via unique-identifier (books
    // often carry several — ISBN and UUID — and OPF order is not stable);
    // fall back to the first one.
    let identifier = '';
    const uidId = pkg.getAttribute('unique-identifier');
    if (uidId) {
      for (const el of doc.querySelectorAll('metadata identifier')) {
        if (el.getAttribute('id') === uidId) { identifier = text(el); break; }
      }
    }
    if (!identifier) identifier = text(doc.querySelector('metadata > identifier, metadata identifier')) || '';

    // Manifest: id -> { href (relative), absPath, mediaType, properties }.
    const manifest = new Map();
    for (const item of doc.querySelectorAll('manifest > item')) {
      const id = item.getAttribute('id');
      const href = item.getAttribute('href');
      if (!id || !href) continue;
      manifest.set(id, {
        id,
        href,
        absPath: resolve(book.opfDir, href),
        mediaType: item.getAttribute('media-type') || '',
        properties: item.getAttribute('properties') || '',
      });
    }

    // Spine: ordered itemrefs -> documents to render.
    /** @type {SpineItem[]} */
    const spine = [];
    for (const ref of doc.querySelectorAll('spine > itemref')) {
      const idref = ref.getAttribute('idref');
      const entry = idref && manifest.get(idref);
      if (!entry) continue;
      spine.push({
        id: entry.id,
        href: entry.href,
        absPath: entry.absPath,
        linear: ref.getAttribute('linear') !== 'no',
      });
    }

    // parse() is synchronous, so it can only build the spine-derived TOC. The
    // real nav/ncx TOC needs to read another file (async IPC) — parseAsync()
    // upgrades model.toc once that read resolves.
    return { title, identifier, spine, toc: tocFromSpine(spine) };
  }

  // --- Fallback: derive a flat TOC from the spine ----------------------

  // spineIndex must index `spine` itself — the reader looks the entry up there.
  // Capture it BEFORE dropping the non-linear items: mapping over the filtered
  // array numbered the survivors 0,1,2…, so a single linear="no" item anywhere
  // shifted every later entry one slot early (its TOC row opened the document
  // before the one it names).
  function tocFromSpine(spine) {
    return spine
      .map((s, i) => ({ item: s, index: i }))
      .filter(({ item }) => item.linear)
      .map(({ item, index }) => ({
        label: prettyName(item.href),
        absPath: item.absPath,
        fragment: '',
        spineIndex: index,
        depth: 1,
      }));
  }

  /**
   * Async companion that reads the nav/ncx file (over IPC) and builds a real
   * TOC, falling back to the spine-derived one. Call this instead of parse()
   * when you can await.
   * @param {{ opfDir: string, opfXml: string }} book
   */
  async function parseAsync(book) {
    const opfDoc = xml.parseFromString(book.opfXml, 'application/xml');
    const model = parse(book, opfDoc);

    const navItem = findNavItem(book, opfDoc);
    if (navItem) {
      try {
        const html = await window.eupub.readText(navItem.absPath);
        const toc = buildNavToc(html, navItem.dir, book, model.spine);
        // Only a usable nav TOC ends the lookup — a nav that is missing,
        // malformed (XHTML parse error), or empty still falls through to NCX.
        if (toc && toc.length) {
          model.toc = toc;
          return model;
        }
      } catch {
        /* fall through to ncx */
      }
    }

    const ncx = findNcxItem(book, opfDoc);
    if (ncx) {
      try {
        const text = await window.eupub.readText(ncx.absPath);
        const toc = buildNcxToc(text, ncx.dir, book, model.spine);
        if (toc && toc.length) model.toc = toc;
      } catch {
        /* fall through */
      }
    }
    return model;
  }

  // `properties` is a space-separated token list, so it must be matched a token
  // at a time. A substring test (/\bnav\b/) also fired on a hyphenated or
  // prefixed token — "nav-doc", "ibooks:nav" — because "-" and ":" are word
  // boundaries; per spec those are different properties, not the nav. Since
  // findNavItem takes the FIRST match, one such item earlier in the manifest
  // won over the real nav document and the book fell back to a filename TOC.
  function hasProperty(item, name) {
    return (item.getAttribute('properties') || '').split(/\s+/).includes(name);
  }

  function findNavItem(book, doc) {
    for (const item of doc.querySelectorAll('manifest > item')) {
      if (hasProperty(item, 'nav') && item.getAttribute('href')) {
        const abs = resolve(book.opfDir, item.getAttribute('href'));
        return { absPath: abs, dir: window.eupub.dirname(abs) };
      }
    }
    return null;
  }

  function findNcxItem(book, doc) {
    const tocId = doc.querySelector('spine')?.getAttribute('toc');
    const item = tocId
      ? doc.querySelector(`manifest > item[id="${cssEscape(tocId)}"]`)
      : doc.querySelector('manifest > item[media-type="application/x-dtbncx+xml"]');
    if (!item || !item.getAttribute('href')) return null;
    const abs = resolve(book.opfDir, item.getAttribute('href'));
    return { absPath: abs, dir: window.eupub.dirname(abs) };
  }

  function buildNavToc(html, navDir, book, spine) {
    const doc = xml.parseFromString(html, 'application/xhtml+xml');
    // Prefer the toc nav; otherwise the first <nav> with a list.
    const navs = [...doc.querySelectorAll('nav')];
    const tocNav =
      navs.find((n) => /toc/i.test(n.getAttribute('epub:type') || n.getAttribute('type') || '')) ||
      navs.find((n) => n.querySelector('ol, ul')) ||
      doc.querySelector('body');
    if (!tocNav) return null;

    const out = [];
    walkList(tocNav.querySelector('ol, ul'), 1);
    return out;

    function walkList(list, depth) {
      if (!list) return;
      for (const li of list.children) {
        if (li.tagName.toLowerCase() !== 'li') continue;
        const a = li.querySelector(':scope > a, :scope > span > a');
        if (a) {
          const { absPath, fragment } = hrefToPath(a.getAttribute('href'), navDir);
          out.push(makeEntry(label(a), absPath, fragment, depth, spine));
        }
        walkList(li.querySelector(':scope > ol, :scope > ul'), depth + 1);
      }
    }
  }

  function buildNcxToc(xmlText, ncxDir, book, spine) {
    const doc = xml.parseFromString(xmlText, 'application/xml');
    const map = doc.querySelector('navMap');
    if (!map) return null;
    const out = [];
    walkPoints(map, 1);
    return out;

    function walkPoints(parent, depth) {
      for (const np of childrenByTag(parent, 'navPoint')) {
        const labelEl = np.querySelector('navLabel > text');
        const src = np.querySelector('content')?.getAttribute('src') || '';
        const { absPath, fragment } = hrefToPath(src, ncxDir);
        out.push(makeEntry(textOf(labelEl), absPath, fragment, depth, spine));
        walkPoints(np, depth + 1);
      }
    }
  }

  // --- helpers --------------------------------------------------------

  function makeEntry(labelText, absPath, fragment, depth, spine) {
    const spineIndex = spine.findIndex((s) => s.absPath === absPath);
    return {
      label: labelText || prettyName(absPath),
      absPath,
      fragment,
      spineIndex: spineIndex === -1 ? null : spineIndex,
      depth: Math.min(depth, 3),
    };
  }

  function hrefToPath(href, baseDir) {
    if (!href) return { absPath: '', fragment: '' };
    const hashAt = href.indexOf('#');
    // Decoded like the file part below: fragments in nav/NCX hrefs may be
    // percent-encoded, but they're matched against raw ids (getElementById).
    const fragment = hashAt === -1 ? '' : safeDecode(href.slice(hashAt + 1));
    const file = hashAt === -1 ? href : href.slice(0, hashAt);
    // A TOC entry pointing at a remote URL (legal in a nav, rare) has no local
    // file to open — leave it label-only (no absPath → no spine match → not
    // clickable) rather than path.join the URL into a nonsense path.
    if (/^[a-z][a-z0-9+.-]*:/i.test(file)) return { absPath: '', fragment };
    return { absPath: resolve(baseDir, file), fragment };
  }

  function resolve(baseDir, href) {
    return window.eupub.join(baseDir, safeDecode(href));
  }

  // Manifest/TOC hrefs should be percent-encoded URLs, but real EPUBs contain
  // literal "%" in filenames — decodeURIComponent would throw and abort the
  // whole book load, so fall back to the raw string.
  function safeDecode(s) {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  }

  function childrenByTag(parent, tag) {
    return [...parent.children].filter((c) => c.tagName.toLowerCase() === tag.toLowerCase());
  }

  function label(a) {
    return (a.textContent || '').replace(/\s+/g, ' ').trim();
  }
  function textOf(el) {
    return el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '';
  }
  function text(el) {
    return el ? (el.textContent || '').trim() : '';
  }
  function prettyName(p) {
    const base = (p.split(/[\\/]/).pop() || p).replace(/\.[a-z0-9]+$/i, '');
    return safeDecode(base).replace(/[_-]+/g, ' ').trim() || 'Section';
  }
  function cssEscape(s) {
    return s.replace(/["\\]/g, '\\$&');
  }

  window.EupubModel = { parse, parseAsync };
})();
