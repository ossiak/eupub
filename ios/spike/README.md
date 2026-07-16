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

## Run it

One prerequisite that VSCode can't get around: **full Xcode**, from the App Store.
Command Line Tools alone have no iOS SDK and no simulators. Once it's installed
you never need to open it — everything below is terminal-driven.

```sh
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer   # once, if needed
brew install xcodegen                                             # once

cd Eupub/ios/spike
chmod +x run.sh   # the repo is authored on Windows, so the exec bit may not survive
./run.sh
```

`run.sh` generates the Xcode project, builds it, boots a simulator, launches the
app, **kills the process**, relaunches it, and screenshots both runs to
`launch1.png` / `launch2.png`. The kill is the whole point — it proves the data
outlives the process rather than just the page.

No Apple Developer account and no signing are needed; simulator builds skip both.

## Read the result

The page reports its own verdict, so there's no debugger or console to read —
look at the Simulator window or open `launch2.png`.

| Screen | Meaning |
| --- | --- |
| `FIRST RUN — now force-quit and relaunch` | expected on launch 1 only |
| `PASS — state survived N launches` | custom scheme persists; use `eupub://localhost` |
| `FAIL — localStorage unavailable on this origin` | opaque origin; fall back to a loopback server |

The detail block also shows `location.origin` (confirm it reads
`eupub://localhost`, not `null`) and whether `fetch('/probe.txt')` works —
`readText` and `engineSource` are plain fetches against the served origin, so
that has to work before the bridge design leans on it.

Re-run to watch the launch counter keep climbing.

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
