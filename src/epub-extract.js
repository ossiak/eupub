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

  // META-INF/container.xml names the OPF via a <rootfile full-path="...">.
  const containerXml = fs.readFileSync(path.join(rootDir, 'META-INF', 'container.xml'), 'utf8');
  const match = containerXml.match(/full-path\s*=\s*"([^"]+)"/i);
  if (!match) throw new Error('Invalid EPUB: no rootfile in META-INF/container.xml');

  const opfPath = path.join(rootDir, match[1]);
  return {
    sourcePath: filePath,
    rootDir,
    opfDir: path.dirname(opfPath),
    opfPath,
    opfXml: fs.readFileSync(opfPath, 'utf8'),
  };
}

module.exports = { openEpub };
