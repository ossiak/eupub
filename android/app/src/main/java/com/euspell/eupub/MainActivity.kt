package com.euspell.eupub

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
                    val tmp = File(cacheDir, "picked-" + System.currentTimeMillis() + ".epub")
                    contentResolver.openInputStream(uri)!!.use { input ->
                        FileOutputStream(tmp).use { input.copyTo(it) }
                    }
                    resolve(id, true, extractEpub(tmp).toString())
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
            .build()

        webView = WebView(this)
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mediaPlaybackRequiresUserGesture = true
        }
        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest
            ): WebResourceResponse? = assetLoader.shouldInterceptRequest(request.url)

            override fun onPageFinished(view: WebView, url: String) {
                maybeSeedSample()
            }
        }
        webView.addJavascriptInterface(Bridge(), "AndroidBridge")
        setContentView(webView)

        copySampleIfNeeded()
        webView.loadUrl("https://eupub.local/assets/reader/index.html")
    }

    override fun onDestroy() {
        lexDb?.close()
        io.shutdownNow()
        super.onDestroy()
    }

    // On first launch, seed the bundled sample book so something renders; after
    // that the last-book pointer exists and the reader reopens it on its own.
    private fun maybeSeedSample() {
        if (seeded) return
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
            put("sourcePath", epub.absolutePath.replace('\\', '/'))
            put("rootDir", rootDir.absolutePath.replace('\\', '/'))
            put("opfDir", (opfPath.parentFile ?: rootDir).absolutePath.replace('\\', '/'))
            put("opfPath", opfPath.absolutePath.replace('\\', '/'))
            put("opfXml", opfPath.readText())
        }
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
                    if (f.isFile) resolve(id, true, extractEpub(f).toString())
                    else resolve(id, true, "null")
                } catch (e: Exception) {
                    resolve(id, false, errJson(e))
                }
            }
        }

        @JavascriptInterface
        fun pickEpub(id: Int, argsJson: String) {
            pendingPickId = id
            runOnUiThread { picker.launch(arrayOf("application/epub+zip", "text/plain", "*/*")) }
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
