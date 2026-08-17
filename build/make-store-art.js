// Renders the store art from the vector logo.
//
//   npx electron build/make-store-art.js
//
// Output, in build/store-art/:
//   logo-1080.png          1080 x 1080  square logo
//   poster-720x1080.png     720 x 1080  2:3 poster art
//
// Rendered rather than exported by hand so the sizes are exact and the result
// is reproducible: the source is euspell_ext/icons/euspell_logo.svg, a potrace
// tracing with one fill and no text, so there is no font dependency and nothing
// to go stale.
//
// Each image is drawn at the window's device pixel ratio and then resized down
// to the exact target. Supersampling a curve and shrinking it is what keeps the
// ring's edge clean; asking the renderer for 1080 directly would land on
// whatever the display's scale factor made of it.
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

app.disableHardwareAcceleration();
setTimeout(() => { console.log('FAIL — timed out'); app.exit(3); }, 60000);

const OUT = path.join(__dirname, 'store-art');
const SVG = path.join(__dirname, '..', '..', 'euspell_ext', 'icons', 'euspell_logo.svg');

const BLUE = '#0000ff';
const WHITE = '#ffffff';

/** @param {{bg: string, fg: string, pad: number}} o */
function page(svg, o) {
  // CSS beats a presentation attribute, so one artwork file serves both the
  // blue-on-white and white-on-blue treatments with nothing edited or
  // duplicated. BOTH properties have to be overridden: the mark is a filled
  // group, but the ring is a path carrying its own stroke="#0000ff" with a
  // 79-unit width, and recolouring only the fill leaves the ring the source
  // blue — invisible on a blue field, which is exactly how it first came out.
  return `<!doctype html><meta charset="utf-8">
<style>
  html, body { margin: 0; height: 100%; }
  body {
    background: ${o.bg};
    display: flex; align-items: center; justify-content: center;
    box-sizing: border-box; padding: ${o.pad}%;
  }
  svg { width: 100%; height: 100%; }
  svg g { fill: ${o.fg} !important; }
  svg [stroke]:not([stroke="none"]) { stroke: ${o.fg} !important; }
</style>
${svg}`;
}

async function render(win, html, name, width, height) {
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 300));
  let img = await win.webContents.capturePage();
  img = img.resize({ width, height, quality: 'best' });
  const file = path.join(OUT, name);
  fs.writeFileSync(file, img.toPNG());
  const s = img.getSize();
  console.log(`  ${name}  ${s.width}x${s.height}  ${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const svg = fs.readFileSync(SVG, 'utf8').replace(/<\?xml[\s\S]*?\?>|<!DOCTYPE[\s\S]*?>/g, '');

  const shots = [
    // Square logo: blue on white, matching the icon the app installs with, so
    // the listing and the taskbar show the same thing.
    { name: 'logo-1080.png', w: 1080, h: 1080, bg: WHITE, fg: BLUE, pad: 8 },
    // Poster art: the brand field, which is what the animation and the site use.
    { name: 'poster-720x1080.png', w: 720, h: 1080, bg: BLUE, fg: WHITE, pad: 14 },
  ];

  console.log('Rendering store art from', path.relative(path.join(__dirname, '..'), SVG));
  // One window, resized between renders. Creating a fresh BrowserWindow per
  // image fails the second load with ERR_FAILED — the same trap the screenshot
  // script hit, and the reason both scripts reuse a window.
  const win = new BrowserWindow({
    width: shots[0].w, height: shots[0].h, show: false,
    webPreferences: { offscreen: true },
  });
  for (const s of shots) {
    win.setContentSize(s.w, s.h);
    await new Promise((r) => setTimeout(r, 150));
    await render(win, page(svg, { bg: s.bg, fg: s.fg, pad: s.pad }), s.name, s.w, s.h);
  }
  console.log('Wrote', OUT);
  app.exit(0);
});
