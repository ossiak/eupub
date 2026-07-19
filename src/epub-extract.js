// EPUB extraction (main-process side). Unzips a book to a fresh temp directory
// and locates its OPF package file. Shared by main.js and the test harness so
// both exercise the exact same code path.
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const AdmZip = require('adm-zip');

// Extraction budget: real books are tens of MB uncompressed; a zip bomb claims
// (and would expand to) orders of magnitude more. Checked against the entry
// headers before anything is written, and adm-zip sizes each entry's inflate
// buffer from the same headers, so the claimed total bounds what extraction
// can produce.
const MAX_EXTRACT_BYTES = 512 * 1024 * 1024;

/**
 * Async: decompression runs on libuv's threadpool (adm-zip's extractAllToAsync
 * uses zlib's async inflate), so a large book doesn't freeze the main process.
 * @param {string} filePath absolute path to a .epub
 * @returns {Promise<{ sourcePath: string, rootDir: string, opfDir: string, opfPath: string, opfXml: string }>}
 */
async function openEpub(filePath) {
  const zip = new AdmZip(filePath);
  let claimed = 0;
  for (const entry of zip.getEntries()) {
    claimed += entry.header.size;
    if (claimed > MAX_EXTRACT_BYTES) {
      throw new Error(`Invalid EPUB: uncompressed size exceeds ${MAX_EXTRACT_BYTES / (1024 * 1024)} MB`);
    }
  }
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eupub-'));
  try {
    await new Promise((resolve, reject) => {
      zip.extractAllToAsync(rootDir, /* overwrite */ true, /* keepOriginalPermission */ false, (err) =>
        err ? reject(err) : resolve()
      );
    });

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
  } catch (err) {
    // Don't leave a half-extracted dir behind for the stale sweep to find.
    try {
      fs.rmSync(rootDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    throw err;
  }
}

module.exports = { openEpub };
