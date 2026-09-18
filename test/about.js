// End-to-end test of the About panel: that it is reachable from the Open menu
// with no book open, shows the version the host reports, and dismisses the way
// the menus do.
//
// WHAT THIS HARNESS CAN AND CANNOT PROVE. Like reader-e2e.js, it IS the main
// process, so it supplies its own ipc handlers and exercises the renderer half.
// It deliberately serves package.json's version, which is what main.js's
// app.getVersion() returns for the real app — but NOT what it would return
// here: run as `electron test/about.js` there is no application package.json
// loaded, so Electron falls back to reporting its own version (33.x). Asserting
// against app.getVersion() in this harness would therefore pin the Electron
// version, which is not the contract. The main-side half is covered by the
// source check in test/android-bridge.test.js instead.
//
//   run with:  npx electron test/about.js
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

app.disableHardwareAcceleration();
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'eupub-about-')));
setTimeout(() => { console.log('FAIL — timed out (30s)'); app.exit(3); }, 30000);

const ROOT = path.join(__dirname, '..');
const PKG_VERSION = require('../package.json').version;

ipcMain.handle('app:version', () => PKG_VERSION);
ipcMain.handle('epub:pick', () => null);
ipcMain.handle('open:pending', () => false);
// No book and no sample: the panel must be reachable from a cold welcome
// screen, which is the case the Open menu was chosen for.
ipcMain.handle('epub:samplePath', () => null);
ipcMain.handle('engine:source', () => fs.readFileSync(path.join(ROOT, 'dist', 'eupub-engine.mobile.js'), 'utf8'));
ipcMain.handle('system:naturalScroll', () => false);

const INDEX = path.join(ROOT, 'src', 'renderer', 'index.html');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 900,
    height: 700,
    show: false,
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  await win.loadFile(INDEX);
  const evaluate = (js) => win.webContents.executeJavaScript(js);
  await evaluate(`localStorage.clear(); true`);
  await win.loadFile(INDEX);

  const fails = [];
  const check = (ok, label, detail) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} — ${label}${detail ? `  (${detail})` : ''}`);
    if (!ok) fails.push(label);
  };

  const result = await evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const about = document.getElementById('about');
    const shown = () => !about.classList.contains('hidden');
    const items = () => [...document.querySelectorAll('#open-menu .menu-item')];
    const aboutItem = () => items().find((b) => b.textContent.trim() === 'About Eupub');

    const out = { welcomeVisible: !document.getElementById('welcome').classList.contains('hidden') };

    // Reachable with no book open: the Open button is never disabled.
    out.openEnabled = !document.getElementById('open-btn').disabled;
    document.getElementById('open-btn').click();
    await sleep(50);
    out.menuOpen = !document.getElementById('open-menu').classList.contains('hidden');
    out.hasAboutItem = !!aboutItem();
    out.hiddenBeforeClick = !shown();

    aboutItem().click();
    // The version is fetched over ipc, so give the await a beat to settle.
    for (let i = 0; i < 40 && !document.getElementById('about-version').textContent; i++) await sleep(50);
    out.shownAfterClick = shown();
    out.menuClosedAfterClick = document.getElementById('open-menu').classList.contains('hidden');
    out.versionText = document.getElementById('about-version').textContent;
    out.facts = [...document.querySelectorAll('#about-facts dt')].map(
      (dt, i) => dt.textContent + '=' + document.querySelectorAll('#about-facts dd')[i].textContent
    );

    // A click INSIDE must not dismiss it (its own handler stops propagation).
    about.click();
    await sleep(50);
    out.survivesInsideClick = shown();

    // A click outside must.
    document.body.click();
    await sleep(50);
    out.closedByOutsideClick = !shown();

    // Escape closes it too.
    aboutItem() || document.getElementById('open-btn').click();
    await sleep(50);
    document.getElementById('open-btn').click();
    await sleep(50);
    aboutItem().click();
    await sleep(120);
    out.reopened = shown();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(50);
    out.closedByEscape = !shown();

    return out;
  })()`);

  check(result.welcomeVisible, 'the welcome screen is showing (no book open)');
  check(result.openEnabled && result.menuOpen, 'the Open menu opens with no book');
  check(result.hasAboutItem, 'the Open menu carries an About Eupub item');
  check(result.hiddenBeforeClick, 'the panel starts hidden');
  check(result.shownAfterClick, 'clicking About opens the panel');
  check(result.menuClosedAfterClick, 'opening About closes the menu behind it');
  check(
    result.versionText === `Version ${PKG_VERSION}`,
    'the panel shows the version the host reported',
    `"${result.versionText}" vs "Version ${PKG_VERSION}"`
  );
  check(
    result.facts.some((f) => f.startsWith('Spelling engine=')),
    'the panel reports the engine state',
    result.facts.join(', ')
  );
  check(result.survivesInsideClick, 'a click inside the panel does not dismiss it');
  check(result.closedByOutsideClick, 'a click outside dismisses it');
  check(result.reopened && result.closedByEscape, 'Escape dismisses it');

  // Geometry, at the narrowest width the reader supports. The panel is centred
  // by transform, so a fixed width would hang off both edges on a phone; this
  // pins that it stays inside the viewport and is not clipped by it.
  win.setSize(380, 720);
  const box = await evaluate(`(async () => {
    await new Promise((r) => setTimeout(r, 150));
    document.getElementById('open-btn').click();
    await new Promise((r) => setTimeout(r, 60));
    [...document.querySelectorAll('#open-menu .menu-item')]
      .find((b) => b.textContent.trim() === 'About Eupub').click();
    await new Promise((r) => setTimeout(r, 250));
    const r = document.getElementById('about').getBoundingClientRect();
    return {
      left: Math.round(r.left), right: Math.round(r.right), bottom: Math.round(r.bottom),
      vw: window.innerWidth, vh: window.innerHeight,
    };
  })()`);
  check(
    box.left >= 0 && box.right <= box.vw,
    'the panel fits the width of a phone-sized window',
    `x ${box.left}..${box.right} in ${box.vw}px`
  );
  check(
    box.bottom <= box.vh,
    'the panel fits vertically',
    `bottom ${box.bottom} in ${box.vh}px`
  );

  console.log(fails.length ? `\nFAILED: ${fails.join('; ')}` : '\nAll About checks passed.');
  app.exit(fails.length ? 1 : 0);
});
