// EPUB extraction (main-process side). Unzips a book to a fresh temp directory
// and locates its OPF package file. Shared by main.js and the test harness so
// both exercise the exact same code path.
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const AdmZip = require('adm-zip');

/**
 * @param {string} filePath absolute path to a .epub
 * @returns {{ sourcePath: string, rootDir: string, opfDir: string, opfPath: string, opfXml: string }}
 */
function openEpub(filePath) {
  const zip = new AdmZip(filePath);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eupub-'));
  zip.extractAllTo(rootDir, /* overwrite */ true);

  // META-INF/container.xml names the OPF via a <rootfile full-path="...">
  // (either quote style; the first rootfile is the default rendition).
  const containerXml = fs.readFileSync(path.join(rootDir, 'META-INF', 'container.xml'), 'utf8');
  const match = containerXml.match(/<rootfile\b[^>]*\bfull-path\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
  const rel = match && (match[1] || match[2]);
  if (!rel) throw new Error('Invalid EPUB: no rootfile in META-INF/container.xml');

  // full-path is a URL, so it may be percent-encoded; it must also stay inside
  // the extraction dir (a hostile "../…" would point the reader elsewhere).
  let decoded = rel;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    /* not percent-encoded */
  }
  const opfPath = path.resolve(rootDir, decoded);
  if (opfPath !== rootDir && !opfPath.startsWith(rootDir + path.sep)) {
    throw new Error('Invalid EPUB: rootfile path escapes the archive');
  }
  return {
    sourcePath: filePath,
    rootDir,
    opfDir: path.dirname(opfPath),
    opfPath,
    opfXml: fs.readFileSync(opfPath, 'utf8'),
  };
}

module.exports = { openEpub };
