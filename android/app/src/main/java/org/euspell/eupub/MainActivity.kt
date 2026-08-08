package org.euspell.eupub

import android.annotation.SuppressLint
import android.content.Intent
import android.database.sqlite.SQLiteDatabase
import android.net.Uri
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.webkit.WebViewAssetLoader
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.ByteArrayInputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.net.URLDecoder
import java.util.concurrent.Executors
import java.util.zip.ZipInputStream

/**
 * Eupub Android shell — a single WebView that hosts the reused Eupub renderer.
 *
 * The renderer (epub.js / reader.js / viewer-runtime.js) runs unchanged; this
 * Activity plays the role of the Electron main process + preload:
 *   - WebViewAssetLoader serves the bundled reader + engine (/assets/...) and the
 *     extracted book (/book/...) over the virtual https://eupub.local origin.
 *   - the AndroidBridge @JavascriptInterface + a promise-registry (resolved via
 *     window.__eupubResolve) reproduce window.eupub for the shim in
 *     android-bridge.js.
 */
class MainActivity : ComponentActivity() {

    private val io = Executors.newSingleThreadExecutor()
    private lateinit var webView: WebView

    @Volatile
    private var currentBookDir: File? = null
    private var lexDb: SQLiteDatabase? = null
    private var seeded = false
    private var pendingPickId = -1

    // Open-from-OS state (mirrors main.js's pendingOpen/deliverOpen): a PDF handed
    // in by an intent is imported off-thread, then delivered to the reader once the
    // page has loaded. All four are touched only on the UI thread.
    private var pageLoaded = false
    private var pendingOpen: String? = null
    private var intentOpen = false
    // True from intent arrival until the imported path has been handed to the
    // page (or the import failed). Answered to the reader via hasPendingOpen so
    // its init can skip the "reopen last book" fallback — otherwise the two
    // loads race, exactly the desktop bug fixed in src/main.js. Unlike
    // intentOpen (sticky, guards the sample seed), this is transient.
    private var openPending = false

