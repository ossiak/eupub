// Entry point. Kept trivial and separate from ContentView.swift so the spike's
// actual subject — the WKWebView origin setup — stays in one readable file.

import SwiftUI

@main
struct SpikeApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}
