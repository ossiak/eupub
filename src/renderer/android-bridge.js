// Android bridge shim — provides `window.eupub` inside the WebView, mirroring the
// Electron preload's contextBridge surface (src/preload.js) so the renderer
// (reader.js / epub.js) runs unchanged. Replaces preload.js on Android; the
// Kotlin host includes it in the page (e.g. <script src="android-bridge.js">).
//
// Two mechanisms:
//   • Promise registry for genuine native calls (pickEpub / openPath /
//     openExternal). @JavascriptInterface methods are synchronous and string-only,
//     so the host does the work off the UI thread and settles the Promise by
//     calling back window.__eupubResolve(id, ok, json). Results are JSON.
//   • Plain fetch() for readText / engineSource. The extracted book and the engine
//     are served over a virtual https origin by WebViewAssetLoader, so their
//     (potentially multi-MB) contents are streamed by the WebView rather than
//     marshaled as strings across the bridge.
//
// Path helpers are POSIX (Android is Linux); fileURL maps an extracted absolute
// path to its served virtual-origin URL.
(function (root) {
  'use strict';

  // Configurable by the host before this script runs, via window.__eupubHost.
  var cfg = root.__eupubHost || {};
  var ORIGIN = cfg.origin || 'https://eupub.local'; // WebViewAssetLoader domain
  var MOUNT = cfg.mount || '/book'; // path prefix mapped to the extraction dir
  var ENGINE_URL = cfg.engineUrl || ORIGIN + '/assets/eupub-engine.js';

  // The current book's extraction root, captured from openPath's result so
  // fileURL() can turn an absolute chapter/resource path into a served URL.
  var currentRoot = '';

  // --- native async calls (promise registry) ---------------------------------

  var pending = new Map();
  var seq = 0;

  // The host settles a pending call: ok=true → resolve(value), else reject.
  // The Kotlin host settles calls with webView.evaluateJavascript(...), which
  // ALWAYS runs in the top frame — so this only ever fires there. A child frame
  // (e.g. the PDF viewer embedded in the reader) can't be resolved directly; it
  // relays through the top frame instead (see below).
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

  // A real native call, valid only in the top frame (where __eupubResolve fires).
  function directCall(method, args) {
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      pending.set(id, { resolve: resolve, reject: reject });
      try {
        // The Kotlin @JavascriptInterface signature is method(id:Int, argsJson:String).
        root.AndroidBridge[method](id, JSON.stringify(args || []));
      } catch (e) {
        pending.delete(id);
        reject(e);
      }
    });
  }

  // --- cross-frame relay -----------------------------------------------------
  // The PDF viewer runs both standalone (its own top-level page) and embedded in
  // the reader as an iframe. Native can only settle calls in the top frame, so a
  // child frame's nativeCall would hang forever. Instead a child posts each call
  // to the top frame, which makes the real native call and posts the result back.
  // All frames are the one first-party origin, so messages are gated on it.

  // A frame is a child only when it has a distinct top; a missing `top` (the
  // node test's mock window, or any non-frame host) counts as the top frame, so
  // existing direct-call behaviour is unchanged there.
  var inChildFrame = !!root.top && root.top !== root;
  var relayPending = new Map();
  var relaySeq = 0;

  if (typeof root.addEventListener === 'function') {
    if (inChildFrame) {
      root.addEventListener('message', function (e) {
        if (e.origin !== ORIGIN) return;
        var d = e.data;
        if (!d || !d.__eupubReply) return;
        var p = relayPending.get(d.callId);
        if (!p) return;
        relayPending.delete(d.callId);
        if (d.ok) p.resolve(d.value);
        else p.reject(new Error(d.error || 'bridge error'));
      });
    } else {
      // Top frame: service native calls delegated by child frames.
      root.addEventListener('message', function (e) {
        if (e.origin !== ORIGIN) return;
        var d = e.data;
        if (!d || !d.__eupubCall) return;
        var src = e.source;
        directCall(d.method, d.args).then(
          function (value) { src.postMessage({ __eupubReply: true, callId: d.callId, ok: true, value: value }, ORIGIN); },
          function (err) {
            src.postMessage(
              { __eupubReply: true, callId: d.callId, ok: false, error: err && err.message ? err.message : String(err) },
              ORIGIN
            );
          }
        );
      });
    }
  }

  function relayCall(method, args) {
    return new Promise(function (resolve, reject) {
      var callId = ++relaySeq;
      relayPending.set(callId, { resolve: resolve, reject: reject });
      root.top.postMessage({ __eupubCall: true, callId: callId, method: method, args: args || [] }, ORIGIN);
    });
  }

  // Every native call goes through here: direct in the top frame, relayed from a
  // child. Unchanged for callers (pickEpub/openPath/lexiconSubset/openExternal).
  function nativeCall(method, args) {
    return inChildFrame ? relayCall(method, args) : directCall(method, args);
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
