# Eupub

A standalone **EPUB and PDF reader** that renders books in **euspell** reformed
spelling. It runs as an Electron desktop app on **Windows**, **macOS**, and **Linux**, and as native
**Android** and **iOS** apps. Eupub reuses the euspell conversion engine **as-is** from the sibling
[`euspell_ext`](https://github.com/ossiak/euspell) project — the same `convert()` + `walkTextNodes()`
pair that drives the browser extension and the PDF viewer. Nothing in the engine
is re-implemented or modified here.

> **Just want to install it?** See [docs/installing.md](docs/installing.md) for
> per-platform steps (Windows, macOS, Linux, Android, iOS). The rest of this README is for
> building and hacking on it.

## How the reuse works

An EPUB chapter is an XHTML document, so the engine that walks and respells a
webpage's DOM applies to it unchanged. The only requirement is that, when the
engine runs, the global `document` is the chapter's document. Eupub guarantees
that by:

1. Extracting the EPUB (a ZIP) to a temp directory (`adm-zip`, main process).
2. Parsing the OPF for the spine (reading order) and the nav/NCX for the TOC.
3. Rendering each spine document inside a sandboxed `<iframe srcdoc>`.
4. **Injecting the bundled engine into that iframe**, where it converts the
   chapter in place.

```text
src/engine/eupub-engine.js   imports euspell_ext converter.js + dom-walker.js
        │  (rollup → IIFE)
        ▼
dist/eupub-engine.js  ──injected──►  chapter <iframe>  ──►  euspell text
```

The engine bundle pulls in `euspell_ext`'s compiled lexicon, tagger, and
disambiguation rules via their own relative imports, so `euspell_ext/dist/*`
must be built first (it already is in this repo).

## Project layout

| Path | Role |
| --- | --- |
| `src/main.js` | Electron main: window, EPUB extraction, IPC |
| `src/preload.js` | contextBridge API exposed to the renderer |
| `src/engine/eupub-engine.js` | Bootstrap that calls the reused engine (bundled) |
| `src/renderer/epub.js` | OPF / nav / NCX parsing → spine + TOC |
| `src/renderer/reader.js` | Reader UI: chapter rendering, injection, toggle, prefs |
| `rollup.engine.config.js` | Bundles the engine into `dist/eupub-engine.js` |

## Run

```sh
npm install
npm start        # builds the engine bundle, then launches Electron
```

`npm run build:engine` rebuilds only the engine bundle (re-run it after changing
anything under `euspell_ext/src` or rebuilding `euspell_ext/dist`).

## Build a standalone installer (recommended)

```sh
npm run dist          # Windows  → release/eupub-Setup-<version>.exe (NSIS installer)
npm run dist:linux    # Linux    → release/*.AppImage (single portable binary)
npm run dist:mac      # macOS    → release/Eupub-<version>-arm64.dmg (Apple Silicon; run on a Mac)
```

Each builds the engine bundle and runs **electron-builder** for that platform.
First run downloads electron-builder's toolchain; the Electron runtime comes from
the local cache.

The Windows target is a single-file NSIS installer (`oneClick: false`): the user
picks an install location and gets Start-menu/desktop shortcuts and an
uninstaller. It installs to `%LOCALAPPDATA%\Programs\eupub` by default and
launches fast (extracted once). The icon is the committed `build/icon.ico`.

> A build of your own is **unsigned**, so Windows SmartScreen shows an "unknown
> publisher" prompt ("More info → Run anyway"). Released installers are
> Authenticode-signed in CI through Azure Artifact Signing — see
> [docs/windows-signing.md](docs/windows-signing.md).

The **macOS** target builds an Apple-Silicon `.dmg` and must run on a Mac (dmg
tooling is macOS-only). By default it's **unsigned**, so Gatekeeper blocks the
first launch (Control-click ▸ Open). To sign and notarize it for distribution,
see [docs/macos-signing.md](docs/macos-signing.md). The hardened-runtime
entitlements it uses are in [`build/entitlements.mac.plist`](build/entitlements.mac.plist).

The **Android** app is a separate native project under [`android/`](android/),
built with Gradle; it wraps the same engine and PDF viewer for a WebView host.

## Build an unpacked folder (for quick local testing)

```sh
npm run package
```

Runs `@electron/packager` to produce `out/eupub-win32-x64/eupub.exe` plus its
`resources/` and DLLs. The whole folder is the distributable (ship it zipped);
the lone `.exe` won't run without the files beside it. Handy for fast iteration
without making an installer.

To regenerate `build/icon.ico` from the logo (needs `sharp` and the Euspell logo
SVG): `node build/make-icon.js`.

## Features

- Reads EPUB 2 (NCX) and EPUB 3 (nav) tables of contents.
- euspell on/off toggle (re-renders the current chapter, keeping your place).
- **Paged view** — CSS-column pagination with ← / → / space / wheel page turns
  that flow across chapter boundaries.
- **Reading position** that survives font/theme/view changes, via a structure-based
  locator (element path); the last book and spot reopen on launch.
- **Bookmarks** (☆) anchored to that locator, in the Marks tab.
- **Highlights** — select text to highlight it; listed in the Notes tab. Highlights
  are anchored by element path + character offset, so they survive re-pagination.
- **Book-wide search** (Search tab) over the original text; results jump to and
  flash the matching block.
- Font-size and light/dark controls; internal links and chapter navigation.

### Position, search & euspell — how they interact

The converter only rewrites text node values, never structure, so element-path
locators (position, bookmarks, search targets) stay valid whether euspell is on or
off. Character-offset anchors (highlights, in-page search marks) are computed
against the text as displayed, so they’re exact within a spelling mode; toggling
euspell re-renders and re-applies them. Search indexes the **original** spelling
(what’s on disk) and navigates to the block — the on-screen word may be reformed.

## Tests

```sh
npm test          # engine+parse pipeline, viewer mechanics, reader wiring (Electron)
```
