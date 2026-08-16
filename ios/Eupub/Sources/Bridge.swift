import WebKit
import UIKit
import ZIPFoundation
import UniformTypeIdentifiers

/// The window.eupub native surface (mirrors src/preload.js and the Android
/// Bridge). Receives {method, id, args} from ios-bridge.js's nativeCall and
/// settles the JS-side promise by evaluating window.__eupubResolve(id, ok, json).
/// Also seeds the bundled sample on first launch (the Android maybeSeedSample).
final class Bridge: NSObject, WKScriptMessageHandler, WKNavigationDelegate, UIDocumentPickerDelegate {
    weak var webView: WKWebView?
    let bookStore = BookStore() // shared with the SchemeHandler (serves /book/…)
    private let work = DispatchQueue(label: "org.euspell.eupub.bridge")
    private lazy var lexicon = Lexicon()

    private let wwwRoot = Bundle.main.resourceURL!.appendingPathComponent("www")
    private var seeded = false

    // The frame each pending call came from, so its promise is resolved in that
    // frame's context — the embedded PDF viewer runs in an iframe and calls
    // window.eupub.lexiconSubset itself; a main-frame evaluateJavaScript would
    // resolve the wrong window.__eupubResolve and the call would hang. Touched
    // only on the main thread (didReceive + resolve's main-queue block).
    private var callFrames: [Int: WKFrameInfo] = [:]

