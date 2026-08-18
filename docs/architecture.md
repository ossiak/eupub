# Eupub — Architecture

How Eupub is put together, why, and where its edges are. Eupub is a standalone
Windows desktop reader (Electron) that renders **EPUB** and **plain-text** books in
**euspell** reformed spelling, reusing the euspell conversion engine from the sibling
`euspell_ext` project without modification.

## Guiding idea

The one load-bearing decision: **reuse the euspell engine as-is by making every
readable thing a DOM the engine can walk.** The browser extension respells a web
page by running `walkTextNodes(document.body, convert)` over the page DOM. An EPUB
chapter is an XHTML document; a plain-text file can be turned into one. So Eupub
never re-implements conversion — it *arranges for a chapter document to exist* and
then runs the exact same `convert()` + `walkTextNodes()` pair inside it.

Everything else in the architecture follows from that: extract/synthesize a book to
disk, parse its structure, render each chapter in an iframe, and inject the bundled
engine so the global `document` is the chapter.

## Process & trust model

Electron splits into a privileged **main** process and a **renderer**; Eupub adds a
per-chapter sandboxed iframe as a third tier.

```text
┌─ main process (Node) ─────────────┐     ┌─ renderer (chrome) ───────────────────┐
│ src/main.js                       │ IPC │ src/renderer/index.html               │
│  • window lifecycle               │◄───►│  • reader.js   (top-frame UI/state)   │
│  • openBook: extract EPUB /       │     │  • epub.js     (OPF/nav/NCX → model)  │
│    synthesize .txt (text-open.js) │     │                                       │
│  • fs:readText, engine:source     │     │   ┌─ chapter <iframe srcdoc> ──────┐  │
│  • temp-dir cleanup on quit       │     │   │ chapter XHTML (scripts stripped)│  │
└───────────────────────────────────┘     │   │ + injected engine bundle        │  │
        ▲ preload.js (contextBridge)       │   │ + viewer-runtime (pagination)   │  │
        └──────────────────────────────────┘   └─────────────────────────────────┘  │
                                            └───────────────────────────────────────┘
```

- **Main** is the only tier with Node/filesystem access. It owns the window, opens
  books, and serves chapter text and the engine source over IPC.
- **Renderer** (top frame) runs the reader UI and parses book structure. It has **no**
  Node integration; its bridge to main is the small `window.eupub` surface exposed by
  `src/preload.js` (`pickEpub`, `openPath`, `engineSource`, `readText`, and pure path
  helpers `join`/`dirname`/`basename`/`fileURL`).
- **Chapter iframe** is where untrusted book content lives. Its own scripts are
  stripped before injection, and only our engine + viewer runtime run there.

The preload runs with `sandbox: false` (so it can `require('node:path')`/`url`) but
`contextIsolation: true`, keeping that Node access off the page's `window`. Untrusted
EPUB markup only ever executes in the sandboxed iframe, never in the top frame.

## The engine reuse

`src/engine/eupub-engine.js` is the **only** new code that touches the engine, and it
only *calls* it:

```js
import { convert }        from '../../../euspell_ext/src/content/converter.js';
import { walkTextNodes }  from '../../../euspell_ext/src/content/dom-walker.js';
```

`rollup.engine.config.mjs` bundles this into `dist/eupub-engine.js` (an IIFE, ~14 MB —
it pulls in `euspell_ext`'s compiled lexicon, tagger, SVM, and disambiguation rules
through their own relative imports). Consequences:

- **`euspell_ext/dist/*` must be built first** — the bundle imports the compiled
  lexicon from there. Re-run `npm run build:engine` after changing `euspell_ext/src`
  or rebuilding `euspell_ext/dist`.
- **Two run modes, one bundle.** Injected into a chapter iframe with no flag, the
  bootstrap auto-runs `walkTextNodes(document.body, convert)` and respells the
  chapter. Injected into the reader top frame with `window.__eupubNoAuto = true`, it
  exposes `window.EupubEngine = { convert, walkTextNodes }` **without** reforming the
  reader's own UI — used to build a euspell search index by reforming a detached
  clone (see Search).

## Opening a book — two front doors, one shape

Both open paths in `main.js` funnel through `openBook(filePath)`, which dispatches on
extension and returns an identical book object
`{ sourcePath, rootDir, opfDir, opfPath, opfXml }`:

