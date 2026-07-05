// Populates app/src/main/assets/ from the Eupub renderer + dist. Run before
// building the APK (the outputs are git-ignored, derived artifacts):
//   node prepare-assets.mjs
//
// Produces:
//   assets/reader/{index.html, reader.js, epub.js, viewer-runtime.js,
//                  reader.css, android-bridge.js}
//   assets/engine/eupub-engine.mobile.js
//   assets/lexicon.db      (on-disk SQLite lexicon, queried natively by the bridge)
//   assets/sample.epub     (bundled first-launch book)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url)); // Eupub/android
const EUPUB = path.resolve(HERE, '..');
const RENDERER = path.join(EUPUB, 'src', 'renderer');
const DIST = path.join(EUPUB, 'dist');
const EXT = path.resolve(EUPUB, '..', 'euspell_ext');
const ASSETS = path.join(HERE, 'app', 'src', 'main', 'assets');
const READER = path.join(ASSETS, 'reader');
const ENGINE = path.join(ASSETS, 'engine');

fs.mkdirSync(READER, { recursive: true });
fs.mkdirSync(ENGINE, { recursive: true });

// 1. Reuse the renderer verbatim (the shared, host-agnostic half).
for (const f of ['reader.js', 'epub.js', 'viewer-runtime.js', 'reader.css', 'android-bridge.js']) {
  fs.copyFileSync(path.join(RENDERER, f), path.join(READER, f));
}

// 2. Android index.html: the desktop page with (a) the CSP retargeted to the
//    single virtual origin, and (b) the bridge shim + host config injected
//    before the renderer scripts (in place of the Electron preload).
let html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
const csp =
  `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; ` +
  `script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; ` +
  `img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self'" />`;
html = html.replace(/<meta http-equiv="Content-Security-Policy"[\s\S]*?\/>/, csp);
const inject =
  `<script>window.__eupubHost={origin:'https://eupub.local',mount:'/book',` +
  `engineUrl:'https://eupub.local/assets/engine/eupub-engine.mobile.js'};</script>\n` +
  `  <script src="android-bridge.js"></script>\n` +
  `  <script src="epub.js"></script>`;
if (!html.includes('<script src="epub.js"></script>')) throw new Error('index.html: epub.js script tag not found');
html = html.replace('<script src="epub.js"></script>', inject);
fs.writeFileSync(path.join(READER, 'index.html'), html);

// 3. The lexicon-excluded engine (host injects each chapter's subset).
const engineSrc = path.join(DIST, 'eupub-engine.mobile.js');
if (!fs.existsSync(engineSrc)) {
  throw new Error('dist/eupub-engine.mobile.js missing — run "npm run build:engine:mobile" in Eupub first.');
}
fs.copyFileSync(engineSrc, path.join(ENGINE, 'eupub-engine.mobile.js'));

// 4. On-disk SQLite lexicon (queried natively by the bridge, per chapter).
execFileSync('node', [path.join(EXT, 'build', 'compile-lexicon-sqlite.mjs'), path.join(ASSETS, 'lexicon.db')], {
  stdio: 'inherit',
});

// 5. A bundled sample book so the first launch shows something.
const { makeEpub } = require(path.join(EUPUB, 'test', 'make-epub.js'));
makeEpub(path.join(ASSETS, 'sample.epub'));

console.log('Assets prepared in', ASSETS);
