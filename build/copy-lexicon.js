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
const { execSync } = require('node:child_process');

const EUPUB = path.join(__dirname, '..');
const EXT = path.join(EUPUB, '..', 'euspell_ext');
const src = path.join(EXT, 'dist', 'lexicon.js');
const destDir = path.join(EUPUB, 'dist');
// .mjs so dynamic import() treats it as ESM (this project's package.json is CJS,
// under which a bare .js would be parsed as CommonJS and choke on `export`).
const dest = path.join(destDir, 'lexicon.mjs');

// What compile-lexicon.js reads: the lexicon CSVs, plus the compiler itself
// (a change to how rows are encoded changes the output just as an edited row
// does). Matched by prefix rather than globbing all of data/, so touching an
// unrelated file there — the IPA tables, the encoding reference — doesn't force
// a rebuild.
//
// The prefix also catches euspell_lexicon_accents.csv, which maps accented
// spellings to the ASCII headwords they resolve to. It arrived in euspell_ext on
// 31 Aug 2026 unread by anything, and compile-lexicon.js began reading it on 1 Sep:
// build/lib/accents.js turns those rows into alias keys appended to the compiled
// Map. So it is a real source now, and a rebuild on its edit is required rather
// than merely harmless — which is the case the broad prefix was already right
// about. The failure this guards against is missing a source, not doing redundant
// work.
function lexiconSources() {
  const data = path.join(EXT, 'data');
  const csvs = fs.existsSync(data)
    ? fs.readdirSync(data).filter((f) => /^euspell_lexicon.*\.csv$/.test(f)).map((f) => path.join(data, f))
    : [];
  return [...csvs, path.join(EXT, 'build', 'compile-lexicon.js')];
}

/** The newest mtime among `files` that exist, or 0. */
function newestMtime(files) {
  let newest = 0;
  for (const f of files) {
    try {
      newest = Math.max(newest, fs.statSync(f).mtimeMs);
    } catch {
      /* absent — nothing to date */
    }
  }
  return newest;
}

// Build a missing OR STALE lexicon in the sibling checkout rather than shipping
// whatever is lying there, mirroring what copy-pdf-viewer.mjs does for the PDF
// bundle. Staleness is the case that bites: euspell_ext/dist is gitignored, so a
// lexicon compiled before a CSV edit survives indefinitely, and an existence
// check alone would copy it forward silently — every consumer of that table
// fails the same quiet way, by continuing to serve the old spelling.
const builtAt = fs.existsSync(src) ? fs.statSync(src).mtimeMs : -1;
if (builtAt < 0 || newestMtime(lexiconSources()) > builtAt) {
  if (!fs.existsSync(EXT)) {
    throw new Error(`sibling euspell_ext checkout not found at ${EXT} — clone it next to Eupub.`);
  }
  const why = builtAt < 0 ? 'missing' : 'older than euspell_ext/data';
  console.log(`euspell_ext/dist/lexicon.js ${why} — running "npm run build:lexicon" in euspell_ext…`);
  // execSync, not execFileSync: on Windows npm is npm.cmd, and since Node
  // 18.20/20.12 (CVE-2024-27980) spawning a .cmd without a shell throws EINVAL.
  execSync('npm run build:lexicon', { cwd: EXT, stdio: 'inherit' });
  if (!fs.existsSync(src)) {
    throw new Error(`${src} still missing after "npm run build:lexicon" in euspell_ext.`);
  }
}

fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(src, dest);
const mb = (fs.statSync(dest).size / 1048576).toFixed(1);
console.log(`Copied lexicon -> ${dest} (${mb} MB)`);
