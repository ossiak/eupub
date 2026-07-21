// Populates ios/Eupub/Resources/ from the Eupub renderer + dist, the iOS analog
// of android/prepare-assets.mjs. Run before building the app (outputs are
// git-ignored, derived artifacts):
//   node ios/Eupub/prepare-assets.mjs
//
// Produces (all served over eupub://localhost by the WKURLSchemeHandler):
//   Resources/reader/{index.html, reader.js, epub.js, viewer-runtime.js,
//                     reader.css, ios-bridge.js}
//   Resources/engine/eupub-engine.mobile.js
//   Resources/lexicon.db     (on-disk SQLite lexicon, queried natively by the bridge)
//   Resources/book/…         (the sample book, PRE-EXTRACTED — Phase 1 skips a
//                             runtime unzip; pickEpub/openPath of arbitrary books
//                             comes later, with a Swift unzip)
//
// The only differences from the Android stager: the served origin is
// eupub://localhost (WKWebView can't serve virtual https), the bridge shim is
// ios-bridge.js (webkit.messageHandlers transport), and the sample is unpacked
// here rather than at runtime.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import AdmZip from 'adm-zip';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url)); // Eupub/ios/Eupub
const EUPUB = path.resolve(HERE, '..', '..');
const RENDERER = path.join(EUPUB, 'src', 'renderer');
const DIST = path.join(EUPUB, 'dist');
const EXT = path.resolve(EUPUB, '..', 'euspell_ext');
const ASSETS = path.join(HERE, 'www'); // bundled as a folder reference (structure preserved)
const READER = path.join(ASSETS, 'reader');
const ENGINE = path.join(ASSETS, 'engine');
const BOOK = path.join(ASSETS, 'book');

// Start clean so a removed source file can't linger in the bundle.
fs.rmSync(ASSETS, { recursive: true, force: true });
fs.mkdirSync(READER, { recursive: true });
fs.mkdirSync(ENGINE, { recursive: true });
fs.mkdirSync(BOOK, { recursive: true });

// 1. Reuse the renderer verbatim (the shared, host-agnostic half) + the iOS
//    bridge shim (replaces the Electron preload, as android-bridge.js does).
for (const f of ['reader.js', 'epub.js', 'viewer-runtime.js', 'reader.css', 'ios-bridge.js']) {
  fs.copyFileSync(path.join(RENDERER, f), path.join(READER, f));
}

// 2. iOS index.html: the desktop page with (a) a viewport meta so the WKWebView
//    lays out at device width (else clientWidth — which the column geometry is
//    derived from — is far wider than the screen), (b) the CSP retargeted to the
//    single custom-scheme origin, and (c) the bridge shim + host config injected
//    before the renderer scripts.
let html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
if (!html.includes('<meta charset="utf-8" />')) throw new Error('index.html: charset meta not found');
html = html.replace(
  '<meta charset="utf-8" />',
  '<meta charset="utf-8" />\n  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />'
);
const csp =
  `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; ` +
  `script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; ` +
  `img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self'" />`;
html = html.replace(/<meta http-equiv="Content-Security-Policy"[\s\S]*?\/>/, csp);
const inject =
  `<script>window.__eupubHost={origin:'eupub://localhost',mount:'/book',` +
  `engineUrl:'eupub://localhost/assets/engine/eupub-engine.mobile.js'};</script>\n` +
  `  <script src="ios-bridge.js"></script>\n` +
  `  <script src="epub.js"></script>`;
if (!html.includes('<script src="epub.js"></script>')) throw new Error('index.html: epub.js script tag not found');
html = html.replace('<script src="epub.js"></script>', inject);
fs.writeFileSync(path.join(READER, 'index.html'), html);

// 3. The lexicon-excluded engine (host injects each chapter's subset).
const engineSrc = path.join(DIST, 'eupub-engine.mobile.js');
if (!fs.existsSync(engineSrc)) {
  throw new Error('dist/eupub-engine.mobile.js missing — run "npm run build:engine:mobile" first.');
}
fs.copyFileSync(engineSrc, path.join(ENGINE, 'eupub-engine.mobile.js'));

// 4. On-disk SQLite lexicon (queried natively by the bridge, per chapter).
//    Best-effort: a chapter still renders without it, just unreformed, so a
//    lexicon build hiccup doesn't block the app from coming up.
try {
  execFileSync('node', [path.join(EXT, 'build', 'compile-lexicon-sqlite.mjs'), path.join(ASSETS, 'lexicon.db')], {
    stdio: 'inherit',
  });
} catch (e) {
  console.warn('[ios-prepare] lexicon.db build failed (chapters will render UNREFORMED):', e.message);
}

// 5. The sample book, generated then PRE-EXTRACTED into Resources/book/ so the
//    scheme handler can serve /book/… with no runtime unzip. Extraction mirrors
//    MainActivity.extractEpub's zip-slip guard.
const { makeEpub } = require(path.join(EUPUB, 'test', 'make-epub.js'));
const tmpEpub = path.join(ASSETS, '.sample.epub.tmp');
makeEpub(tmpEpub);
const zip = new AdmZip(tmpEpub);
const bookCanon = fs.realpathSync(BOOK);
for (const entry of zip.getEntries()) {
  const outFile = path.join(BOOK, entry.entryName);
  const canon = path.resolve(outFile);
  if (canon !== bookCanon && !canon.startsWith(bookCanon + path.sep)) continue; // zip-slip guard
  if (entry.isDirectory) {
    fs.mkdirSync(outFile, { recursive: true });
  } else {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, entry.getData());
  }
}
fs.rmSync(tmpEpub, { force: true });

console.log('Assets prepared in', ASSETS);
