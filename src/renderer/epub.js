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
   * @returns {{ title: string, spine: SpineItem[], toc: TocEntry[] }}
   */
  function parse(book) {
    const doc = xml.parseFromString(book.opfXml, 'application/xml');
    const pkg = doc.documentElement;

    const title =
      text(doc.querySelector('metadata > title, metadata title')) || 'Untitled';

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
    return { title, spine, toc: tocFromSpine(spine) };
  }

  // --- Fallback: derive a flat TOC from the spine ----------------------

  function tocFromSpine(spine) {
    return spine
      .filter((s) => s.linear)
      .map((s, i) => ({
        label: prettyName(s.href),
        absPath: s.absPath,
        fragment: '',
        spineIndex: i,
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
    const model = parse(book);

    const navItem = findNavItem(book);
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

    const ncx = findNcxItem(book);
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

  function findNavItem(book) {
    const doc = xml.parseFromString(book.opfXml, 'application/xml');
    for (const item of doc.querySelectorAll('manifest > item')) {
      if (/\bnav\b/.test(item.getAttribute('properties') || '') && item.getAttribute('href')) {
        const abs = resolve(book.opfDir, item.getAttribute('href'));
        return { absPath: abs, dir: window.eupub.dirname(abs) };
      }
    }
    return null;
  }

  function findNcxItem(book) {
    const doc = xml.parseFromString(book.opfXml, 'application/xml');
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
        const a = li.querySelector(':scope > a, :scope > span > a, :scope > a[href]');
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
    const fragment = hashAt === -1 ? '' : href.slice(hashAt + 1);
    const file = hashAt === -1 ? href : href.slice(0, hashAt);
    return { absPath: resolve(baseDir, file), fragment };
  }

  function resolve(baseDir, href) {
    return window.eupub.join(baseDir, decodeURIComponent(href));
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
    return decodeURIComponent(base).replace(/[_-]+/g, ' ').trim() || 'Section';
  }
  function cssEscape(s) {
    return s.replace(/["\\]/g, '\\$&');
  }

  window.EupubModel = { parse, parseAsync };
})();
