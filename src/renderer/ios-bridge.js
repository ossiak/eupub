// iOS bridge shim — provides `window.eupub` inside the WKWebView, mirroring the
// Electron preload's contextBridge surface (src/preload.js) so the renderer
// (reader.js / epub.js) runs unchanged. The iOS analog of android-bridge.js:
// EVERYTHING here is identical to that file except `nativeCall`'s transport.
//
// Two mechanisms, same as Android:
//   • Promise registry for genuine native calls (pickEpub / openPath /
//     openExternal / lexiconSubset). The Swift host does the work off the main
//     thread and settles the Promise by evaluating window.__eupubResolve(id, ok,
//     json). Results are JSON.
//   • Plain fetch() for readText / engineSource. The extracted book and the engine
//     are served over the eupub://localhost origin by the WKURLSchemeHandler, so
//     their (potentially multi-MB) contents are streamed by WebKit rather than
//     marshaled as strings across the bridge.
//
// The one difference from Android: Android exposes one @JavascriptInterface
// method per name (AndroidBridge.openPath(id, json)); WKWebView instead has a
// single WKScriptMessageHandler, so the method name travels in the message body
// ({ method, id, args }) to one handler named "eupub".
//
// Path helpers are POSIX (the served paths are '/'-separated); fileURL maps an
// extracted absolute path to its served eupub://localhost URL.
(function (root) {
  'use strict';

  // Configurable by the host before this script runs, via window.__eupubHost.
  var cfg = root.__eupubHost || {};
  var ORIGIN = cfg.origin || 'eupub://localhost'; // WKURLSchemeHandler origin
  var MOUNT = cfg.mount || '/book'; // path prefix mapped to the extraction dir
  var ENGINE_URL = cfg.engineUrl || ORIGIN + '/assets/engine/eupub-engine.mobile.js';

  // The current book's extraction root, captured from openPath's result so
  // fileURL() can turn an absolute chapter/resource path into a served URL.
  var currentRoot = '';

  // --- native async calls (promise registry) ---------------------------------

  var pending = new Map();
  var seq = 0;

  // The host settles a pending call: ok=true → resolve(value), else reject.
  root.__eupubResolve = function (id, ok, json) {
    var p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    var value;
    try { value = json == null || json === '' ? null : JSON.parse(json); }
    catch (e) { value = json; }
    if (ok) p.resolve(value);
    else p.reject(new Error(value && value.message ? value.message : String(value)));
  };

  function nativeCall(method, args) {
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      pending.set(id, { resolve: resolve, reject: reject });
      try {
        // One WKScriptMessageHandler named "eupub"; the Swift handler does the
        // work off the main thread and settles the promise by evaluating
        // window.__eupubResolve(id, ok, json).
        root.webkit.messageHandlers.eupub.postMessage({ method: method, id: id, args: args || [] });
      } catch (e) {
        pending.delete(id);
        reject(e);
      }
    });
  }

  // --- POSIX path helpers ----------------------------------------------------

  function normalize(p) {
    var abs = p.charAt(0) === '/';
    var out = [];
    var parts = p.split('/');
    for (var i = 0; i < parts.length; i++) {
      var seg = parts[i];
      if (seg === '' || seg === '.') continue;
      if (seg === '..') { if (out.length && out[out.length - 1] !== '..') out.pop(); else if (!abs) out.push('..'); }
      else out.push(seg);
    }
    return (abs ? '/' : '') + out.join('/');
  }
  function joinParts(parts) {
    return normalize(parts.filter(function (s) { return s != null && s !== ''; }).join('/'));
  }
  function dirname(p) {
    var n = normalize(p);
    var i = n.lastIndexOf('/');
    if (i <= 0) return i === 0 ? '/' : '.';
    return n.slice(0, i);
  }
  function basename(p) {
    var n = normalize(p);
    return n.slice(n.lastIndexOf('/') + 1);
  }
  function relFromRoot(absPath) {
    var a = normalize(absPath), r = normalize(currentRoot);
    if (r && (a === r || a.indexOf(r + '/') === 0)) return a.slice(r.length + 1);
    return a.replace(/^\/+/, ''); // fallback: strip leading slash
  }
  function fileURL(absPath) {
    return ORIGIN + MOUNT + '/' + relFromRoot(absPath).split('/').map(encodeURIComponent).join('/');
  }

  // --- served fetches --------------------------------------------------------

  function fetchText(url) {
    return root.fetch(url).then(function (res) {
      if (!res.ok) throw new Error('fetch ' + url + ' → ' + res.status);
      return res.text();
    });
  }

  // --- public surface (matches preload.js) -----------------------------------

  root.eupub = {
    pickEpub: function () { return nativeCall('pickEpub').then(rememberRoot); },
    openPath: function (p) { return nativeCall('openPath', [p]).then(rememberRoot); },
    engineSource: function () { return fetchText(ENGINE_URL); },
    readText: function (p) { return fetchText(fileURL(p)); },
    lexiconSubset: function (words) { return nativeCall('lexiconSubset', [words]); },
    openExternal: function (href) { return nativeCall('openExternal', [href]); },
    join: function () { return joinParts([].slice.call(arguments)); },
    dirname: dirname,
    basename: basename,
    fileURL: fileURL,
  };

  function rememberRoot(book) {
    if (book && book.rootDir) currentRoot = book.rootDir;
    return book;
  }

  // Exposed for tests / host introspection.
  root.__eupubBridge = { normalize: normalize, setRoot: function (r) { currentRoot = r; } };
})(typeof window !== 'undefined' ? window : globalThis);
