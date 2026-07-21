// Eupub iOS origin spike — does localStorage survive an app relaunch when the
// page is served from a custom scheme via WKURLSchemeHandler?
//
// This is the load-bearing question for the iOS port. The renderer keeps every
// piece of user state in localStorage (reader.js: reading position, bookmarks,
// highlights, prefs, recents). If that doesn't persist, the port has to route
// persistence through the native bridge, which forks reader.js away from the
// Android/Electron builds. If it does persist, the iOS shell is a direct
// translation of MainActivity.kt and the renderer stays untouched.
//
// It also probes a fetch() of a sibling path, because window.eupub.readText and
// engineSource are plain fetches against the served origin (see
// android-bridge.js) — if fetch doesn't work on the custom scheme, the bridge
// shim needs a different mechanism for chapter reads.
//
// HOW TO RUN — see README.md. Short version: ./run.sh, and read the verdict it
// prints. No Xcode UI, no signing.

import SwiftUI
import WebKit

// The origin under test. Both halves are load-bearing and permanent: localStorage
// is keyed to scheme+host, so changing either one after ship orphans every
// user's reading position, bookmarks, and highlights behind an origin nothing
// loads any more. This is exactly the one-time data loss Cordova/Ionic apps hit
// when they migrated file:// -> ionic://localhost. Pick it once, never touch it.
private let SCHEME = "eupub"
private let HOST = "localhost"

struct ContentView: View {
    var body: some View {
        SpikeWebView().ignoresSafeArea()
    }
}

struct SpikeWebView: UIViewRepresentable {
    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(SpikeSchemeHandler(), forURLScheme: SCHEME)

        // The real, mundane cause behind most "localStorage doesn't persist on
        // iOS" reports: .nonPersistent() is an in-memory store wiped on every
        // launch. .default() is already the default, but it is stated here
        // because it is the whole difference between pass and fail.
        config.websiteDataStore = .default()

        // Lets the page hand its verdict back to native so run.sh can print it,
        // instead of a human squinting at a screenshot. This is also the exact
        // mechanism the real bridge will use for window.eupub, so a working
        // round-trip here is a first proof of half the bridge design.
        let controller = WKUserContentController()
        controller.add(VerdictHandler(), name: "verdict")
        config.userContentController = controller

        let webView = WKWebView(frame: .zero, configuration: config)

        // The scheme handler only takes effect if the ROOT document is loaded
        // over the custom scheme too — loading the root from file:// or https://
        // and expecting subresources to route through the handler silently fails.
        let url = URL(string: "\(SCHEME)://\(HOST)/index.html")!
        webView.load(URLRequest(url: url))
        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}
}

/// Receives the page's verdict and gets it somewhere a script can read.
final class VerdictHandler: NSObject, WKScriptMessageHandler {
    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        guard let text = message.body as? String else { return }

        // Visible under `xcrun simctl launch --console`.
        print(text)

        // ...but --console blocks until the app exits, and this app never does.
        // So also drop it in the container, which run.sh reads after the fact
        // without attaching to stdout at all.
        if let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first {
            try? text.write(
                to: docs.appendingPathComponent("verdict.txt"),
                atomically: true,
                encoding: .utf8
            )
        }
    }
}

/// Serves the spike page (and one probe subresource) entirely from memory. The
/// real shell would serve the extracted book from disk here — this is the
/// WKURLSchemeHandler analog of Android's WebViewAssetLoader + BookPathHandler.
final class SpikeSchemeHandler: NSObject, WKURLSchemeHandler {
    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url else { return }

        let body: String
        let mime: String
        switch url.path {
        case "/probe.txt":
            body = "probe-ok"
            mime = "text/plain"
        default:
            body = spikePage
            mime = "text/html"
        }

        let data = Data(body.utf8)
        // Return a real HTTP 200, not a bare URLResponse. fetch() derives its
        // Response.status from the underlying response, and a non-HTTP
        // URLResponse surfaces as status 0 (r.ok === false) — which is exactly
        // why the /probe.txt fetch failed with "HTTP 0" while the main document
        // still rendered (document loads don't check status). The real bridge's
        // readText / engineSource are fetches too, so they need a genuine 200.
        let response = HTTPURLResponse(
            url: url,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "\(mime); charset=utf-8"]
        )!
        urlSchemeTask.didReceive(response)
        urlSchemeTask.didReceive(data)
        urlSchemeTask.didFinish()
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}
}

/// The page reports its verdict twice: on screen, and back to native for run.sh.
private let spikePage = """
<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font: 16px/1.5 -apple-system, system-ui, sans-serif; margin: 0; padding: 24px; }
  h1 { font-size: 20px; margin: 0 0 16px; padding: 12px; border-radius: 8px; }
  .pass    { background: #d8f5d8; color: #14532d; }
  .fail    { background: #fadbdb; color: #7f1d1d; }
  .pending { background: #fdf0d0; color: #78350f; }
  pre { background: #f4f4f5; padding: 12px; border-radius: 8px; white-space: pre-wrap; font-size: 13px; }
</style>
<h1 id="verdict" class="pending">running…</h1>
<pre id="detail"></pre>
<script>
(function () {
  var lines = [];
  var verdict = document.getElementById('verdict');
  function say(k, v) { lines.push(k.padEnd(16) + v); }

  // The origin the page actually got. A "null"/opaque origin here is the
  // failure mode that would sink the custom-scheme approach outright.
  say('origin', location.origin);

  var launches = null, first = null, storageError = null;
  try {
    launches = parseInt(localStorage.getItem('eupub:launches') || '0', 10) + 1;
    localStorage.setItem('eupub:launches', String(launches));

    first = localStorage.getItem('eupub:first');
    if (!first) {
      first = new Date().toISOString();
      localStorage.setItem('eupub:first', first);
    }
    say('localStorage', 'readable + writable');
    say('launches seen', String(launches));
    say('first seen', first);
  } catch (e) {
    // localStorage THROWS on an opaque origin rather than returning null.
    storageError = String(e);
    say('localStorage', 'THREW: ' + storageError);
  }

  // readText/engineSource are plain fetches against the served origin, so prove
  // fetch works on this scheme before the bridge design depends on it.
  fetch('/probe.txt')
    .then(function (r) { return r.ok ? r.text() : Promise.reject('HTTP ' + r.status); })
    .then(function (t) { say('fetch subresource', t === 'probe-ok' ? 'OK' : 'unexpected: ' + t); })
    .catch(function (e) { say('fetch subresource', 'FAILED: ' + e); })
    .then(render);

  function render() {
    var headline;
    if (storageError) {
      verdict.className = 'fail';
      headline = 'FAIL — localStorage unavailable on this origin';
    } else if (launches >= 2) {
      verdict.className = 'pass';
      headline = 'PASS — state survived ' + launches + ' launches';
    } else {
      verdict.className = 'pending';
      headline = 'FIRST RUN — now force-quit the app and relaunch';
    }
    verdict.textContent = headline;
    document.getElementById('detail').textContent = lines.join('\\n');

    // Hand the whole report to native so run.sh can print it.
    try {
      window.webkit.messageHandlers.verdict.postMessage(headline + '\\n' + lines.join('\\n'));
    } catch (e) {
      /* no handler (e.g. opened in plain Safari) — the on-screen copy stands */
    }
  }
})();
</script>
"""
