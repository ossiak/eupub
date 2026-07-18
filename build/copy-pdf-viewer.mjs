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
import { fileURLToPath } from 'node:url';
import { generateViewerHtml } from './pdf-viewer-html.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // Eupub/build
const EUPUB = path.resolve(HERE, '..');
const EXT = path.resolve(EUPUB, '..', 'euspell_ext');
const PDF = path.join(EUPUB, 'dist', 'pdf');
const PDFJS = path.join(EUPUB, 'dist', 'pdfjs');

const pdfBundle = path.join(EXT, 'dist', 'pdf-viewer.mobile.js');
if (!fs.existsSync(pdfBundle)) {
  throw new Error('euspell_ext/dist/pdf-viewer.mobile.js missing — run "npm run build:pdf:mobile" in euspell_ext first.');
}
const pdfjsSrc = path.join(EXT, 'dist', 'pdfjs');
if (!fs.existsSync(path.join(pdfjsSrc, 'pdf.worker.min.mjs'))) {
  throw new Error('euspell_ext/dist/pdfjs missing — run "npm run build:pdfjs" in euspell_ext first.');
}

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
