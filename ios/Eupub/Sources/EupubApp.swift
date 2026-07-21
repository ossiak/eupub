// Eupub iOS app — a single WKWebView hosting the reused Eupub renderer, the iOS
// analog of the Android MainActivity. The renderer (epub.js / reader.js /
// viewer-runtime.js) runs UNCHANGED; this app plays the Electron main + preload:
//   • SchemeHandler serves the bundled reader/engine (/assets/…) and the book
//     (/book/…) over eupub://localhost (WKURLSchemeHandler — WKWebView can't
//     serve a virtual https origin, and the origin spike proved localStorage
//     persists on this custom scheme).
//   • Bridge reproduces window.eupub via a WKScriptMessageHandler + a promise
//     registry settled through window.__eupubResolve (see ios-bridge.js).
import SwiftUI

@main
struct EupubApp: App {
    var body: some Scene {
        WindowGroup {
            ReaderView().ignoresSafeArea()
        }
    }
}
