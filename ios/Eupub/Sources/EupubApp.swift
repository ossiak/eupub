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
import Foundation

@main
struct EupubApp: App {
    init() {
        // Ensure Documents exists so UIFileSharingEnabled surfaces it (Files "On
        // My iPhone ▸ Eupub" and Finder) even before anything is written there.
        // The reader keeps its own books under Application Support, so iOS would
        // otherwise never create Documents and the drop-in location — the whole
        // point of file sharing — wouldn't appear.
        if let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first {
            try? FileManager.default.createDirectory(at: docs, withIntermediateDirectories: true)
        }
    }

    var body: some Scene {
        WindowGroup {
            ReaderView().ignoresSafeArea()
        }
    }
}
