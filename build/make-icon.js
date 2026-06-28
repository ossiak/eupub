// Builds build/icon.ico from the euspell extension's PNG icons, so the packaged
// eupub.exe and its window carry the euspell mark. Pure JS (png-to-ico), no
// native tooling required.
const path = require('node:path');
const fs = require('node:fs');
const pngToIcoModule = require('png-to-ico');
const pngToIco = pngToIcoModule.default || pngToIcoModule;

const iconDir = path.join(__dirname, '..', '..', 'euspell_ext', 'icons');
const sources = ['16.png', '48.png', '128.png']
  .map((f) => path.join(iconDir, f))
  .filter((p) => fs.existsSync(p));

if (sources.length === 0) {
  console.error('No source PNGs found in', iconDir);
  process.exit(1);
}

pngToIco(sources)
  .then((buf) => {
    const out = path.join(__dirname, 'icon.ico');
    fs.writeFileSync(out, buf);
    console.log('Wrote', out, `(${buf.length} bytes from ${sources.length} sizes)`);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
