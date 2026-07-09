// Regenerates build/icon.ico (16..256 px, Windows) and build/icon.png (512 px,
// the Linux/AppImage icon) from the euspell logo SVG. This is a dev utility — the
// build uses the COMMITTED icons, so run this only when the logo changes. Needs
// `sharp` and the logo SVG (which lives in the Euspell tree, not this repo); e.g.:
//   NODE_PATH=../euspell_ext/node_modules node build/make-icon.js
const path = require('node:path');
const fs = require('node:fs');
const sharp = require('sharp');
const pngToIcoModule = require('png-to-ico');
const pngToIco = pngToIcoModule.default || pngToIcoModule;

const svgPath = path.join(__dirname, '..', '..', 'Logo', 'Euspell2_medium.svg');
const sizes = [16, 24, 32, 48, 64, 128, 256];

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
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
