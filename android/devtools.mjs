// Drive the Eupub WebView on a connected device from a terminal — navigate it,
// run JS in it, and see its console, CSP violations, and network table. This is
// what chrome://inspect does, over the same DevTools protocol; the point is that
// it scripts, so on-device checks can be repeated and diffed instead of eyeballed.
//
//   node devtools.mjs                                  # probe whatever is loaded
//   node devtools.mjs --url <url>                      # navigate, then probe
//   node devtools.mjs --eval "location.href"           # run an expression
//   node devtools.mjs --url <url> --net                # + the network table
//   node devtools.mjs --url <pdf> --sweep              # scroll it all, watch canvas memory
//
// e.g. the PDF viewer (its ?file= must be ABSOLUTE — isAllowedViewerUrl does
// new URL(u) with no base, so a relative path is rejected):
//   node devtools.mjs --net --url \
//     'https://eupub.local/assets/pdf/viewer.html?file=https://eupub.local/assets/sample.pdf'
//
// Requires: the app installed and running, and a debug build (WebView contents
// debugging is on automatically for a debuggable app). Exits 1 if the page
// reported errors, so it can gate a script.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 9222;

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const NAV = flag('--url');
const EVAL = flag('--eval');
const SETTLE = Number(flag('--settle') || (NAV ? 14000 : 1000));
const SHOW_NET = args.includes('--net');
const SWEEP = args.includes('--sweep');

// --- adb ---------------------------------------------------------------------

/** adb from local.properties' sdk.dir, then ANDROID_HOME/ANDROID_SDK_ROOT, then PATH. */
function findAdb() {
  const exe = process.platform === 'win32' ? 'adb.exe' : 'adb';
  const roots = [];
  try {
    const lp = fs.readFileSync(path.join(HERE, 'local.properties'), 'utf8');
    const m = /^sdk\.dir=(.+)$/m.exec(lp);
    if (m) roots.push(m[1].trim().replace(/\\\\/g, '\\'));
  } catch {
    /* no local.properties — fall through to the env vars */
  }
  if (process.env.ANDROID_HOME) roots.push(process.env.ANDROID_HOME);
  if (process.env.ANDROID_SDK_ROOT) roots.push(process.env.ANDROID_SDK_ROOT);
  for (const r of roots) {
    const p = path.join(r, 'platform-tools', exe);
    if (fs.existsSync(p)) return p;
  }
  return exe; // hope it's on PATH
}

const ADB = findAdb();
const adb = (...a) => execFileSync(ADB, a, { encoding: 'utf8' }).replace(/\r/g, '');

function device() {
  const lines = adb('devices').split('\n').slice(1).filter((l) => /\tdevice$/.test(l));
  if (!lines.length) {
    throw new Error(
      'no device. Plug one in, or for wireless debugging:\n' +
        '  adb mdns services            # find its _adb-tls-connect._tcp ip:port\n' +
        '  adb connect <ip>:<port>      # (pair first if this host is new)'
    );
  }
  return lines[0].split('\t')[0];
}

/**
 * The WebView's devtools unix socket, named webview_devtools_remote_<pid>. It
 * only exists while the app is running.
 */
function webviewSocket(dev) {
  const unix = adb('-s', dev, 'shell', 'cat /proc/net/unix');
  const m = /@(webview_devtools_remote_\d+)/.exec(unix);
  if (!m) {
    throw new Error(
      'no WebView devtools socket — is the app running? Launch it with:\n' +
        `  adb -s ${dev} shell am start -n com.euspell.eupub/.MainActivity`
    );
  }
  return m[1];
}

const dev = device();
const sock = webviewSocket(dev);
adb('-s', dev, 'forward', `tcp:${PORT}`, `localabstract:${sock}`);
console.error(`# ${dev} → ${sock} → localhost:${PORT}`);

// --- CDP ---------------------------------------------------------------------

const targets = await (await fetch(`http://localhost:${PORT}/json/list`)).json();
const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
if (!page) {
  console.error('no debuggable page (targets: ' + targets.map((t) => t.type).join(', ') + ')');
  process.exit(2);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const logs = [];
const failures = [];
const reqs = new Map();
const responses = [];

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });

ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    return m.error ? reject(new Error(m.error.message)) : resolve(m.result);
  }
  if (m.method === 'Runtime.consoleAPICalled') {
    const text = m.params.args
      .map((a) => a.value ?? a.description ?? a.unserializableValue ?? `<${a.type}>`)
      .join(' ');
    logs.push(`[${m.params.type}] ${text}`);
  }
  // CSP violations and blocked/failed resources arrive HERE, not on
  // consoleAPICalled — this is the channel that answers "did the CSP bite?".
  if (m.method === 'Log.entryAdded') {
    const e = m.params.entry;
    logs.push(`[${e.source}/${e.level}] ${e.text}${e.url ? ` (${e.url})` : ''}`);
    // The WebView asks for /favicon.ico on every navigation and no page serves
    // one, so that error is background noise on a perfectly healthy page — don't
    // let it decide the exit code.
    if (e.level === 'error' && !/favicon/.test(e.url || '')) failures.push(e.text);
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    const t = d.exception?.description || d.text;
    logs.push(`[exception] ${t}`);
    failures.push(t);
  }
  if (m.method === 'Network.requestWillBeSent') reqs.set(m.params.requestId, m.params.request.url);
  if (m.method === 'Network.responseReceived') {
    responses.push({
      status: m.params.response.status,
      mime: m.params.response.mimeType,
      type: m.params.type,
      url: reqs.get(m.params.requestId) || m.params.response.url,
    });
  }
});

