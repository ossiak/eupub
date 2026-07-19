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
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateViewerHtml } from './pdf-viewer-html.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // Eupub/build
const EUPUB = path.resolve(HERE, '..');
const EXT = path.resolve(EUPUB, '..', 'euspell_ext');
const PDF = path.join(EUPUB, 'dist', 'pdf');
const PDFJS = path.join(EUPUB, 'dist', 'pdfjs');

/** Build a missing euspell_ext artifact in the sibling checkout instead of
 * bouncing the user over there by hand (a fresh clone hits this on the first
 * `npm run build`). */
function ensureExtArtifact(artifact, script) {
  if (fs.existsSync(artifact)) return;
  if (!fs.existsSync(EXT)) {
    throw new Error(`sibling euspell_ext checkout not found at ${EXT} — clone it next to Eupub.`);
  }
  console.log(`${path.relative(EUPUB, artifact)} missing — running "npm run ${script}" in euspell_ext…`);
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', script], { cwd: EXT, stdio: 'inherit' });
  if (!fs.existsSync(artifact)) {
    throw new Error(`${artifact} still missing after "npm run ${script}" in euspell_ext.`);
  }
}

const pdfBundle = path.join(EXT, 'dist', 'pdf-viewer.mobile.js');
ensureExtArtifact(pdfBundle, 'build:pdf:mobile');
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
