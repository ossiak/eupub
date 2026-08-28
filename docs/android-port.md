# Eupub for Android — Path-A build plan

**Path A** = port Eupub's existing WebView reader stack to Android, rather than
building on the Readium Kotlin toolkit. The decision and its rationale are in the
"Android shell" investigation; the short version: euspell needs to reform each
resource's **live DOM before pagination is measured**, plus dual-spelling search
and a live on/off toggle — all of which Eupub already does and all of which run
against Readium's grain (its only per-resource JS hook, `evaluateJavascript`,
runs *after* a resource is displayed and only on the visible one). So we reuse
Eupub's renderer wholesale and replace only its Electron main process.

## What ports unchanged vs. what is new

The app was deliberately split into a thin main process and a portable renderer.
That split is the port boundary.

| Layer | Source (Electron) | Android |
|---|---|---|
| EPUB model (OPF/nav/NCX → spine + TOC) | `src/renderer/epub.js` | reuse verbatim |
| Reader UI (paging, position, bookmarks, highlights, dual-spelling search, toggle) | `src/renderer/reader.js` | reuse; **add touch paging** |
| In-resource runtime (columns, locators, marks, link routing) | `src/renderer/viewer-runtime.js` | reuse; **add touch/tap handlers** |
| Styles | `src/renderer/reader.css` | reuse; add mobile breakpoints |
| euspell engine | `dist/eupub-engine.js` + injectable lexicon | ship engine; **SQLite lexicon adapter** |
| `window.eupub` bridge | `src/preload.js` | **new: Kotlin `@JavascriptInterface` + promise bridge** |
| EPUB extract / text open | `src/epub-extract.js`, `src/text-open.js` | **new: Kotlin (java.util.zip)** |
| File pick / IO / external links | `src/main.js` IPC | **new: SAF, WebViewAssetLoader, ACTION_VIEW** |

Net: the ~1700 lines of debugged, security-hardened renderer are reused; the new
code is a Kotlin shell, the bridge, resource serving, the lexicon adapter, and
touch input.

## Host shape

- **Single-Activity + one WebView.** Compose optional (host the WebView in an
  `AndroidView`); not required. The reader UI is all HTML/CSS/JS already.
- **minSdk 26+ (Android 8).** WebView is Play-updatable, so V8 is current; no
  engine-age worry. Enable `WebSettings.javaScriptEnabled`, `domStorageEnabled`
  (localStorage — the renderer persists prefs/position/bookmarks/highlights there).
- **androidx.webkit** for the modern surfaces we need: `WebViewAssetLoader`
  (serve extracted books over a virtual https origin) and `WebMessageListener`
  or `evaluateJavascript` callbacks (async bridge).

## The bridge: reproducing `window.eupub`

The renderer calls a 9-method `window.eupub`. Five are async (Promise-returning
in Electron); four are pure sync string helpers. `@JavascriptInterface` methods
are **synchronous** and can only pass strings, so:

- **Sync pure helpers** map directly to synchronous `@JavascriptInterface`
  methods returning strings.
- **Async methods** use a **promise-registry bridge**: JS wraps the call in a
  Promise stored by id; Kotlin does the work off the UI thread and resolves by
  calling back `webView.evaluateJavascript("__eupubResolve(id, json)")`. This
  keeps `window.eupub`'s async shape identical, so `reader.js`/`epub.js` need no
  changes.

| `window.eupub` method | Kind | Android implementation |
|---|---|---|
| `pickEpub()` | async | SAF `ACTION_OPEN_DOCUMENT` (epub/txt), then open |
| `openPath(path)` | async | extract EPUB (java.util.zip) / synthesize from txt → book object |
| `engineSource()` | async | read bundled `eupub-engine.js` from assets |
| `readText(path)` | async | read a chapter file from the extracted book dir (off-thread) |
| `openExternal(href)` | async | `Intent(ACTION_VIEW)`, scheme-allowlisted (http/mailto/tel) |
| `join`, `dirname`, `basename` | sync | trivial path string ops in Kotlin/JS |
| `fileURL(path)` | sync | **return a virtual https URL, not file://** (see below) |

A thin JS shim (`android-bridge.js`, replacing `preload.js`) defines
`window.eupub` over `AndroidBridge` + `__eupubResolve`, so the renderer is
untouched.

