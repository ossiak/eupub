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
//   Resources/sample.epub    (bundled first-launch book; the app unzips it into
//                             its container on first open, the SAME path a
//                             user-picked book takes)
//
// The only differences from the Android stager: the served origin is
// eupub://localhost (WKWebView can't serve virtual https) and the bridge shim is
// ios-bridge.js (webkit.messageHandlers transport).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url)); // Eupub/ios/Eupub
const EUPUB = path.resolve(HERE, '..', '..');
const RENDERER = path.join(EUPUB, 'src', 'renderer');
const DIST = path.join(EUPUB, 'dist');
const EXT = path.resolve(EUPUB, '..', 'euspell_ext');
const ASSETS = path.join(HERE, 'www'); // bundled as a folder reference (structure preserved)
const READER = path.join(ASSETS, 'reader');
const ENGINE = path.join(ASSETS, 'engine');

// Start clean so a removed source file can't linger in the bundle.
fs.rmSync(ASSETS, { recursive: true, force: true });
fs.mkdirSync(READER, { recursive: true });
fs.mkdirSync(ENGINE, { recursive: true });

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

// 5. The sample book (the .epub itself). The app unzips it into its container on
//    first open, exactly as it will for user-picked books, so the sample and
//    real books share one extraction path (Bridge.extractEpub).
const { makeEpub } = require(path.join(EUPUB, 'test', 'make-epub.js'));
makeEpub(path.join(ASSETS, 'sample.epub'));

// 6. Version.xcconfig, so the bundle version comes from package.json like every
//    other build's does. project.yml is static YAML and cannot read a file, so
//    the numbers arrive as build settings the generated Info.plist substitutes.
//    Written here rather than committed because it is derived; run.sh stages
//    assets before xcodegen, so it always exists by the time the project needs
//    it. CFBundleVersion must rise per upload within one version string — bump
//    BUILD_OFFSET (not package.json) when resubmitting the same version.
const version = JSON.parse(fs.readFileSync(path.join(EUPUB, 'package.json'), 'utf8')).version;
const parts = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
if (!parts) throw new Error(`package.json version '${version}' is not major.minor.patch`);
const BUILD_OFFSET = 0;
const [major, minor, patch] = parts.slice(1).map(Number);
const build = major * 10000 + minor * 100 + patch + BUILD_OFFSET;
fs.writeFileSync(
  path.join(HERE, 'Version.xcconfig'),
  `// Generated by prepare-assets.mjs from Eupub/package.json — do not edit.\n` +
    `MARKETING_VERSION = ${version}\n` +
    `CURRENT_PROJECT_VERSION = ${build}\n`,
);

console.log('Assets prepared in', ASSETS);
console.log(`Version ${version} (build ${build}) written to Version.xcconfig`);
