// Plain-text (.txt) open (main-process side). Synthesizes a minimal EPUB-shaped
// book on disk from a text file — one or more XHTML chapters, a nav document, and
// an OPF — and returns the SAME shape as epub-extract's openEpub()
// ({ sourcePath, rootDir, opfDir, opfPath, opfXml }). The renderer, engine, and
// viewer then run unchanged: they only ever see a book object and chapter files.
// See docs/plain-text-support.md.
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// Bound per-chapter size so an unstructured dump still paginates in one iframe
// without stutter; also the fallback when a file has no chapter headings.
const MAX_PARAGRAPHS = 200;

/**
 * @param {string} filePath absolute path to a .txt
 * @returns {{ sourcePath: string, rootDir: string, opfDir: string, opfPath: string, opfXml: string }}
 */
function openText(filePath) {
  const raw = decodeText(fs.readFileSync(filePath))
    .replace(/^﻿/, '') // strip a BOM
    .replace(/\r\n?/g, '\n'); // normalize newlines
  const title = titleFromPath(filePath);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eupub-'));

  const chapters = splitChapters(raw);
  const files = chapters.map((_, i) => `chapter-${String(i + 1).padStart(4, '0')}.xhtml`);
  chapters.forEach((ch, i) => {
    fs.writeFileSync(path.join(rootDir, files[i]), chapterHtml(ch, title), 'utf8');
  });
  fs.writeFileSync(path.join(rootDir, 'nav.xhtml'), navXhtml(chapters, files, title), 'utf8');

  const opfXml = buildOpf(title, files, `eupub-text-${path.basename(filePath)}`);
  const opfPath = path.join(rootDir, 'content.opf');
  fs.writeFileSync(opfPath, opfXml, 'utf8');

  return { sourcePath: filePath, rootDir, opfDir: rootDir, opfPath, opfXml };
}

/** Decode a text file without assuming UTF-8: UTF-16 BOMs first (Windows
 * Notepad's historical default), then strict UTF-8, then windows-1252 — the
 * near-universal legacy 8-bit encoding — so a Latin-1-era .txt doesn't render
 * as mojibake. */
function decodeText(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return trimToEven(buf.subarray(2)).toString('utf16le');
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return Buffer.from(trimToEven(buf.subarray(2))).swap16().toString('utf16le');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder('windows-1252').decode(buf);
    } catch {
      return buf.toString('latin1'); // no ICU — close enough to 1252
    }
  }
}

/** UTF-16 needs an even byte count; drop a trailing stray byte from a
 * truncated file rather than throw in swap16/decode. */
function trimToEven(buf) {
  return buf.length % 2 ? buf.subarray(0, buf.length - 1) : buf;
}

// --- text -> chapters -------------------------------------------------------

/** Splits text into paragraphs on blank lines, joining wrapped lines with a space. */
function toParagraphs(text) {
  return text
    .split(/\n[ \t]*\n+/)
    .map((block) => block.replace(/\s*\n\s*/g, ' ').trim())
    .filter(Boolean);
}

/** A short line opening with a chapter-like word — used as a chapter boundary. */
function isHeading(block) {
  return block.length <= 80 && /^(chapter|part|book|prologue|epilogue|introduction|section)\b/i.test(block);
}

/**
 * Groups paragraphs into chapters: at chapter headings when there are ≥2, else in
 * fixed-size chunks. Each chapter is { label, blocks }.
 * @param {string} text
 * @returns {{ label: string | null, blocks: string[] }[]}
 */
function splitChapters(text) {
  const blocks = toParagraphs(text);
  const headings = blocks.map((b, i) => (isHeading(b) ? i : -1)).filter((i) => i >= 0);

  if (headings.length >= 2) {
    const chapters = [];
    if (headings[0] > 0) chapters.push({ label: 'Front Matter', blocks: blocks.slice(0, headings[0]) });
    headings.forEach((start, k) => {
      const end = k + 1 < headings.length ? headings[k + 1] : blocks.length;
      const chBlocks = blocks.slice(start, end);
      chapters.push({ label: chBlocks[0], blocks: chBlocks });
    });
    return chapters;
  }

  if (blocks.length <= MAX_PARAGRAPHS) return [{ label: null, blocks }];
  const chapters = [];
  for (let i = 0; i < blocks.length; i += MAX_PARAGRAPHS) {
    chapters.push({ label: `Section ${chapters.length + 1}`, blocks: blocks.slice(i, i + MAX_PARAGRAPHS) });
  }
  return chapters;
}

// --- synthesized files ------------------------------------------------------

/** A chapter as reflowable HTML5 (parsed as text/html by the reader). */
function chapterHtml(ch, title) {
  const body = ch.blocks
    .map((b, i) => (i === 0 && isHeading(b) ? `<h2>${esc(b)}</h2>` : `<p>${esc(b)}</p>`))
    .join('\n');
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>${esc(title)}</title></head>
<body>
${body}
</body>
</html>
`;
}

/** A well-formed XHTML nav document, so parseAsync builds a real TOC with our labels. */
function navXhtml(chapters, files, title) {
  const items = chapters
    .map((ch, i) => `<li><a href="${files[i]}">${esc(ch.label || title)}</a></li>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Contents</title></head>
<body>
<nav epub:type="toc">
<ol>
${items}
</ol>
</nav>
</body>
</html>
`;
}

/** A minimal EPUB3 OPF naming the nav and every chapter in spine order. */
function buildOpf(title, files, id) {
  const manifest = files
    .map((f, i) => `    <item id="ch${i + 1}" href="${f}" media-type="application/xhtml+xml"/>`)
    .join('\n');
  const spine = files.map((_, i) => `    <itemref idref="ch${i + 1}"/>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${esc(title)}</dc:title>
    <dc:identifier id="pub-id">${esc(id)}</dc:identifier>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
${manifest}
  </manifest>
  <spine>
${spine}
  </spine>
</package>
`;
}

// --- helpers ----------------------------------------------------------------

function titleFromPath(filePath) {
  const base = path.basename(filePath).replace(/\.[a-z0-9]+$/i, '');
  return base.replace(/[_-]+/g, ' ').trim() || 'Text';
}

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

module.exports = { openText };
