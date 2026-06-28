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

function makeEpub(outPath) {
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
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="css" href="style.css" media-type="text/css"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>`
  );
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
  add('OEBPS/style.css', 'body{font-family:serif}h1{color:#334}');
  // ch1 includes an href-less anchor (a link *target*, as EPUBs scatter through
  // text) and a real link, so tests can assert only real links are colored.
  add('OEBPS/ch1.xhtml', chapter('Chapter One', 'The <a id="anchortarget">people</a> thought they could read through the <a href="ch2.xhtml">rough</a> night before the action. <span class="probe">hover probe</span>'));
  add('OEBPS/ch2.xhtml', chapter('Chapter Two', 'Enough laughter brought the daughter through the bough.'));

  const file = outPath || path.join(os.tmpdir(), `eupub-sample-${Date.now()}.epub`);
  zip.writeZip(file);
  return file;
}

module.exports = { makeEpub };

if (require.main === module) {
  console.log(makeEpub(process.argv[2]));
}