    // SAF picker for pickEpub(): resolves the pending promise with the opened book.
    private val picker =
        registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri: Uri? ->
            val id = pendingPickId
            pendingPickId = -1
            if (id < 0) return@registerForActivityResult
            if (uri == null) {
                resolve(id, true, "null")
                return@registerForActivityResult
            }
            io.execute {
                try {
                    val name = displayName(uri)
                    if (isPdf(uri, name)) {
                        resolve(id, true, importPdf(uri, name).toString())
                    } else {
                        val tmp = File(cacheDir, "picked-" + System.currentTimeMillis() + ".epub")
                        contentResolver.openInputStream(uri)!!.use { input ->
                            FileOutputStream(tmp).use { input.copyTo(it) }
                        }
                        resolve(id, true, extractEpub(tmp).toString())
                    }
                } catch (e: Exception) {
                    resolve(id, false, errJson(e))
                }
            }
        }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val assetLoader = WebViewAssetLoader.Builder()
            .setDomain("eupub.local")
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .addPathHandler("/book/", BookPathHandler())
            .addPathHandler("/pdf/", PdfPathHandler())
            .build()

        webView = WebView(this)
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mediaPlaybackRequiresUserGesture = true
            // Lay out to the device's CSS width so the reader's columns (derived
            // from clientWidth) fit the screen. With useWideViewPort=true the
            // WebView picked a wider viewport (~629px on a 360px screen) and the
            // text overflowed; false pins layout to the control width.
            useWideViewPort = false
            loadWithOverviewMode = false
        }
        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest
            ): WebResourceResponse? = assetLoader.shouldInterceptRequest(request.url)

            override fun onPageFinished(view: WebView, url: String) {
                // The analog of Electron's did-finish-load: flush a book that an
                // intent imported while the page was still loading.
                pageLoaded = true
                pendingOpen?.let { p ->
                    pendingOpen = null
                    openPending = false // handed to the page; the bridge buffers it from here
                    webView.evaluateJavascript("window.__eupubOpenFile(${JSONObject.quote(p)});", null)
                }
                maybeSeedSample()
            }
        }
        // Surface the WebView's JS console (errors, warnings) to logcat.
        webView.webChromeClient = object : android.webkit.WebChromeClient() {
            override fun onConsoleMessage(m: android.webkit.ConsoleMessage): Boolean {
                android.util.Log.i("EupubWeb", "${m.message()} @${m.sourceId()}:${m.lineNumber()}")
                return true
            }
        }
        webView.addJavascriptInterface(Bridge(), "AndroidBridge")
        setContentView(webView)

        copySampleIfNeeded()
        webView.loadUrl("https://eupub.local/assets/reader/index.html")
        handleIntent(intent) // a PDF this activity was launched to open
    }

    // Warm start: a VIEW/SEND intent arriving while the activity is already up
    // (singleTask). The page is loaded, so the imported book delivers immediately.
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    // The URI a PDF intent carries: VIEW puts it in the data, SEND in EXTRA_STREAM.
    @Suppress("DEPRECATION")
    private fun uriFromIntent(intent: Intent?): Uri? = when (intent?.action) {
        Intent.ACTION_VIEW -> intent.data
        Intent.ACTION_SEND -> intent.getParcelableExtra(Intent.EXTRA_STREAM) as? Uri
        else -> null
    }

    // Import a PDF handed in by the OS and hand the reader its internal path. The
    // copy runs off the UI thread; delivery is buffered until the page has loaded.
    private fun handleIntent(intent: Intent?) {
        val uri = uriFromIntent(intent) ?: return
        intentOpen = true // don't seed the sample over an intent-opened book
        openPending = true // the reader must not auto-reopen the last book meanwhile
        io.execute {
            try {
                deliverOpen(importPdf(uri, displayName(uri)).getString("sourcePath"))
            } catch (e: Exception) {
                android.util.Log.w("Eupub", "open-with import failed", e)
                runOnUiThread { openPending = false } // nothing will arrive
            }
        }
    }

    private fun deliverOpen(path: String) {
        runOnUiThread {
            if (pageLoaded && ::webView.isInitialized) {
                openPending = false // handed to the page; the bridge buffers it from here
                webView.evaluateJavascript("window.__eupubOpenFile(${JSONObject.quote(path)});", null)
            } else {
                pendingOpen = path
            }
        }
    }

    override fun onDestroy() {
        lexDb?.close()
        io.shutdownNow()
        super.onDestroy()
    }

    // On first launch, seed the bundled sample book so something renders; after
    // that the last-book pointer exists and the reader reopens it on its own.
    private fun maybeSeedSample() {
        if (seeded || intentOpen) return
        webView.evaluateJavascript("localStorage.getItem('eupub:last')") { v ->
            if (!seeded && (v == null || v == "null")) {
                seeded = true
                val p = File(filesDir, "sample.epub").absolutePath.replace('\\', '/')
                webView.evaluateJavascript(
                    "localStorage.setItem('eupub:last', ${JSONObject.quote(p)}); location.reload();",
                    null
                )
            }
        }
    }

    private fun copySampleIfNeeded() {
        try {
            assets.open("sample.epub").use { input ->
                FileOutputStream(File(filesDir, "sample.epub")).use { input.copyTo(it) }
            }
        } catch (e: Exception) {
            /* no sample bundled — welcome screen only */
        }
    }

    // Settle a pending promise on the JS side (see android-bridge.js).
    private fun resolve(id: Int, ok: Boolean, json: String) {
        val call = "window.__eupubResolve($id, $ok, ${JSONObject.quote(json)});"
        runOnUiThread { if (::webView.isInitialized) webView.evaluateJavascript(call, null) }
    }

    private fun errJson(e: Exception): String =
        JSONObject().put("message", e.message ?: e.toString()).toString()

    // --- lexicon (native SQLite) -------------------------------------------
    private fun lexicon(): SQLiteDatabase {
        lexDb?.let { return it }
        val dbFile = File(filesDir, "lexicon.db")
        if (!dbFile.exists()) {
            assets.open("lexicon.db").use { input ->
                FileOutputStream(dbFile).use { input.copyTo(it) }
            }
        }
        return SQLiteDatabase.openDatabase(dbFile.absolutePath, null, SQLiteDatabase.OPEN_READONLY)
            .also { lexDb = it }
    }

    private fun splitPipe(s: String?): JSONArray {
        val a = JSONArray()
        if (!s.isNullOrEmpty()) for (part in s.split("|")) if (part.isNotEmpty()) a.put(part)
        return a
    }

    // --- EPUB extraction ----------------------------------------------------
    private fun extractEpub(epub: File): JSONObject {
        val rootDir = File(filesDir, "book")
        if (rootDir.exists()) rootDir.deleteRecursively()
        rootDir.mkdirs()
        val rootCanon = rootDir.canonicalPath
        ZipInputStream(BufferedInputStream(FileInputStream(epub))).use { zin ->
            var e = zin.nextEntry
            while (e != null) {
                val outFile = File(rootDir, e.name)
                val canon = outFile.canonicalPath
                // zip-slip guard: entries must stay under rootDir.
                if (canon == rootCanon || canon.startsWith(rootCanon + File.separator)) {
                    if (e.isDirectory) {
                        outFile.mkdirs()
                    } else {
                        outFile.parentFile?.mkdirs()
                        FileOutputStream(outFile).use { zin.copyTo(it) }
                    }
                }
                zin.closeEntry()
                e = zin.nextEntry
            }
        }
        val container = File(rootDir, "META-INF/container.xml").readText()
        val m = Regex(
            "<rootfile\\b[^>]*\\bfull-path\\s*=\\s*[\"']([^\"']+)[\"']",
            RegexOption.IGNORE_CASE
        ).find(container) ?: throw IllegalArgumentException("Invalid EPUB: no rootfile")
        val rel = URLDecoder.decode(m.groupValues[1], "UTF-8")
        val opfPath = File(rootDir, rel)
        currentBookDir = rootDir
        return JSONObject().apply {
            put("kind", "epub")
            put("sourcePath", epub.absolutePath.replace('\\', '/'))
            put("rootDir", rootDir.absolutePath.replace('\\', '/'))
            put("opfDir", (opfPath.parentFile ?: rootDir).absolutePath.replace('\\', '/'))
            put("opfPath", opfPath.absolutePath.replace('\\', '/'))
            put("opfXml", opfPath.readText())
        }
    }

    // --- PDF import ---------------------------------------------------------
    // A PDF is not extracted like an EPUB; it is copied verbatim into
    // filesDir/pdfs and served over https://eupub.local/pdf/<name>, where it
    // clears both the viewer's http/https-only ?file= check and its
    // connect-src 'self' CSP. The renderer opens it in the embedded PDF viewer.

    private fun displayName(uri: Uri): String {
        try {
            contentResolver.query(uri, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null)
                ?.use { c -> if (c.moveToFirst()) c.getString(0)?.let { return it } }
        } catch (_: Exception) { /* fall through to the uri's own last segment */ }
        return uri.lastPathSegment ?: "document"
    }

    private fun isPdf(uri: Uri, name: String): Boolean =
        name.lowercase().endsWith(".pdf") ||
            (try { contentResolver.getType(uri) } catch (_: Exception) { null }) == "application/pdf"

    private fun importPdf(uri: Uri, name: String): JSONObject {
        val dir = File(filesDir, "pdfs").apply { mkdirs() }
        // Sanitize to a URL- and path-safe name, so the served /pdf/<name> needs
        // no encoding and cannot escape the pdfs dir.
        var safe = name.replace(Regex("[^A-Za-z0-9._-]"), "_")
        if (!safe.lowercase().endsWith(".pdf")) safe += ".pdf"
        val dest = File(dir, safe)
        contentResolver.openInputStream(uri)!!.use { input ->
            FileOutputStream(dest).use { input.copyTo(it) }
        }
        return pdfDescriptor(dest)
    }

    private fun pdfDescriptor(file: File): JSONObject =
        JSONObject().apply {
            put("kind", "pdf")
            put("sourcePath", file.absolutePath.replace('\\', '/'))
            put("url", "https://eupub.local/pdf/" + file.name) // name is already safe
            put("title", file.name.removeSuffix(".pdf"))
        }

    // Serves imported PDFs over https://eupub.local/pdf/... — separate from /book/
    // so it can hardcode application/pdf and stay under the AssetLoader's virtual
    // origin (the reason a picked content:// PDF becomes fetchable at all).
    private inner class PdfPathHandler : WebViewAssetLoader.PathHandler {
        override fun handle(path: String): WebResourceResponse {
            val dir = File(filesDir, "pdfs")
            return try {
                val file = File(dir, path)
                if (file.canonicalPath.startsWith(dir.canonicalPath) && file.isFile) {
                    WebResourceResponse("application/pdf", null, FileInputStream(file))
                } else notFound()
            } catch (e: Exception) {
                notFound()
            }
        }

        private fun notFound(): WebResourceResponse =
            WebResourceResponse("text/plain", "utf-8", ByteArrayInputStream(ByteArray(0)))
                .apply { setStatusCodeAndReasonPhrase(404, "Not Found") }
    }

    // Serves the current book's files over https://eupub.local/book/...
    private inner class BookPathHandler : WebViewAssetLoader.PathHandler {
        override fun handle(path: String): WebResourceResponse {
            val dir = currentBookDir ?: return notFound()
            return try {
                val file = File(dir, path)
                if (file.canonicalPath.startsWith(dir.canonicalPath) && file.isFile) {
                    WebResourceResponse(guessMime(file.name), null, FileInputStream(file))
                } else notFound()
            } catch (e: Exception) {
                notFound()
            }
        }

        private fun notFound(): WebResourceResponse =
            WebResourceResponse("text/plain", "utf-8", ByteArrayInputStream(ByteArray(0)))
                .apply { setStatusCodeAndReasonPhrase(404, "Not Found") }
    }

    private fun guessMime(name: String): String {
        val n = name.lowercase()
        return when {
            n.endsWith(".xhtml") || n.endsWith(".html") || n.endsWith(".htm") -> "text/html"
            n.endsWith(".css") -> "text/css"
            n.endsWith(".js") -> "application/javascript"
            n.endsWith(".opf") || n.endsWith(".ncx") || n.endsWith(".xml") -> "application/xml"
            n.endsWith(".jpg") || n.endsWith(".jpeg") -> "image/jpeg"
            n.endsWith(".png") -> "image/png"
            n.endsWith(".gif") -> "image/gif"
            n.endsWith(".svg") -> "image/svg+xml"
            n.endsWith(".webp") -> "image/webp"
            n.endsWith(".ttf") -> "font/ttf"
            n.endsWith(".otf") -> "font/otf"
            n.endsWith(".woff") -> "font/woff"
            n.endsWith(".woff2") -> "font/woff2"
            else -> "application/octet-stream"
        }
    }

    // --- the window.eupub native surface (mirrors src/preload.js) -----------
    private inner class Bridge {
        @JavascriptInterface
        fun openPath(id: Int, argsJson: String) {
            io.execute {
                try {
                    val path = JSONArray(argsJson).getString(0)
                    val f = File(path)
                    when {
                        !f.isFile -> resolve(id, true, "null")
                        path.lowercase().endsWith(".pdf") -> resolve(id, true, pdfDescriptor(f).toString())
                        else -> resolve(id, true, extractEpub(f).toString())
                    }
                } catch (e: Exception) {
                    resolve(id, false, errJson(e))
                }
            }
        }

        // Whether an OS-opened book is still on its way to the page. Answered via
        // the promise registry ON THE UI THREAD — the same thread that issues the
        // __eupubOpenFile delivery — so the answer's evaluateJavascript is queued
        // behind any delivery already sent: by the time a "false" reaches the
        // page, the delivery (if any) has arrived and set the bridge's
        // already-arrived flag. A synchronous @JavascriptInterface getter could
        // overtake the queued delivery and reintroduce the race.
        @JavascriptInterface
        fun hasPendingOpen(id: Int, argsJson: String) {
            runOnUiThread { resolve(id, true, if (openPending) "true" else "false") }
        }

        @JavascriptInterface
        fun pickEpub(id: Int, argsJson: String) {
            pendingPickId = id
            runOnUiThread { picker.launch(arrayOf("application/epub+zip", "application/pdf", "text/plain", "*/*")) }
        }

        @JavascriptInterface
        fun openExternal(id: Int, argsJson: String) {
            try {
                val href = JSONArray(argsJson).getString(0).trim()
                if (Regex("^(https?:|mailto:|tel:)", RegexOption.IGNORE_CASE).containsMatchIn(href)) {
                    runOnUiThread {
                        try {
                            startActivity(
                                Intent(Intent.ACTION_VIEW, Uri.parse(href))
                                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                            )
                        } catch (_: Exception) { /* no handler */ }
                    }
                }
                resolve(id, true, "null")
            } catch (e: Exception) {
                resolve(id, false, errJson(e))
            }
        }

        @JavascriptInterface
        fun lexiconSubset(id: Int, argsJson: String) {
            io.execute {
                try {
                    val words = JSONArray(argsJson).getJSONArray(0)
                    val db = lexicon()
                    val out = JSONArray()
                    for (i in 0 until words.length()) {
                        val w = words.getString(i)
                        db.rawQuery("SELECT enc, pos, sp FROM lex WHERE k = ?", arrayOf(w)).use { c ->
                            if (c.moveToFirst()) {
                                val entry = JSONObject()
                                    .put("encoding", c.getInt(0))
                                    .put("pos", splitPipe(c.getString(1)))
                                    .put("spellings", splitPipe(c.getString(2)))
                                out.put(JSONArray().put(w).put(entry))
                            }
                        }
                    }
                    resolve(id, true, out.toString())
                } catch (e: Exception) {
                    resolve(id, false, errJson(e))
                }
            }
        }
    }
}
