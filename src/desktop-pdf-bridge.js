// Desktop bridge for the embedded PDF viewer page (the app://eupub iframe
// inside the file:// Electron reader) — the desktop counterpart of
// android-bridge.js's child-frame relay, cut down to what the viewer actually
// uses: window.eupub.lexiconSubset. The viewer has no preload (it is a plain
// cross-origin iframe), so each call is posted to the embedding reader, which
// services it over its own IPC bridge and posts the result back
// (see the __eupubCall servicer in src/renderer/reader.js).
//
// The wire protocol ({ __eupubCall, callId, method, args } out,
// { __eupubReply, callId, ok, value, error } back) is android-bridge.js's relay
// protocol, so reader.js services both hosts identically. targetOrigin is '*'
// on the way out — the reader's origin (file://) isn't expressible as a target
// origin, and the payload is the page's own word list; the reply is validated
// by source (only the parent window is listened to).
(function () {
  'use strict';

  var pending = new Map();
  var seq = 0;

  window.addEventListener('message', function (e) {
    if (e.source !== window.parent) return;
    var d = e.data;
    if (!d || !d.__eupubReply) return;
    var p = pending.get(d.callId);
    if (!p) return;
    pending.delete(d.callId);
    if (d.ok) p.resolve(d.value);
    else p.reject(new Error(d.error || 'bridge error'));
  });

  function relay(method, args) {
    return new Promise(function (resolve, reject) {
      var callId = ++seq;
      pending.set(callId, { resolve: resolve, reject: reject });
      window.parent.postMessage({ __eupubCall: true, callId: callId, method: method, args: args || [] }, '*');
    });
  }

  window.eupub = {
    lexiconSubset: function (words) { return relay('lexiconSubset', [words]); },
  };
})();
