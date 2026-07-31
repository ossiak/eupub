// Builds a minimal but valid EPUB 3 (nav-based TOC, two chapters, a stylesheet)
// for the pipeline test. Returns the path to the written .epub.
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const AdmZip = require('adm-zip');

function chapter(title, body) {
  // The inline rules emulate book CSS that recolors anchors/elements on hover —
  // the reader must stop href-less anchors (link targets) from reacting, while a
  // non-anchor .probe confirms hover works at all. teal = rgb(0,128,128).
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>${title}</title><link rel="stylesheet" type="text/css" href="style.css"/>
<style>a:hover{color:rgb(0,128,128)} .probe:hover{color:rgb(0,128,128)}</style></head>
<body><h1>${title}</h1><p>${body}</p></body>
</html>`;
}

/**
 * @param {string} [outPath]
 * @param {{ nonLinear?: boolean, nav?: boolean }} [opts]
 *   nonLinear — bracket ch2 with two `linear="no"` documents (EPUB3 pop-up
 *     footnotes): one between the chapters, one trailing. ch1 gains a link to
 *     the first, since non-linear content is reached by link, not by paging.
 *   nav — include the nav document (default true). Pass false to exercise the
 *     spine-derived TOC fallback.
 * Defaults reproduce the original two-chapter book exactly, so the tests that
 * already use this fixture are unaffected.
 */
function makeEpub(outPath, opts = {}) {
  const nonLinear = !!opts.nonLinear;
  const withNav = opts.nav !== false;
  const zip = new AdmZip();
  const add = (name, text) => zip.addFile(name, Buffer.from(text, 'utf8'));

  add('mimetype', 'application/epub+zip');
  add(
    'META-INF/container.xml',
    `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`
  );
  add(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Eupub Test Book</dc:title>
    <dc:language>en</dc:language>
    <dc:identifier id="bookid">urn:uuid:eupub-test-0001</dc:identifier>
  </metadata>
  <manifest>
${withNav ? '    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>\n' : ''}    <item id="css" href="style.css" media-type="text/css"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
${nonLinear ? '    <item id="notea" href="notea.xhtml" media-type="application/xhtml+xml"/>\n    <item id="noteb" href="noteb.xhtml" media-type="application/xhtml+xml"/>\n' : ''}  </manifest>
  <spine>
    <itemref idref="ch1"/>
${nonLinear ? '    <itemref idref="notea" linear="no"/>\n' : ''}    <itemref idref="ch2"/>
${nonLinear ? '    <itemref idref="noteb" linear="no"/>\n' : ''}  </spine>
</package>`
  );
  if (withNav) {
    add(
      'OEBPS/nav.xhtml',
      `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Contents</title></head>
<body>
  <nav epub:type="toc" id="toc">
    <ol>
      <li><a href="ch1.xhtml">Chapter One</a></li>
      <li><a href="ch2.xhtml">Chapter Two</a></li>
    </ol>
  </nav>
</body>
</html>`
    );
  }
  add('OEBPS/style.css', 'body{font-family:serif}h1{color:#334}');
  // ch1 includes an href-less anchor (a link *target*, as EPUBs scatter through
  // text) and a real link, so tests can assert only real links are colored.
  const ch1Body =
    'The <a id="anchortarget">people</a> thought they could read through the <a href="ch2.xhtml">rough</a> night before the action. <span class="probe">hover probe</span>' +
    (nonLinear ? ' <a id="notelink" href="notea.xhtml">see note</a>' : '');
  add('OEBPS/ch1.xhtml', chapter('Chapter One', ch1Body));
  add('OEBPS/ch2.xhtml', chapter('Chapter Two', 'Enough laughter brought the daughter through the bough.'));
  if (nonLinear) {
    // Nonsense proper nouns: not in the lexicon, so they survive euspell
    // conversion verbatim and a test can match on them exactly.
    add('OEBPS/notea.xhtml', chapter('Zarquon', 'Zarquon is the first pop-up note.'));
    add('OEBPS/noteb.xhtml', chapter('Wibble', 'Wibble is the trailing pop-up note.'));
  }

  const file = outPath || path.join(os.tmpdir(), `eupub-sample-${Date.now()}.epub`);
  zip.writeZip(file);
  return file;
}

module.exports = { makeEpub };

if (require.main === module) {
  console.log(makeEpub(process.argv[2]));
}
