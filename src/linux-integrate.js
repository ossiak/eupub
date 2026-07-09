// Linux desktop integration for the AppImage build.
//
// An AppImage isn't "installed", so nothing registers a .desktop entry or a MIME
// handler for it — which means double-clicking an .epub in Dolphin (or any file
// manager) wouldn't route to Eupub. When we detect we're running as an AppImage
// (process.env.APPIMAGE is the path to the .AppImage), write a user-level
// .desktop entry + icon and refresh the caches, so Plasma can launch Eupub and
// hand it EPUBs. No-op on Windows/macOS, in dev, or under any non-AppImage
// packaging. Best-effort throughout: integration is a convenience, never a
// startup blocker.
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFile } = require('node:child_process');

/** Fire-and-forget a cache-refresh tool; ignore missing tools or failures. */
function refresh(cmd, args) {
  try {
    execFile(cmd, args, () => {});
  } catch {
    /* tool not present — the entry still works, the cache just updates later */
  }
}

function integrateAppImage() {
  if (process.platform !== 'linux') return;
  const appImage = process.env.APPIMAGE;
  if (!appImage) return;

  const home = os.homedir();
  const appsDir = path.join(home, '.local', 'share', 'applications');
  const hicolor = path.join(home, '.local', 'share', 'icons', 'hicolor');
  const iconDir = path.join(hicolor, '512x512', 'apps');

  try {
    fs.mkdirSync(appsDir, { recursive: true });
    fs.mkdirSync(iconDir, { recursive: true });

    // Copy the bundled icon so the .desktop `Icon=eupub` resolves by name (the
    // AppImage mounts read-only at a path that changes each run, so we can't
    // point at it directly).
    const iconSrc = path.join(process.resourcesPath, 'icon.png');
    if (fs.existsSync(iconSrc)) fs.copyFileSync(iconSrc, path.join(iconDir, 'eupub.png'));

    // %U passes the double-clicked file(s) as arguments; the main process reads
    // them from argv (see main.js). Only claim application/epub+zip — not
    // text/plain — so Eupub doesn't become a candidate handler for every .txt.
    const desktop =
      [
        '[Desktop Entry]',
        'Type=Application',
        'Name=Eupub',
        'Comment=Read EPUBs in euspell reformed spelling',
        `Exec="${appImage}" %U`,
        'Icon=eupub',
        'Terminal=false',
        'Categories=Office;Viewer;',
        'MimeType=application/epub+zip;',
        'StartupWMClass=eupub',
      ].join('\n') + '\n';
    fs.writeFileSync(path.join(appsDir, 'eupub.desktop'), desktop, 'utf8');

    refresh('update-desktop-database', [appsDir]);
    refresh('gtk-update-icon-cache', ['-f', '-t', hicolor]);
  } catch {
    /* never block startup on integration */
  }
}

module.exports = { integrateAppImage };
