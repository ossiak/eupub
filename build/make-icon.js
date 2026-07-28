// Regenerates build/icon.ico (16..256 px, Windows), build/icon.png (512 px, the
// Linux/AppImage icon), and build/icon.icns (macOS) from the euspell logo SVG.
// This is a dev utility — the build uses the COMMITTED icons, so run this only
// when the logo changes. Needs `sharp`, the logo SVG (which lives in the Euspell
// tree, not this repo), and on macOS the `iconutil` CLI (ships with Xcode
// Command Line Tools) for the .icns step; e.g.:
//   NODE_PATH=../euspell_ext/node_modules node build/make-icon.js
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const sharp = require('sharp');
const pngToIcoModule = require('png-to-ico');
const pngToIco = pngToIcoModule.default || pngToIcoModule;

const svgPath = path.join(__dirname, '..', '..', 'Logo', 'Euspell2_medium.svg');
const sizes = [16, 24, 32, 48, 64, 128, 256];
// macOS .iconset naming: base size and its @2x pixel dimensions.
const ICNS_SLOTS = [
  ['icon_16x16', 16], ['icon_16x16@2x', 32],
  ['icon_32x32', 32], ['icon_32x32@2x', 64],
  ['icon_128x128', 128], ['icon_128x128@2x', 256],
  ['icon_256x256', 256], ['icon_256x256@2x', 512],
  ['icon_512x512', 512], ['icon_512x512@2x', 1024],
];

(async () => {
  if (!fs.existsSync(svgPath)) {
    console.error('Logo SVG not found at', svgPath);
    process.exit(1);
  }
  const src = fs.readFileSync(svgPath);
  const buffers = await Promise.all(sizes.map((s) => sharp(src).resize(s, s).png().toBuffer()));
  const ico = await pngToIco(buffers);
  const out = path.join(__dirname, 'icon.ico');
  fs.writeFileSync(out, ico);
  console.log('Wrote', out, `(${ico.length} bytes; sizes ${sizes.join(', ')})`);

  // Linux/AppImage icon: a single 512×512 PNG (electron-builder's linux.icon).
  const pngOut = path.join(__dirname, 'icon.png');
  await sharp(src).resize(512, 512).png().toFile(pngOut);
  console.log('Wrote', pngOut, '(512×512)');

  // macOS icon: build an .iconset from the SVG at native resolution per slot
  // (sharper than upscaling the 512px PNG for the 1024 slot), then let iconutil
  // pack it into an .icns. iconutil is macOS-only, so skip gracefully elsewhere.
  if (os.platform() !== 'darwin') {
    console.log('Skipping icon.icns (iconutil is macOS-only)');
    return;
  }
  const iconsetDir = path.join(__dirname, 'icon.iconset');
  fs.rmSync(iconsetDir, { recursive: true, force: true });
  fs.mkdirSync(iconsetDir);
  await Promise.all(
    ICNS_SLOTS.map(([name, px]) =>
      sharp(src).resize(px, px).png().toFile(path.join(iconsetDir, `${name}.png`))
    )
  );
  const icnsOut = path.join(__dirname, 'icon.icns');
  execFileSync('iconutil', ['-c', 'icns', iconsetDir, '-o', icnsOut]);
  fs.rmSync(iconsetDir, { recursive: true, force: true });
  console.log('Wrote', icnsOut);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
