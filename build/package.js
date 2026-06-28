// Packages Eupub into a runnable out/eupub-win32-x64/eupub.exe using
// @electron/packager. The Electron runtime is taken from the local cache (the
// version pinned by the `electron` devDependency, 33.x), so no network download
// is needed. Only production deps (adm-zip) are bundled into the app.
const path = require('node:path');
const fs = require('node:fs');

const mod = require('@electron/packager');
const packager = mod.packager || mod.default || mod;

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

(async () => {
  const enginePath = path.join(root, 'dist', 'eupub-engine.js');
  if (!fs.existsSync(enginePath)) {
    console.error('dist/eupub-engine.js missing — run "npm run build:engine" first.');
    process.exit(1);
  }

  const appPaths = await packager({
    dir: root,
    out: path.join(root, 'out'),
    name: 'eupub', // -> eupub.exe
    executableName: 'eupub',
    platform: 'win32',
    arch: 'x64',
    icon: path.join(root, 'build', 'icon.ico'),
    appVersion: pkg.version,
    overwrite: true,
    prune: true,
    // Keep src/ + dist/ (engine bundle) + production node_modules; drop build
    // tooling, tests, prior outputs, and source maps from the shipped app.
    ignore: [
      /^\/out($|\/)/,
      /^\/test($|\/)/,
      /^\/build($|\/)/,
      /^\/\.git($|\/)/,
      /^\/\.gitignore$/,
      /\.map$/,
    ],
    win32metadata: {
      ProductName: 'Eupub',
      FileDescription: 'Eupub — a standalone EPUB reader in euspell reformed spelling',
      CompanyName: 'Euspell',
      OriginalFilename: 'eupub.exe',
    },
    appCopyright: 'GPL-3.0-or-later',
  });

  console.log('Packaged to:', appPaths.join(', '));
  console.log('Executable :', path.join(appPaths[0], 'eupub.exe'));
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
