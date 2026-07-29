// Populates dist/pdf/ and dist/pdfjs/ with the embedded PDF viewer for the
// DESKTOP app, from the sibling euspell_ext checkout — the desktop analog of
// what android/prepare-assets.mjs does for the APK's assets/. The main process
// serves these over app://eupub/assets/... (see the protocol handler in
// src/main.js); the same relative layout as Android (pdf/viewer.html beside
// pdfjs/) is what lets host.mobile.js's location-relative assetURL work
// unchanged on both.
//
//   dist/pdf/{viewer.html, viewer.css, pdf-viewer.mobile.js, desktop-pdf-bridge.js}
//   dist/pdfjs/{pdf.worker.min.mjs, wasm/*, standard_fonts/*}
//
// Run: npm run build:pdf   (or as part of npm run build)
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateViewerHtml } from './pdf-viewer-html.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // Eupub/build
const EUPUB = path.resolve(HERE, '..');
const EXT = path.resolve(EUPUB, '..', 'euspell_ext');
const PDF = path.join(EUPUB, 'dist', 'pdf');
const PDFJS = path.join(EUPUB, 'dist', 'pdfjs');

/** The newest mtime of any file under `dir`, or 0 when it does not exist. */
function newestMtime(dir) {
  let newest = 0;
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else newest = Math.max(newest, fs.statSync(p).mtimeMs);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return newest;
}

/** Build a missing OR STALE euspell_ext artifact in the sibling checkout instead
 * of bouncing the user over there by hand (a fresh clone hits this on the first
 * `npm run build`).
 *
 * Staleness matters as much as absence. euspell_ext/dist is gitignored, so its
 * bundles survive across engine changes, and an existence check alone silently
 * shipped a PDF viewer built before those changes — the engine bundle beside it
 * was fresh, because rollup rebuilds that on every run, which made the mismatch
 * easy to miss. Rebuild whenever any source it is built from is newer.
 *
 * @param {string} artifact     the built file in euspell_ext/dist
 * @param {string} script       the euspell_ext npm script that produces it
 * @param {string[]} [sources]  directories whose contents the artifact is built from
 */
function ensureExtArtifact(artifact, script, sources = []) {
  const builtAt = fs.existsSync(artifact) ? fs.statSync(artifact).mtimeMs : -1;
  const stale = builtAt < 0 || sources.some((dir) => newestMtime(dir) > builtAt);
  if (!stale) return;
  if (!fs.existsSync(EXT)) {
    throw new Error(`sibling euspell_ext checkout not found at ${EXT} — clone it next to Eupub.`);
  }
  const why = builtAt < 0 ? 'missing' : 'older than euspell_ext/src';
  console.log(`${path.relative(EUPUB, artifact)} ${why} — running "npm run ${script}" in euspell_ext…`);
  // execSync, not execFileSync: on Windows npm is npm.cmd, and since Node
  // 18.20/20.12 (CVE-2024-27980) spawning a .cmd without a shell throws EINVAL.
  // Going through the shell resolves it on both platforms, and `script` is a
  // literal from the call sites below, so there is nothing to escape.
  execSync(`npm run ${script}`, { cwd: EXT, stdio: 'inherit' });
  if (!fs.existsSync(artifact)) {
    throw new Error(`${artifact} still missing after "npm run ${script}" in euspell_ext.`);
  }
}

const pdfBundle = path.join(EXT, 'dist', 'pdf-viewer.mobile.js');
// The viewer bundles src/pdf plus the engine it imports from src/content and
// src/disambig, so the whole of src/ is its input.
ensureExtArtifact(pdfBundle, 'build:pdf:mobile', [path.join(EXT, 'src')]);
const pdfjsSrc = path.join(EXT, 'dist', 'pdfjs');
ensureExtArtifact(path.join(pdfjsSrc, 'pdf.worker.min.mjs'), 'build:pdfjs');

fs.mkdirSync(PDF, { recursive: true });
fs.copyFileSync(pdfBundle, path.join(PDF, 'pdf-viewer.mobile.js'));
fs.copyFileSync(path.join(EXT, 'src', 'pdf', 'viewer.css'), path.join(PDF, 'viewer.css'));
fs.copyFileSync(path.join(EUPUB, 'src', 'desktop-pdf-bridge.js'), path.join(PDF, 'desktop-pdf-bridge.js'));
fs.writeFileSync(
  path.join(PDF, 'viewer.html'),
  generateViewerHtml(EXT, ['<script src="desktop-pdf-bridge.js"></script>'])
);

fs.rmSync(PDFJS, { recursive: true, force: true }); // never leave a stale worker behind
fs.cpSync(pdfjsSrc, PDFJS, { recursive: true });

console.log('PDF viewer assets prepared in dist/pdf and dist/pdfjs');
