import WebKit
import UIKit

/// The window.eupub native surface (mirrors src/preload.js and the Android
/// Bridge). Receives {method, id, args} from ios-bridge.js's nativeCall and
/// settles the JS-side promise by evaluating window.__eupubResolve(id, ok, json).
/// Also seeds the bundled sample on first launch (the Android maybeSeedSample).
final class Bridge: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    weak var webView: WKWebView?
    private let work = DispatchQueue(label: "com.euspell.eupub.bridge")
    private lazy var lexicon = Lexicon()

    private let wwwRoot = Bundle.main.resourceURL!.appendingPathComponent("www")
    private var bookRoot: URL { wwwRoot.appendingPathComponent("book") }
    private var seeded = false

    // --- first-launch seeding -------------------------------------------------
    // Point the reader at the bundled sample so something renders; after that its
    // own last-book pointer exists and it reopens on its own.
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard !seeded else { return }
        webView.evaluateJavaScript("localStorage.getItem('eupub:last')") { [weak self] value, _ in
            guard let self = self, !self.seeded else { return }
            self.seeded = true
            let v = value as? String
            if v == nil || v == "null" {
                webView.evaluateJavaScript(
                    "localStorage.setItem('eupub:last','sample'); location.reload();", completionHandler: nil)
            }
        }
    }

    // --- window.eupub calls ---------------------------------------------------
    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let method = body["method"] as? String,
              let id = body["id"] as? Int else { return }
        let args = body["args"] as? [Any] ?? []

        switch method {
        case "openPath":
            work.async { self.handleOpenPath(id) }
        case "lexiconSubset":
            let words = (args.first as? [Any])?.compactMap { $0 as? String } ?? []
            work.async { self.handleLexicon(id, words) }
        case "openExternal":
            let href = args.first as? String ?? ""
            DispatchQueue.main.async { self.handleOpenExternal(id, href) }
        case "pickEpub":
            // Phase 1: no file import yet (needs a Swift unzip); resolve as
            // "cancelled" so the reader stays on the current book.
            resolve(id, ok: true, json: "null")
        default:
            resolve(id, ok: false, json: Self.errJson("unknown method \(method)"))
        }
    }

    // openPath: the sample is pre-extracted into the bundle, so this only locates
    // the OPF via container.xml — no unzip (arbitrary-file import comes later).
    // Virtual rootDir "/book"; the scheme handler maps /book/<rel> → www/book/<rel>.
    private func handleOpenPath(_ id: Int) {
        do {
            let container = try String(contentsOf: bookRoot.appendingPathComponent("META-INF/container.xml"),
                                       encoding: .utf8)
            guard let opfRel = Self.firstMatch(in: container, pattern: #"full-path\s*=\s*["']([^"']+)["']"#) else {
                throw Err.msg("Invalid EPUB: no rootfile in container.xml")
            }
            let opfXml = try String(contentsOf: bookRoot.appendingPathComponent(opfRel), encoding: .utf8)
            let opfPath = "/book/" + opfRel
            let book: [String: Any] = [
                "sourcePath": "sample",
                "rootDir": "/book",
                "opfDir": (opfPath as NSString).deletingLastPathComponent,
                "opfPath": opfPath,
                "opfXml": opfXml,
            ]
            resolve(id, ok: true, json: Self.jsonString(book))
        } catch {
            resolve(id, ok: false, json: Self.errJson(String(describing: error)))
        }
    }

    private func handleLexicon(_ id: Int, _ words: [String]) {
        resolve(id, ok: true, json: Self.jsonString(lexicon.subset(words)))
    }

    private func handleOpenExternal(_ id: Int, _ href: String) {
        if let url = URL(string: href), ["http", "https", "mailto", "tel"].contains((url.scheme ?? "").lowercased()) {
            UIApplication.shared.open(url)
        }
        resolve(id, ok: true, json: "null")
    }

    // --- settle a pending JS promise -----------------------------------------
    private func resolve(_ id: Int, ok: Bool, json: String) {
        let js = "window.__eupubResolve(\(id), \(ok), \(Self.jsLiteral(json)));"
        DispatchQueue.main.async { self.webView?.evaluateJavaScript(js, completionHandler: nil) }
    }

    // --- helpers --------------------------------------------------------------
    enum Err: Error { case msg(String) }

    /// Serialize a JSON-compatible value to a compact JSON string.
    static func jsonString(_ value: Any) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: value),
              let s = String(data: data, encoding: .utf8) else { return "null" }
        return s
    }

    /// A JS string literal for `s` (quoted + escaped) — __eupubResolve's 3rd arg
    /// is a STRING it JSON.parses. .fragmentsAllowed lets us encode a bare String.
    static func jsLiteral(_ s: String) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: s, options: [.fragmentsAllowed]),
              let out = String(data: data, encoding: .utf8) else { return "\"\"" }
        return out
    }

    static func errJson(_ message: String) -> String { jsonString(["message": message]) }

    static func firstMatch(in text: String, pattern: String) -> String? {
        guard let re = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]),
              let m = re.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              m.numberOfRanges > 1, let r = Range(m.range(at: 1), in: text) else { return nil }
        return String(text[r])
    }
}
