// Vendors DOMPurify into the renderer: node_modules/dompurify/dist/purify.min.js
// -> src/renderer/purify.js. The renderer is shared verbatim with the Android
// WebView (android/prepare-assets.mjs copies src/renderer/*), so the sanitizer
// must be a plain renderer script, not a preload/npm import — and it lives in
// src/ (committed) rather than dist/ (gitignored) so a fresh checkout can run
// `electron .` without a build. Re-run (part of `npm run build`) after a
// dompurify upgrade to keep the vendored copy in sync.
const fs = require('node:fs');
const path = require('node:path');

const src = path.join(__dirname, '..', 'node_modules', 'dompurify', 'dist', 'purify.min.js');
const dest = path.join(__dirname, '..', 'src', 'renderer', 'purify.js');
fs.copyFileSync(src, dest);
console.log('Vendored DOMPurify ->', path.relative(path.join(__dirname, '..'), dest));
