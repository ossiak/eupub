// Keeping the sibling euspell_ext checkout's built artifacts fresh.
//
// Both asset-prep paths — the desktop's build/copy-pdf-viewer.mjs and the APK's
// android/prepare-assets.mjs — copy bundles out of euspell_ext/dist. That
// directory is gitignored, so its bundles survive across source changes and an
// EXISTENCE check alone will happily ship one built before them.
//
// That is not hypothetical. The Android script checked only existence, and
// during a change to the PDF viewer it shipped an APK whose bundle predated the
// fix being tested — the on-device run reproduced the very bug the fix removed,
// because the fix was never in the APK. The desktop script already had this
// guard; sharing it is what stops the two drifting again.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

/** The newest mtime of any file under `dir`, or 0 when it does not exist. */
export function newestMtime(dir) {
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

/**
 * Build a missing OR STALE euspell_ext artifact in the sibling checkout, instead
 * of bouncing the user over there by hand (a fresh clone hits this on the first
 * build) or, worse, shipping the stale one.
 *
 * @param {object} opts
 * @param {string} opts.ext       the euspell_ext checkout
 * @param {string} opts.artifact  the built file in euspell_ext/dist
 * @param {string} opts.script    the euspell_ext npm script that produces it
 * @param {string[]} [opts.sources]  directories the artifact is built from
 * @param {string} [opts.relativeTo]  base for the path printed in the log line
 */
export function ensureExtArtifact({ ext, artifact, script, sources = [], relativeTo = process.cwd() }) {
  const builtAt = fs.existsSync(artifact) ? fs.statSync(artifact).mtimeMs : -1;
  const stale = builtAt < 0 || sources.some((dir) => newestMtime(dir) > builtAt);
  if (!stale) return;
  if (!fs.existsSync(ext)) {
    throw new Error(`sibling euspell_ext checkout not found at ${ext} — clone it next to Eupub.`);
  }
  const why = builtAt < 0 ? 'missing' : 'older than euspell_ext/src';
  console.log(`${path.relative(relativeTo, artifact)} ${why} — running "npm run ${script}" in euspell_ext…`);
  // execSync, not execFileSync: on Windows npm is npm.cmd, and since Node
  // 18.20/20.12 (CVE-2024-27980) spawning a .cmd without a shell throws EINVAL.
  // Going through the shell resolves it on both platforms, and `script` is a
  // literal from the call sites, so there is nothing to escape.
  execSync(`npm run ${script}`, { cwd: ext, stdio: 'inherit' });
  if (!fs.existsSync(artifact)) {
    throw new Error(`${artifact} still missing after "npm run ${script}" in euspell_ext.`);
  }
}
