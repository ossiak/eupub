// Offscreen end-to-end smoke test of the "reuse as-is" path: load a sample
// document into a real Chromium DOM, inject the bundled euspell engine exactly
// as the reader does into a chapter iframe, and confirm the text is converted.
//   run with:  npx electron test/smoke.js
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

app.commandLine.appendSwitch('disable-gpu');
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });

  const engine = fs.readFileSync(path.join(__dirname, '..', 'dist', 'eupub-engine.js'), 'utf8');
  const sample = 'The people thought they could read through the rough night before the action.';
  const html = `<!DOCTYPE html><html><body><p id="t">${sample}</p></body></html>`;

  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  const before = await win.webContents.executeJavaScript('document.getElementById("t").textContent');
  await win.webContents.executeJavaScript(engine + '\n;true');
  const after = await win.webContents.executeJavaScript('document.getElementById("t").textContent');

  console.log('BEFORE :', before);
  console.log('AFTER  :', after);
  const changed = before !== after;
  console.log(changed ? 'PASS — text was converted' : 'FAIL — text unchanged');
  app.exit(changed ? 0 : 1);
});
