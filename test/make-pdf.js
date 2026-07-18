// Builds a minimal but valid PDF for the Android PDF viewer's first-launch
// sample. Returns the path to the written .pdf.
//
// Hand-assembled rather than pulled from a library: the whole file is a few
// hundred bytes of ASCII, and a dependency would have to be justified to both
// repos. It uses Helvetica — a PDF standard-14 font, deliberately NOT embedded —
// so rendering it exercises PDF.js's standardFontDataUrl path.
//
// WHAT IT DOES NOT TEST: embedded fonts, and the JBIG2/JPEG2000/colour-management
// wasm decoders. A real-world PDF is needed for those; drop one in
// android/fixtures/ and prepare-assets.mjs will ship it alongside this sample.
const fs = require('node:fs');

// Prose carrying words with known euspell reforms, so a glance at the rendered
// page says whether reforming ran: people -> peeple, thought -> thoht.
const LINES = [
  'The people thought the rough cough could be tough.',
  'Through thorough thought, the people brought enough.',
  'Eupub renders this page, then reforms the text layer.',
];

/** Escape a PDF literal string: backslash and both parens are the only specials. */
function pdfString(s) {
  return s.replace(/([\\()])/g, '\\$1');
}

function contentStream(pageNum, total) {
  const lines = [
    'BT',
    '/F1 16 Tf',
    '72 720 Td',
    '20 TL',
    // ASCII only: the file is assembled as latin1 bytes, so a smart dash or
    // curly quote here would silently mangle rather than fail.
    `(Euspell sample - page ${pageNum} of ${total}) Tj`,
    'T*',
    'T*',
  ];
  for (const line of LINES) lines.push(`(${pdfString(line)}) Tj`, 'T*');
  lines.push('ET');
  return lines.join('\n');
}

/**
 * Write a minimal multi-page PDF.
 * @param {string} outPath
 * @param {{ pages?: number }} [opts]
 * @returns {string} outPath
 */
function makePdf(outPath, { pages = 3 } = {}) {
  // Object numbering: 1 catalog, 2 page tree, 3 font, then a page object and a
  // content stream per page.
  const pageObjNum = (i) => 4 + i * 2;
  const contentObjNum = (i) => 5 + i * 2;

  /** @type {Map<number, string>} */
  const objects = new Map();

  const kids = Array.from({ length: pages }, (_, i) => `${pageObjNum(i)} 0 R`).join(' ');
  objects.set(1, '<< /Type /Catalog /Pages 2 0 R >>');
  objects.set(2, `<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`);
  objects.set(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');

  for (let i = 0; i < pages; i++) {
    objects.set(
      pageObjNum(i),
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
        `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObjNum(i)} 0 R >>`
    );
    const stream = contentStream(i + 1, pages);
    objects.set(
      contentObjNum(i),
      `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`
    );
  }

  // Assemble, recording each object's byte offset for the xref table. The xref
  // is why this is built as bytes rather than concatenated strings: every offset
  // must be exact or the file is unopenable.
  const chunks = [];
  let offset = 0;
  const push = (s) => {
    const b = Buffer.from(s, 'latin1');
    chunks.push(b);
    offset += b.length;
  };

  push('%PDF-1.4\n');
  // A binary comment marks the file as binary for tools that sniff it.
  push('%\xE2\xE3\xCF\xD3\n');

  /** @type {Map<number, number>} */
  const offsets = new Map();
  const nums = [...objects.keys()].sort((a, b) => a - b);
  for (const n of nums) {
    offsets.set(n, offset);
    push(`${n} 0 obj\n${objects.get(n)}\nendobj\n`);
  }

  const xrefOffset = offset;
  const size = nums.length + 1; // +1 for the free object 0
  // Each xref entry is exactly 20 bytes: 10-digit offset, gen, type, 2-byte EOL.
  let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (const n of nums) {
    xref += `${String(offsets.get(n)).padStart(10, '0')} 00000 n \n`;
  }
  push(xref);
  push(`trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  fs.writeFileSync(outPath, Buffer.concat(chunks));
  return outPath;
}

module.exports = { makePdf };
