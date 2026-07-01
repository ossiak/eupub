# Plain-text (.txt) support in Eupub

A design note.

**Purpose.** Let Eupub open and read a plain `.txt` file — a Project Gutenberg
book, a pasted article, any UTF-8 prose — with the same euspell reforming, view
toggle, pagination, search, bookmarks, and highlights it gives an EPUB. Today Eupub
is EPUB-only at two layers: the file picker filters to `.epub`
(`src/main.js`), and every open path funnels through `openEpub` →
`src/epub-extract.js`, which does `new AdmZip(filePath)` and reads
`META-INF/container.xml`. A `.txt` is not a ZIP, so it throws before anything
renders.

## The key idea: synthesize an EPUB-shaped book, change nothing downstream

The renderer, engine, and viewer never touch the EPUB container — they operate on a
**book object** and a **DOM**. `openEpub` returns
`{ sourcePath, rootDir, opfDir, opfPath, opfXml }`; the renderer's
`EupubModel.parse(book)` reads `opfXml` into a spine of chapter files on disk, and
`reader.js` loads each chapter by `absPath` via the `fs:readText` IPC and injects it
(plus the engine bundle) into an iframe where `walkTextNodes(document.body, convert)`
runs.

So the cleanest way to add `.txt` is to **make a text file look like a tiny EPUB on
disk** — one synthesized XHTML chapter plus a minimal OPF — and hand the renderer the
exact same book shape. Nothing in the renderer, engine, or viewer needs to know the
source was plain text. This mirrors how the extension routes a raw string through the
real DOM pipeline via a detached container rather than re-implementing conversion:
reuse the whole machine, feed it a synthesized input.

(The alternative — a parallel `kind: 'text'` model with branches in `epub.js`,
`reader.js`, and the viewer — spreads format-awareness across the renderer for no
gain. Rejected.)

## What is built vs. new

Reused unchanged: `EupubModel.parse`, the engine bundle injection, `viewer-runtime.js`
(pagination/locators/highlights), `reader.js` (view mode, search, bookmarks), and the
`fs:readText` chapter loader.

New, all in the main process:

1. **Picker filter.** Add a `Text files (*.txt)` filter (and/or "All files") beside
   the EPUB filter in the `epub:pick` handler (`src/main.js`).
2. **Extension dispatch.** Both open paths — `epub:pick` and `epub:openPath` (the
   "reopen last book" path) — branch on the file extension: `.epub` → `extractEpub`,
   `.txt` → a new `openText`. Everything else (temp-dir bookkeeping, cleanup on quit)
   is identical.
3. **`openText(filePath)`** — a sibling of `openEpub` that:
   - `mkdtemp`s a temp dir (tracked for cleanup exactly like an extracted EPUB);
   - reads the file as UTF-8, strips a BOM, normalizes newlines;
   - converts the text to a minimal XHTML chapter (below) and writes it into the
     temp dir;
   - synthesizes a minimal OPF string naming that one chapter in the manifest and
     spine, with the title derived from the filename;
   - returns the same `{ sourcePath, rootDir, opfDir, opfPath, opfXml }` shape.
     (No `container.xml` needed — the renderer consumes `opfXml` directly; only
     `extractEpub` reads the container.)

## Text → XHTML

Prose, not `<pre>`: the reader reflows and paginates with CSS multi-column, which a
`<pre>` block (no wrapping) would break. So:

- Split on blank-line boundaries into paragraphs; within a paragraph, join wrapped
  lines with a space (Gutenberg-style hard-wrapped prose reflows correctly).
- HTML-escape `& < >` so the text can't inject markup (the chapter is our own HTML
  with no scripts, so it is safe to inject — no EPUB script-stripping needed).
- Wrap in a minimal, standards-mode XHTML document with a `<title>` and a single
  content root, so the engine's `walkTextNodes` and the viewer's column layout see an
  ordinary body.

## Chaptering

A whole book as one giant chapter works (the viewer paginates within a chapter) but
has two costs: one enormous iframe (memory/layout), and a one-entry table of
contents. A simple, optional splitter improves both:

- Split into pseudo-chapters on a heading heuristic (lines matching
  `^\s*(chapter|part|book)\b` or a run of blank lines) or, failing that, a
  max-paragraphs-per-chapter cap.
- Emit one XHTML file per pseudo-chapter and list them in spine order; the
  spine-derived TOC (`tocFromSpine`) then gives navigable sections for free.

Default to the cap so even an unstructured dump paginates in bounded chunks; treat
the heading heuristic as a refinement.

## Edge cases

- **Encoding.** v1 assumes UTF-8 and strips a leading BOM. Latin-1 / UTF-16 files
  will mojibake; detect a UTF-16 BOM at minimum, and leave pluggable decoding as a
  follow-up.
- **Very large files.** The chaptering cap bounds per-iframe size; without it a
  50 000-line file is one chapter and layout will stutter.
- **Empty / whitespace-only file.** Produce a single empty chapter rather than
  throwing, so the reader opens cleanly.
- **Anchors and persistence.** Structure-based anchors (element path from body) and
  bookmarks work unchanged because the synthesized chapters have stable structure;
  the "last book" path stores the original `.txt` path and reopens via the same
  extension dispatch.
- **CSP.** No change: the synthesized chapter is our own script-free HTML, already
  within the renderer CSP that permits the srcdoc iframe and the inline engine.

## Build path

`openText` belongs beside `openEpub` (either in `src/epub-extract.js`, renamed in
spirit to "book open," or a new `src/text-open.js`) so `main.js` stays thin and both
share the temp-dir/cleanup contract. A `test/` case mirrors `test/pipeline.js`: run
`openText` on a small fixture `.txt`, `EupubModel.parse` the result, assert a spine of
≥1 chapters, and confirm a chapter reforms through the engine (e.g. contains a known
euspelling). No renderer or viewer test changes are required, which is the whole point
of the synthesize-a-book approach.

## Recommendation

Add `.txt` by synthesizing a minimal on-disk EPUB in the main process and dispatching
both open paths by extension. The only real code is `openText` (a temp dir holding
the text→XHTML chapters plus a minimal OPF) and the picker filter; the renderer,
engine, and viewer are untouched. Ship UTF-8 with BOM handling and a paragraph
splitter with a max-paragraphs chapter cap first; treat heading-based chaptering and
broader encodings as refinements.

A sensible first step is `openText` + the pipeline test on a Gutenberg `.txt`,
validating that one synthesized chapter reforms and paginates, before adding
chaptering and the picker wiring.

## Status — what is built

Implemented.

- **`src/text-open.js`** — `openText(filePath)`: strips a BOM, normalizes newlines,
  splits into paragraphs (blank-line boundaries, wrapped lines joined), chapters
  them (at `chapter`/`part`/… headings when ≥2, else a 200-paragraph cap), writes
  one HTML5 chapter file per chapter plus a well-formed XHTML `nav.xhtml` and a
  minimal EPUB3 OPF into a temp dir, and returns the same
  `{ sourcePath, rootDir, opfDir, opfPath, opfXml }` shape as `openEpub`.
- **`src/main.js`** — the picker gains `Text files (*.txt)` (and a combined "Books")
  filter; both open paths dispatch through `openBook`, which branches on the `.txt`
  extension (`openText`) vs. EPUB (`extractEpub`), sharing the temp-dir cleanup.
- **`test/text-pipeline.js`** (wired into `npm test`) — synthesizes a `.txt` fixture
  (BOM, CRLF, two chapter headings, a wrapped paragraph), runs it through the real
  renderer/preload/engine, and asserts the title, a 2-chapter spine, the nav-derived
  TOC (`Chapter One | Chapter Two`), and that chapter 1 reforms (`peeple`, `thoht`).
  The existing EPUB `test/pipeline.js` still passes unchanged.

The renderer, engine, and viewer were not touched — the whole point of the
synthesize-a-book approach.

Deferred (noted above): non-UTF-8 encodings beyond BOM stripping, heading-based
chaptering refinements, and preserving intra-paragraph line breaks (poetry).