| Input | Module | What it does |
| --- | --- | --- |
| `.epub` | `src/epub-extract.js` | `adm-zip` unzips to a temp dir; reads `META-INF/container.xml` → the OPF path |
| `.txt` | `src/text-open.js` | Synthesizes an EPUB-shaped book on disk: paragraphs → chapter files, a nav doc, a minimal OPF |

Because both yield the same shape, **nothing downstream knows or cares** which one
ran. The plain-text path (see `docs/plain-text-support.md`) is the clearest proof of
the guiding idea: strip a BOM, split into paragraphs, chapter on headings (or a
200-paragraph cap), write HTML5 chapters + a well-formed XHTML `nav.xhtml` + an EPUB3
OPF, and hand the renderer the same object an unzip would.

## Rendering a chapter — the data flow

```text
openBook ─► book{opfXml,opfDir}
   │
   ▼  renderer
EupubModel.parseAsync(book)        src/renderer/epub.js
   │   OPF → {title, spine[], toc}; nav/NCX read over IPC upgrades the TOC
   ▼
reader.renderChapter(spineItem)    src/renderer/reader.js
   │   1. fs:readText(absPath)  → chapter XHTML
   │   2. strip <script>s from the chapter (untrusted)
   │   3. insert <base href="file://…/"> so relative resources resolve
   │   4. append engine bundle as an inline <script>
   │   5. set iframe.srcdoc = result
   ▼
chapter iframe load → engine auto-runs → walkTextNodes(document.body, convert)
   ▼
viewer-runtime injected → pagination, locators, highlight/search marks
```

`src/renderer/epub.js` is pure parsing (no DOM rendering): it reads the OPF manifest
+ spine synchronously, and `parseAsync` then reads the EPUB-3 `nav` (or EPUB-2 NCX)
over IPC to build a real hierarchical TOC, falling back to a spine-derived flat TOC.

`src/renderer/reader.js` (~1000 lines) is the app's center of gravity: chapter
rendering and engine injection, the euspell on/off toggle (re-renders, keeping
place), font/theme controls, reading-position persistence, bookmarks, highlights, and
book-wide search.

`src/renderer/viewer-runtime.js` (~460 lines) runs *inside* each chapter iframe:
CSS-multi-column pagination, page locators, and highlight/search marks. It is authored
as `window.EupubViewerRuntime = function(){…}` and injected via `(<fn>.toString())()`
with config on `window.__eupubConfig`, so it stays lintable/testable while running in
the chapter document.

## Cross-cutting: position, search, highlights vs. euspell

The converter **only rewrites text-node values, never structure**. That invariant is
what makes the reader features robust across the euspell toggle:

- **Structure-based locators.** Reading position, bookmarks, and search targets are
  element-only paths from `body`. Text values change when euspell flips; the element
  tree doesn't — so a locator stays valid in either mode. The last book and spot
  reopen on launch.
- **Character-offset anchors.** Highlights and in-page search marks add an element
  path plus a character offset (via a `Range`, so it works at element or text
  boundaries). Offsets are exact *within* a spelling mode; toggling euspell re-renders
  and re-applies them.
- **Dual-spelling search.** Book-wide search indexes the **original** on-disk spelling
  but also reforms a detached clone of each block (via `EupubEngine`, reader-side, no
  auto-run), so a query for either `people` or `peeple` finds the same spot. Matches
  are highlighted by **word index** (euspell preserves word order), so the reformed
  word itself stays highlighted.

## Pagination

Paged view is CSS multi-column with `transform: translateX` page steps. Two subtle
constraints, both handled in the viewer runtime's `applyColumns()`:

- **Column pitch must equal the transform step.** All geometry is computed in pixels
  from `document.documentElement.clientWidth` (not CSS `calc(100vw)`), and the same
  value drives `translateX`, so display scaling / scrollbars can't desync them.
- **The EPUB's own `body` CSS is neutralized.** Books ship `max-width`, `margin:auto`,
  fixed widths, or `column-count` that would constrain the column box; the runtime
  overrides those with `!important` so the column pitch matches the viewport.

Page math is derived from `elementRect.left − body.getBoundingClientRect().left` (both
carry the same transform, so it cancels) → stable page regardless of mid-transition
animation.

## Security model

- **Chapter content is sanitized** in `reader.js` (`sanitizeChapterDoc`) before
  injection: `<script>` elements, nested browsing contexts (`iframe`/`object`/
  `embed`), inline `on*` event handlers, and `javascript:` URLs are all removed —
  the srcdoc iframe is same-origin with the top frame (it needs
  `allow-same-origin` + `allow-scripts` for the engine/runtime), so nothing from
  the book may execute there. The same sanitizer runs before the search index
  imports chapter nodes into the reader document.