    /// Where books are unzipped, in the app container (persists across launches).
    private lazy var booksDir: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Eupub", isDirectory: true)
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        return base
    }()

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
        callFrames[id] = message.frameInfo // resolve in the frame that called (main frame or the PDF-viewer iframe)

        switch method {
        case "openPath":
            let path = args.first as? String ?? "sample"
            work.async { self.handleOpenPath(id, path) }
        case "lexiconSubset":
            let words = (args.first as? [Any])?.compactMap { $0 as? String } ?? []
            work.async { self.handleLexicon(id, words) }
        case "openExternal":
            let href = args.first as? String ?? ""
            DispatchQueue.main.async { self.handleOpenExternal(id, href) }
        case "pickEpub":
            DispatchQueue.main.async { self.presentPicker(id) }
        default:
            resolve(id, ok: false, json: Self.errJson("unknown method \(method)"))
        }
    }

    // openPath: resolve the .epub (the "sample" sentinel → the bundled sample,
    // any other value → a real file path), unzip it into the container, and
    // return the book — the same path a user-picked book takes.
    private func handleOpenPath(_ id: Int, _ path: String) {
        let fileURL = path == "sample" ? wwwRoot.appendingPathComponent("sample.epub") : URL(fileURLWithPath: path)
        guard FileManager.default.fileExists(atPath: fileURL.path) else {
            resolve(id, ok: true, json: "null"); return // gone — reader falls back to welcome
        }
        do {
            let book = fileURL.pathExtension.lowercased() == "pdf"
                ? try importPdf(fileURL, sourcePath: path)
                : try extractEpub(fileURL, sourcePath: path)
            resolve(id, ok: true, json: Self.jsonString(book))
        } catch {
            resolve(id, ok: false, json: Self.errJson(String(describing: error)))
        }
    }

    // Unzip an .epub into a fresh dir under the container, parse container.xml for
    // the OPF, publish the dir to the SchemeHandler (served at /book/…), and
    // return the book — the iOS analog of MainActivity.extractEpub. rootDir is the
    // real container path; ios-bridge.js's fileURL() strips it to form /book/<rel>.
    private func extractEpub(_ epubURL: URL, sourcePath: String) throws -> [String: Any] {
        let dest = booksDir.appendingPathComponent("current", isDirectory: true)
        try? FileManager.default.removeItem(at: dest)
        try FileManager.default.createDirectory(at: dest, withIntermediateDirectories: true)
        try FileManager.default.unzipItem(at: epubURL, to: dest) // ZIPFoundation guards zip-slip

        let containerXml = try String(contentsOf: dest.appendingPathComponent("META-INF/container.xml"),
                                      encoding: .utf8)
        guard let opfRel = Self.firstMatch(in: containerXml, pattern: #"full-path\s*=\s*["']([^"']+)["']"#) else {
            throw Err.msg("Invalid EPUB: no rootfile in container.xml")
        }
        let opfXml = try String(contentsOf: dest.appendingPathComponent(opfRel), encoding: .utf8)
        bookStore.currentBookDir = dest

        let opfPath = dest.path + "/" + opfRel
        return [
            "kind": "epub",
            "sourcePath": sourcePath,
            "rootDir": dest.path,
            "opfDir": (opfPath as NSString).deletingLastPathComponent,
            "opfPath": opfPath,
            "opfXml": opfXml,
        ]
    }

    // A PDF isn't extracted like an EPUB — it's copied verbatim into a fresh dir
    // and served at eupub://localhost/pdf/<name>, published to the SchemeHandler.
    // The reader opens book.kind == "pdf" in the embedded viewer; that url is
    // same-origin with the viewer, so it clears the viewer's ?file= scheme check
    // (the iOS analog of MainActivity.importPdf / Android's https://eupub.local/pdf).
    private func importPdf(_ pdfURL: URL, sourcePath: String) throws -> [String: Any] {
        let dest = booksDir.appendingPathComponent("pdf", isDirectory: true)
        try? FileManager.default.removeItem(at: dest)
        try FileManager.default.createDirectory(at: dest, withIntermediateDirectories: true)
        let name = pdfURL.lastPathComponent
        try FileManager.default.copyItem(at: pdfURL, to: dest.appendingPathComponent(name))
        bookStore.currentPdfDir = dest
        let encoded = name.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? name
        return [
            "kind": "pdf",
            "sourcePath": sourcePath,
            "url": "eupub://localhost/pdf/\(encoded)",
            "title": (name as NSString).deletingPathExtension,
        ]
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

    // --- pickEpub (UIDocumentPicker) — the iOS analog of Android's SAF picker ---
    private var pendingPickId: Int?

    private func presentPicker(_ id: Int) {
        guard let vc = topViewController() else { resolve(id, ok: true, json: "null"); return }
        pendingPickId = id
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.epub, .pdf])
        picker.allowsMultipleSelection = false
        picker.delegate = self
        vc.present(picker, animated: true)
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let id = pendingPickId else { return }
        pendingPickId = nil
        guard let src = urls.first else { resolve(id, ok: true, json: "null"); return }
        work.async {
            let scoped = src.startAccessingSecurityScopedResource()
            defer { if scoped { src.stopAccessingSecurityScopedResource() } }
            do {
                // Copy into a persistent library dir so the reader's recents can
                // reopen it later — the picked URL itself is a transient grant.
                let library = self.booksDir.appendingPathComponent("library", isDirectory: true)
                try FileManager.default.createDirectory(at: library, withIntermediateDirectories: true)
                let dest = library.appendingPathComponent(src.lastPathComponent)
                try? FileManager.default.removeItem(at: dest)
                try FileManager.default.copyItem(at: src, to: dest)
                let book = dest.pathExtension.lowercased() == "pdf"
                    ? try self.importPdf(dest, sourcePath: dest.path)
                    : try self.extractEpub(dest, sourcePath: dest.path)
                self.resolve(id, ok: true, json: Self.jsonString(book))
            } catch {
                self.resolve(id, ok: false, json: Self.errJson(String(describing: error)))
            }
        }
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        if let id = pendingPickId { pendingPickId = nil; resolve(id, ok: true, json: "null") }
    }

    private func topViewController() -> UIViewController? {
        var vc = webView?.window?.rootViewController
        while let presented = vc?.presentedViewController { vc = presented }
        return vc
    }

    // --- settle a pending JS promise -----------------------------------------
    private func resolve(_ id: Int, ok: Bool, json: String) {
        let js = "window.__eupubResolve(\(id), \(ok), \(Self.jsLiteral(json)));"
        DispatchQueue.main.async {
            // Resolve in the calling frame (nil ⇒ main frame) — the PDF viewer's
            // iframe defines its own window.__eupubResolve.
            let frame = self.callFrames.removeValue(forKey: id)
            self.webView?.evaluateJavaScript(js, in: frame, in: .page, completionHandler: nil)
        }
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