### Resource origin: file:// → virtual https

Eupub builds each chapter iframe with a `file://` base href and loads chapter
resources (images/CSS) relative to it. Android WebView restricts `file://` and
handles CSP/origin differently, so serve the extracted book over a virtual
origin via **`WebViewAssetLoader`** with a custom `PathHandler` rooted at the
book's temp dir:

- `fileURL(absPath)` returns `https://eupub.local/book/<relpath>`.
- The base href, `readText`, and all chapter resource loads resolve against that
  one origin — a single, well-defined security boundary.

**Verified during renderer prep:** `reader.js` / `epub.js` / `viewer-runtime.js`
contain **no hardcoded `file://`** — every URL goes through `window.eupub.fileURL`
(base href, spine URLs, navigate matching) and every read through
`window.eupub.readText`. So the origin seam is already the bridge boundary and the
shared renderer needs **no change**; `android-bridge.js` returns the virtual-origin
URL and `readText` becomes a `fetch` against it. The only platform-specific
renderer asset is **`index.html`**, which the Android build supplies with exactly
two deltas:

1. **Load the bridge instead of the preload** — add `<script src="android-bridge.js">`
   before `epub.js` (the desktop build gets `window.eupub` from the Electron
   preload; the Android build gets it from this shim). Don't ship both.
2. **CSP origins** — the srcdoc chapter *inherits* this document's CSP, and chapter
   resources now load from the virtual origin, so replace the `file:`/`data:` hosts
   with `https://eupub.local` for `default/img/style/font/frame`-src and add it to
   `connect-src` (the `readText`/`engineSource` fetches). Keep `'unsafe-inline'`
   for scripts (the injected engine/runtime) and the sanitizer that makes it safe.

Because these two are the bridge wiring and a `<meta>` CSP — both parse-time — the
Android `index.html` is a shell artifact, not a fork of renderer logic.

## euspell engine + lexicon (already de-risked)

Use the injectable-lexicon work from `euspell_ext`:

- Ship the engine bundle (built with the lexicon **excluded** — alias
  `lexicon-source.js` to the no-baked-in variant so the ~14 MB tree-shakes out).
- Ship `dist/lexicon.db` (4.6 MB) as an app asset (SQLite, native on Android).
- Per chapter, before conversion: collect the chapter's unique vocabulary with
  the engine's `tokenize`, query the DB for that subset (through the bridge, off
  the UI thread), build the subset Map, `setLexicon(subset)`, then run the normal
  `walkTextNodes`/`convert`. Proven byte-identical to the full table across all
  5903 disambiguating words; resident cost ~0.4 MB/chapter vs ~79 MB.
- Budget ~150–250 ms/chapter for the subset fetch on a mid-range phone — run it
  off the main thread and it overlaps rendering.

## Touch paging (new renderer code)

`viewer-runtime.js` currently pages on `wheel` + `keydown`. Add touch, reusing
the same `nextPage()`/`prevPage()` + edge-turn postMessage the wheel handler uses:

- **Swipe**: on `touchstart`/`touchend`, a quick horizontal drag past a
  threshold with |dx| > |dy| turns the page (left→next, right→prev).
- **Tap zones**: a tap (no drag) in the left third pages back, right third pages
  forward, center third toggles the reader chrome.
- **Don't fight selection.** Native WebView text selection begins with a
  long-press; the swipe handler must ignore gestures that started a selection
  (check `document.getSelection().isCollapsed` / gesture duration) so the
  highlight flow still works. This is the one genuinely mobile-specific
  interaction to get right.

Sketch (in `viewer-runtime.js`, paginated branch):

