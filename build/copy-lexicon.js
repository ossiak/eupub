// Copies the compiled euspell lexicon Map (euspell_ext/dist/lexicon.js) into this
// project's dist/, where the main process loads it (once) to slice per-chapter
// subsets for the reader — see src/main.js. Kept out of the injected engine
// bundle so it lives in the main process only, never in a chapter iframe.
//
// (The Android build instead ships dist/lexicon.db, an on-disk SQLite lexicon
// built by ../euspell_ext/build/compile-lexicon-sqlite.mjs and queried natively;
// Electron's bundled Node has no node:sqlite, and the desktop can hold the Map.)
const fs = require('node:fs');
const path = require('node:path');

const src = path.join(__dirname, '..', '..', 'euspell_ext', 'dist', 'lexicon.js');
const destDir = path.join(__dirname, '..', 'dist');
// .mjs so dynamic import() treats it as ESM (this project's package.json is CJS,
// under which a bare .js would be parsed as CommonJS and choke on `export`).
const dest = path.join(destDir, 'lexicon.mjs');

if (!fs.existsSync(src)) {
  throw new Error(`euspell_ext lexicon missing at ${src} — build it there first (npm run build:lexicon in euspell_ext).`);
}
fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(src, dest);
const mb = (fs.statSync(dest).size / 1048576).toFixed(1);
console.log(`Copied lexicon -> ${dest} (${mb} MB)`);