- **Injected config is `<`-escaped** (`jsonForScript`) so a book-controlled string
  (e.g. a TOC fragment) containing `</script>` can't break out of the boot script
  when the srcdoc is serialized.
- **Untrusted markup is confined** to the sandboxed `srcdoc` iframe; the top frame
  (with the preload's Node bridge) never hosts book content, and it only accepts
  postMessages whose source is the current chapter iframe.
- **IPC is least-privilege**: `fs:readText` refuses paths outside the open book's
  extraction dir, and `shell:openExternal` allowlists `http(s):`/`mailto:`/`tel:`
  in the main process.
- **CSP is deliberately relaxed** to `'unsafe-inline'` scripts plus `file:`/`data:`
  resources, because the engine is injected as an inline `<script>` and a strict
  `script-src 'self'`/`frame-src 'self'` silently blocks both the inline engine and
  the `srcdoc` frame (which then never fires `load` → hang). The relaxation is
  mitigated by the sanitizing + sandbox above.

## Build & packaging

- `npm run build:engine` — rollup bundles the engine (needs `euspell_ext/dist`).
- `npm start` / `npm run dev` — launch Electron (start builds the engine first).
- `npm run dist` — electron-builder → a single NSIS installer
  (`release/eupub-Setup-<version>.exe`). Release builds are Authenticode-signed
  in CI; a local `dist` is not, so SmartScreen warns about it.
- `npm run package` — `@electron/packager` → an unpacked `out/…` folder.
- `npm test` — offscreen-Electron tests: `pipeline.js` (EPUB parse+engine),
  `text-pipeline.js` (plain-text parse+engine), `features.js` (viewer mechanics over
  postMessage), `reader-e2e.js` (real reader wiring, incl. injected input events).

## Limitations & known constraints

**Scope / platform**
- **macOS builds are arm64 only.** `release.yml` produces a signed Windows
  installer, a notarized macOS disk image, a Linux AppImage and a signed Android
  APK, but no Intel Mac build.
- **iOS is not released.** It is in App Store review; until it clears, an iPhone
  build has to be made from source.
- **EPUB, PDF and TXT only.** No MOBI/AZW, DOCX, or HTML-file input. EPUB and TXT
  go through the chapter pipeline; a PDF is fixed-layout, so it opens in the
  embedded PDF.js viewer instead of through `EupubModel`.

**Engine coupling**
- **Hard dependency on `euspell_ext/dist`** via a relative import path
  (`../../../euspell_ext/...`); the two repos must sit side by side and the euspell
  build must be current, or the engine bundle is stale/broken.
- **~14 MB engine bundle** (carries the compiled lexicon) is injected into **every**
  chapter iframe — a real per-chapter memory/parse cost.

**Rendering fidelity**
- **No EPUB scripting** (stripped) and no fixed-layout handling — fixed-layout or
  heavily interactive EPUBs won't lay out or paginate as intended.
- **Reflow assumption.** Pagination assumes reflowable single-column content; unusual
  book CSS is only partly neutralized.
- **Whole chapter per iframe.** A very large EPUB chapter can stutter; plain-text
  bounds this with a 200-paragraph cap, but EPUB chapter size is the book's.

**Plain text**
- **UTF-8 (+ BOM) only.** Latin-1 / UTF-16 (beyond BOM detection) will mojibake.
- **Prose assumption.** Wrapped lines are joined into paragraphs, so intentional
  intra-paragraph line breaks (poetry, addresses) are lost.
- **Heuristic chaptering.** Chapters split on `chapter`/`part`/… headings or a fixed
  cap; unconventional structure yields generic "Section N" chapters.

**Feature edges**
- **Search indexes original spelling**; it reforms clones to also match euspell, but
  navigation lands on the block, and the on-screen word may be reformed.
- **Character-offset anchors are per-spelling-mode** — correct, but recomputed on each
  toggle rather than stored mode-independently.
- **Non-linear spine items** (`linear="no"`) are excluded from the spine-derived TOC.

**Environment note (dev)**
- Some shells export `ELECTRON_RUN_AS_NODE=1`, which makes the `electron` binary run
  as plain Node (so `require('electron')` returns a path and `app` is undefined);
  unset it before launching Eupub or its tests.
