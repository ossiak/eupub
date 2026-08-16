import WebKit
import Foundation

/// Serves the bundled web payload over eupub://localhost, the WKURLSchemeHandler
/// analog of Android's WebViewAssetLoader + BookPathHandler:
///   /assets/<rel>  → www/<rel>       (reader/, engine/)
///   /book/<rel>    → www/book/<rel>  (the extracted book)
///
/// Every response is a real HTTP 200 (not a bare URLResponse): fetch() reads its
/// status from the underlying response, and a non-HTTP one surfaces as status 0
/// (r.ok === false) — the origin spike's load-bearing fix. readText/engineSource
/// are fetches, so this is required, not cosmetic.
final class SchemeHandler: NSObject, WKURLSchemeHandler {
    private let wwwRoot = Bundle.main.resourceURL!.appendingPathComponent("www")
    private let bookStore: BookStore

    init(bookStore: BookStore) { self.bookStore = bookStore }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else {
            task.didFailWithError(NSError(domain: "eupub", code: -1)); return
        }
        guard let fileURL = mapToFile(url.path), let data = try? Data(contentsOf: fileURL) else {
            respondNotFound(task, url: url); return
        }
        let mime = Self.mimeType(for: fileURL.pathExtension)
        let response = HTTPURLResponse(
            url: url,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: [
                "Content-Type": mime.hasPrefix("text/") || mime.contains("javascript") || mime.contains("xml")
                    ? "\(mime); charset=utf-8" : mime,
                "Content-Length": String(data.count),
            ]
        )!
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}

    /// Map a served path to a file:
    ///   /book/<rel>    → the current book's extraction dir (app container)
    ///   /assets/<rel>  → the bundle's www/ (reader/, engine/)
    /// guarding against traversal out of the respective root.
    private func mapToFile(_ path: String) -> URL? {
        if path.hasPrefix("/book/") {
            guard let bookDir = bookStore.currentBookDir else { return nil }
            let rel = String(path.dropFirst("/book/".count)).removingPercentEncoding
                ?? String(path.dropFirst("/book/".count))
            return within(bookDir, rel)
        }
        if path.hasPrefix("/pdf/") {
            guard let pdfDir = bookStore.currentPdfDir else { return nil }
            let rel = String(path.dropFirst("/pdf/".count)).removingPercentEncoding
                ?? String(path.dropFirst("/pdf/".count))
            return within(pdfDir, rel)
        }
        var rel: String
        if path.hasPrefix("/assets/") {
            rel = String(path.dropFirst("/assets/".count))
        } else if path == "/" || path.isEmpty {
            rel = "reader/index.html"
        } else {
            rel = String(path.drop(while: { $0 == "/" }))
        }
        rel = rel.removingPercentEncoding ?? rel
        return within(wwwRoot, rel)
    }

    /// Resolve `rel` under `root`, rejecting anything that escapes it.
    private func within(_ root: URL, _ rel: String) -> URL? {
        // Standardize the ROOT as well as the candidate. On a device,
        // Bundle.main.resourceURL sits under /var/containers/…, but
        // standardizedFileURL resolves the /var → /private/var symlink — so a
        // standardized candidate (/private/var/…) never has the raw root
        // (/var/…) as a prefix, the guard rejected it, and EVERY resource 404'd
        // (blank reader). The Simulator's bundle path has no such symlink, so it
        // only broke on hardware. Canonicalize both sides before comparing.
        let base = root.standardizedFileURL
        let candidate = base.appendingPathComponent(rel).standardizedFileURL
        guard candidate.path == base.path || candidate.path.hasPrefix(base.path + "/") else { return nil }
        return candidate
    }

    private func respondNotFound(_ task: WKURLSchemeTask, url: URL) {
        let response = HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1", headerFields: nil)!
        task.didReceive(response)
        task.didReceive(Data())
        task.didFinish()
    }

    static func mimeType(for ext: String) -> String {
        switch ext.lowercased() {
        case "html", "htm": return "text/html"
        case "xhtml": return "application/xhtml+xml"
        case "css": return "text/css"
        case "js", "mjs": return "application/javascript"
        case "wasm": return "application/wasm" // WebAssembly.instantiateStreaming rejects octet-stream
        case "pdf": return "application/pdf"
        case "json": return "application/json"
        case "opf", "ncx", "xml": return "application/xml"
        case "jpg", "jpeg": return "image/jpeg"
        case "png": return "image/png"
        case "gif": return "image/gif"
        case "svg": return "image/svg+xml"
        case "webp": return "image/webp"
        case "ttf": return "font/ttf"
        case "otf": return "font/otf"
        case "woff": return "font/woff"
        case "woff2": return "font/woff2"
        default: return "application/octet-stream"
        }
    }
}
