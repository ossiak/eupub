// Shared step for the two mobile asset-prep scripts: copy a bridge shim
// (android-bridge.js / ios-bridge.js) with the app version baked into it.
//
// The bridges answer window.eupub.version() for the About panel. The desktop
// preload asks the main process (app.getVersion()); a WebView host has no such
// channel, and adding one would mean an @JavascriptInterface method in Kotlin
// AND a message-handler case in Swift — native code, on two platforms, to carry
// a constant that is known at build time. So it is substituted here instead.
//
// The value is package.json's version, which is already what both stores show:
// android/app/build.gradle.kts derives versionName from it, and iOS's
// prepare-assets.mjs writes MARKETING_VERSION from it. One source, three
// consumers, no way for the About panel to claim a version that was not shipped.
//
// Split out here, rather than duplicated in both scripts, for the same reason
// pdf-viewer-html.mjs is: two callers doing the identical transform.
import fs from 'node:fs';

// Matches the declaration the bridges carry, whatever it is currently set to,
// so re-running over an already-substituted file is a no-op rather than a
// second (and wrong) substitution.
const MARKER = /^(\s*)var VERSION = .*; \/\/ __EUPUB_VERSION__$/m;

/**
 * Copy `src` to `dest`, replacing its VERSION declaration with `version`.
 *
 * Throws when the marker is missing — the bridges are edited by hand, and a
 * silent pass-through would ship an About panel stuck on "unknown" with nothing
 * to say why. Every other marker in these scripts is checked the same way.
 *
 * @param {string} src  the bridge shim in src/renderer
 * @param {string} dest  where to write it in the platform's assets
 * @param {string} version  package.json's version
 */
export function copyBridgeWithVersion(src, dest, version) {
  const js = fs.readFileSync(src, 'utf8');
  if (!MARKER.test(js)) {
    throw new Error(`${src}: version marker not found (expected "var VERSION = …; // __EUPUB_VERSION__")`);
  }
  fs.writeFileSync(dest, js.replace(MARKER, `$1var VERSION = ${JSON.stringify(version)}; // __EUPUB_VERSION__`));
}