```js
var tsx = 0, tsy = 0, tst = 0;
document.addEventListener('touchstart', function (e) {
  var t = e.changedTouches[0]; tsx = t.clientX; tsy = t.clientY; tst = Date.now();
}, { passive: true });
document.addEventListener('touchend', function (e) {
  var t = e.changedTouches[0], dx = t.clientX - tsx, dy = t.clientY - tsy;
  if (!document.getSelection().isCollapsed) return;        // a selection, not a page turn
  if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) {   // swipe
    if (dx < 0) { if (!nextPage()) post('eupub:key', { key: 'ArrowRight' }); }
    else        { if (!prevPage()) post('eupub:key', { key: 'ArrowLeft'  }); }
  } else if (Math.abs(dx) < 10 && Math.abs(dy) < 10 && Date.now() - tst < 250) {
    var third = document.documentElement.clientWidth / 3;   // tap zones
    if (tsx < third)      { if (!prevPage()) post('eupub:key', { key: 'ArrowLeft'  }); }
    else if (tsx > 2*third){ if (!nextPage()) post('eupub:key', { key: 'ArrowRight' }); }
    else post('eupub:toggleChrome');
  }
}, { passive: true });
```

## Security carryover

The threat model is unchanged (untrusted EPUB), and matters **more** on Android:
a WebView has no process isolation, so the `@JavascriptInterface` bridge is the
entire trust boundary. Everything from the recent Eupub hardening carries over
directly and must be kept:

- `sanitizeChapterDoc` (strip scripts, nested browsing contexts, `on*` handlers,
  `javascript:` URLs) before a chapter is shown or indexed.
- `jsonForScript` `<`-escaping of injected config.
- Message-source checks on postMessage.
- Least-privilege bridge: `readText` refuses paths outside the open book's dir;
  `openExternal` allowlists http/mailto/tel.

Additionally: annotate only the minimal bridge methods with `@JavascriptInterface`
(nothing else is reachable from JS), and scope `WebViewAssetLoader` to the book
dir only.

## Milestones (each independently observable on-device)

- **M0 — Scaffold.** Single-Activity WebView loads a hello page.
  *Verify:* app launches, WebView renders.
- **M1 — Reader assets.** Bundle `epub.js`/`reader.js`/`viewer-runtime.js`/
  `reader.css`/`index.html` into assets; load `index.html`.
  *Verify:* welcome screen renders, no console errors (chrome://inspect).
- **M2 — Bridge + resource serving.** Promise-registry bridge + WebViewAssetLoader;
  bundle a sample EPUB, auto-open it.
  *Verify:* chapter renders in original spelling; prev/next buttons paginate.
- **M3 — Engine + SQLite lexicon.** Ship engine (lexicon-excluded) + `lexicon.db`;
  wire per-chapter subset; toggle reforms.
  *Verify:* text shows reformed spelling (`peeple`, `thoht`); toggle on/off works.
- **M4 — Touch paging.** Swipe + tap zones; selection still works.
  *Verify:* swipe turns pages; tap zones page/­toggle; long-press selects → Highlight.
- **M5 — Open + persist.** SAF picker for epub/txt; recents; localStorage
  position/bookmarks/highlights; reopen last book on launch.
  *Verify:* open a real book, close app, reopen → resumes at the same spot.
- **M6 — Mobile polish.** Dark mode (follow system), font scaling, hardware Back =
  page back then exit, external links, corrupt-file handling, status/inset
  handling (notch/gesture bar).
  *Verify:* each behavior on a device.
- **M7 — Packaging.** App signing, icon/splash, Play Store listing; scoped-storage
  compliance review.
  *Verify:* signed release APK installs and runs on a clean device.

## Risks / open questions

- **Async bridge latency.** The promise-registry adds a round-trip per call;
  chapter reads and lexicon fetches must be off the UI thread. Low risk, but
  measure `readText` on large chapters.
- **Pagination across weird book CSS.** Eupub's column pitch has needed several
  fixes for books that style `body`; mobile viewport + system font scaling widen
  the test matrix. Reuse Eupub's `features.js` assertions as a device test.
- **Memory on low-end devices.** Engine code + book DOM + WebView baseline; the
  SQLite lexicon keeps the big cost off-heap, but profile a large book on a
  2–3 GB device.
- **Selection vs. swipe.** The one interaction to tune (see touch section).
- **WebView variance.** Rare on modern Android (updatable WebView), but pin a
  minimum WebView version and degrade gracefully.

## Reusing Eupub's tests

`test/features.js` (viewer mechanics over postMessage) and the pagination
alignment sweep are the highest-value regression checks; run them against the
Android WebView (via `chrome://inspect` or an instrumented test) so the ported
`viewer-runtime.js` is verified on the real engine, not just desktop Chromium.
```