await new Promise((r) => ws.addEventListener('open', r));
await send('Runtime.enable');
await send('Log.enable');
await send('Network.enable');
await send('Page.enable');

if (NAV) {
  await send('Page.navigate', { url: NAV });
  await new Promise((r) => setTimeout(r, SETTLE));
}

if (SWEEP) {
  // Scroll a PDF end to end and watch live canvas memory. The viewer evicts
  // canvases outside a keep window, so the numbers should PLATEAU. If they climb
  // with scroll position, eviction is broken and a long document will eventually
  // take the renderer down. Use with a long PDF — a short one fits entirely
  // inside the keep window and proves nothing.
  const stat = `(() => {
    const cs = [...document.querySelectorAll('canvas')];
    return JSON.stringify({
      pages: document.querySelectorAll('.page').length,
      live: cs.length,
      mb: +(cs.reduce((s, c) => s + c.width * c.height * 4, 0) / 1048576).toFixed(1),
      pct: +(scrollY / (document.body.scrollHeight - innerHeight) * 100).toFixed(0),
    });
  })()`;
  const at = async (frac) => {
    await send('Runtime.evaluate', {
      expression: `scrollTo(0, (document.body.scrollHeight - innerHeight) * ${frac})`,
    });
    await new Promise((r) => setTimeout(r, 2500)); // let render + evict settle
    const r = await send('Runtime.evaluate', { expression: stat, returnByValue: true });
    return JSON.parse(r.result.value);
  };

  console.log('pos%   pages   liveCanvases   canvasMB');
  const rows = [];
  for (let i = 0; i <= 10; i++) {
    const s = await at(i / 10);
    rows.push(s);
    console.log(
      String(s.pct).padStart(4),
      String(s.pages).padStart(7),
      String(s.live).padStart(14),
      String(s.mb).padStart(10)
    );
  }
  const maxLive = Math.max(...rows.map((r) => r.live));
  const maxMb = Math.max(...rows.map((r) => r.mb));
  const pages = rows[0].pages;
  const perPage = maxMb / Math.max(maxLive, 1);
  console.log('');
  console.log(`peak: ${maxLive} live canvases of ${pages} pages, ${maxMb} MB`);
  console.log(`all ${pages} resident would be ~${Math.round(pages * perPage)} MB`);
  // The keep window is ~3 pages either side, so a healthy plateau is well under
  // a dozen regardless of document length.
  console.log(maxLive <= 12 ? 'PASS canvases bounded (memory plateaus)' : 'FAIL canvases unbounded');
  if (maxLive > 12) failures.push(`eviction not bounding canvases: ${maxLive} live`);
} else if (EVAL) {
  const r = await send('Runtime.evaluate', {
    expression: EVAL,
    awaitPromise: true,
    returnByValue: true,
  });
  console.log(r.result?.value ?? JSON.stringify(r.result ?? r, null, 1));
} else {
  // Default probe: enough to say whether a reader or PDF page is healthy.
  const probe = `(() => {
    const canvases = [...document.querySelectorAll('canvas')];
    const layers = [...document.querySelectorAll('.textLayer')];
    return JSON.stringify({
      url: location.href,
      title: document.title,
      dpr: devicePixelRatio,
      canvases: canvases.length,
      canvasSizes: canvases.slice(0, 3).map(c => c.width + 'x' + c.height),
      megapixelsEach: canvases.length ? +(canvases[0].width * canvases[0].height / 1e6).toFixed(1) : 0,
      textLayers: layers.length,
      sample: layers.map(l => l.textContent).join(' ').slice(0, 200) || null,
      pageErrors: [...document.querySelectorAll('.page-error')].map(e => e.textContent),
      hasBridge: typeof window.eupub !== 'undefined',
    }, null, 1);
  })()`;
  const r = await send('Runtime.evaluate', { expression: probe, returnByValue: true });
  console.log('=== PROBE ===');
  console.log(r.result?.value ?? JSON.stringify(r, null, 1));
}

if (SHOW_NET) {
  console.log('\n=== NETWORK ===');
  for (const r of responses) {
    if (/favicon/.test(r.url)) continue;
    console.log(
      `${String(r.status).padEnd(4)} ${r.type.padEnd(10)} ${(r.mime || '-').padEnd(24)} ` +
        r.url.replace('https://eupub.local/assets/', '')
    );
  }
  // A real PDF.js worker fetches its script on its OWN target, so it never shows
  // up here. A FAKE worker imports it on the main thread and would. So: no worker
  // row + a live worker target = the real worker. (And note viewer.js runs pdf.js
  // at verbosity ERRORS, which suppresses its own "Setting up fake worker" warning
  // — this is the check that replaces it.)
  const workerTargets = (await (await fetch(`http://localhost:${PORT}/json/list`)).json()).filter(
    (t) => /worker/i.test(t.type)
  );
  console.log(
    `\nworker targets: ${workerTargets.length} ` +
      (workerTargets.length ? '(real pdf.js worker running)' : '(none — pdf.js would be on the main thread)')
  );
}

if (logs.length) {
  console.log('\n=== CONSOLE ===');
  for (const l of logs) console.log(l);
}
if (failures.length) {
  console.log('\n=== FAILURES ===');
  for (const f of failures) console.log('!', f);
}

// Exit without ws.close(): closing the socket and tearing down the process in the
// same tick trips a libuv assertion on Windows (UV_HANDLE_CLOSING in async.c) and
// exits 127, which would mask the real result. The OS reclaims the socket anyway.
process.exit(failures.length ? 1 : 0);
