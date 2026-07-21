import SwiftUI
import WebKit

let EUPUB_SCHEME = "eupub"
let EUPUB_HOST = "localhost"
private let ROOT_URL = "\(EUPUB_SCHEME)://\(EUPUB_HOST)/assets/reader/index.html"

/// Wraps the WKWebView that hosts the renderer. The Bridge coordinator is both
/// the script-message handler (window.eupub calls) and the navigation delegate
/// (first-launch sample seeding).
struct ReaderView: UIViewRepresentable {
    func makeCoordinator() -> Bridge { Bridge() }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        // Persistent store — the whole point of the origin spike. .nonPersistent()
        // would wipe localStorage (position, bookmarks, prefs) every launch.
        config.websiteDataStore = .default()
        config.setURLSchemeHandler(SchemeHandler(), forURLScheme: EUPUB_SCHEME)

        let controller = WKUserContentController()
        controller.add(context.coordinator, name: "eupub") // window.webkit.messageHandlers.eupub
        config.userContentController = controller

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        context.coordinator.webView = webView

        // The scheme handler only takes effect if the ROOT document is loaded over
        // the custom scheme too.
        webView.load(URLRequest(url: URL(string: ROOT_URL)!))
        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
