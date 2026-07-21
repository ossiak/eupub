# iOS origin spike

Answers one question: **does `localStorage` survive an app relaunch when the page
is served from a custom scheme via `WKURLSchemeHandler`?**

It matters because the renderer keeps all user state in `localStorage`
(`reader.js` — position, bookmarks, highlights, prefs, recents) and because
iOS, unlike Android, **cannot serve app content over a virtual `https://` origin**:
`WKWebView` refuses to register a scheme handler for `https`. So the Android
shell's `https://eupub.local` becomes `eupub://localhost`, and the question is
whether state persists on that origin.

- **Pass** → the iOS shell is a direct translation of `MainActivity.kt`, and the
  renderer stays byte-identical across Electron / Android / iOS.
- **Fail** → persistence has to route through the native bridge, which forks
  `reader.js` per platform, or the app needs a loopback HTTP server to get a real
  `http://127.0.0.1:PORT` origin.

## Status — PASS (verdict observed 2026-07-20, iOS 26 simulator)

**The custom-scheme approach works.** Across a kill-and-relaunch on the iPhone 17
simulator (iOS 26):

```
PASS — state survived N launches
origin            eupub://localhost
localStorage      readable + writable
fetch subresource OK
```

So `localStorage` persists on `eupub://localhost` (the origin is that, **not**
opaque/`null`), and a `fetch()` of a served subresource works. The iOS shell can
be a direct translation of `MainActivity.kt` with the renderer byte-identical —
the loopback-HTTP-server fallback is not needed.

**ONE GOTCHA the real shell must carry:** the scheme handler MUST return an
`HTTPURLResponse` with `statusCode: 200`, not a bare `URLResponse`. `fetch()`
reads its status from the underlying response; a non-HTTP `URLResponse` surfaces
as `status 0` (`r.ok === false`), so the main document still renders while every
`readText` / `engineSource` fetch fails — a silent, misleading split. Fixed in
`ContentView.swift`'s `SpikeSchemeHandler`; the real `BookPathHandler`/asset
analog needs the same 200 + `Content-Type`.

(First full run showed a blank page and `NO VERDICT`. Causes: `run.sh` read
`verdict.txt` after only 3s — before launch 2 had written it (sleeps bumped to
6s) — and the `fetch` HTTP-0 failure above. The verdict is read most reliably via
`xcrun simctl launch --console-pty`, which captures the app's `print()`.)

## Run it

One prerequisite that VSCode can't get around: **full Xcode**, from the App Store.
Command Line Tools alone have no iOS SDK and no simulators. Once it's installed
you never need to open it — everything below is terminal-driven.

```sh
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer   # once, if needed
brew install xcodegen                                             # once

cd ios/spike        # from the repo root
./run.sh
```

`run.sh` generates the Xcode project, builds it, boots a simulator, launches the
app, **kills the process**, relaunches it, and **prints the verdict to your
terminal**. The kill is the whole point — it proves the data outlives the
process rather than just the page.

No Apple Developer account and no signing are needed; simulator builds skip both.

## Read the result

`run.sh` ends by printing the report the app posted back, e.g.

```
==============================================================
PASS — state survived 2 launches
origin          eupub://localhost
localStorage    readable + writable
launches seen   2
first seen      2026-07-16T14:22:31.004Z
fetch subresource OK
==============================================================
```

Three things matter, and all three are in that block:

| Line | What you want | Why |
| --- | --- | --- |
| headline | `PASS — state survived N launches` | the answer |
| `origin` | `eupub://localhost`, **not** `null` | an opaque origin sinks the approach — `localStorage` *throws* there rather than returning null |
| `fetch subresource` | `OK` | `readText` / `engineSource` are plain fetches against the served origin |

`FIRST RUN` in that block means launch 2 didn't see launch 1's data — that is a
**fail**, not a pending state; the script always runs twice.

Screenshots of both launches also land in `launch1.png` / `launch2.png`, and the
Simulator window shows the same thing on screen. Re-run to watch the counter
climb — extra evidence, and harmless.

## Troubleshooting

**`NO VERDICT — the app never posted one`.** The page didn't reach its message
handler. Either JS threw before `render()`, the root document never loaded, or
the scheme handler didn't serve it. Look at `launch2.png` and the Simulator
window; if the page is blank, the scheme handler is the suspect.

**No Simulator window.** `open -a Simulator` may put it on another Space rather
than pulling it forward — check Mission Control or the Dock. `xcrun simctl list
devices booted` confirms whether a device is actually running.

**No screenshots.** `simctl io` errors are no longer suppressed, so the failure
reason prints. This previously failed *silently* — if you're on an older checkout
where the calls end in `>/dev/null 2>&1`, that's why you got nothing.

**`bad interpreter: bash^M`.** The repo is authored on Windows. `.gitattributes`
pins `*.sh` to LF, so a normal clone is fine — but a copied-by-hand file may need
`chmod +x run.sh` and its line endings fixed.

### On a real device

The simulator answers this question — it runs the same WebKit with the same data
store semantics, and app containers persist across relaunches. A device is worth
a confirmation pass before the port is finalized, but it needs a signing team,
so it isn't the fast path. To do it: open the generated `.xcodeproj`, set a team
under Signing & Capabilities, pick your device, and run.

### Without XcodeGen

If you'd rather not install anything: Xcode → **File ▸ New ▸ Project ▸ iOS ▸ App**
(SwiftUI), then drop in `Sources/ContentView.swift` and `Sources/SpikeApp.swift`,
deleting the generated `ContentView.swift` and `<YourApp>App.swift`. Run,
force-quit from the app switcher, relaunch. Same test, more clicking.

## What is already known (so you know what you're confirming)

The literature says this should pass, and the spike is confirmation rather than
discovery:

- **Ionic ships this exact pattern in production.** Its WKWebView plugin serves
  app content from `ionic://localhost` through `WKURLSchemeHandler`, across a
  very large number of App Store apps. Custom-scheme `localStorage` persisting is
  load-bearing for all of them.
- **The scary "custom schemes lose localStorage" reports are a migration
  artifact.** Cordova's move to `WKURLSchemeHandler` was flagged breaking because
  apps switching `file://` → `app://localhost` orphan data behind the *old*
  origin. That is a one-time cost of *changing* origins, not an ongoing failure to
  persist — and it does not apply to a greenfield app that has no prior origin.
- **The ITP 7-day cap on script-writable storage doesn't apply.** It is Safari's
  tracking prevention; apps hosting their own web view are outside it.
- **The real cause of genuine wipes is `WKWebsiteDataStore.nonPersistent()`** — an
  in-memory store that empties every launch. The spike sets `.default()`
  explicitly for that reason.

## The durable constraint this surfaces

`localStorage` is keyed to scheme + host, so **`eupub://localhost` is permanent
once shipped.** Changing either half in a later version orphans every user's
reading position, bookmarks, and highlights behind a dead origin — precisely the
Cordova migration pain, self-inflicted. Worth writing down wherever the iOS shell
constants live.
