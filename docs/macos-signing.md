# Signing and notarizing Eupub for macOS

By default `npm run dist:mac` produces an **unsigned** `.dmg`: it runs on the Mac
that built it, but anyone else who downloads it hits Gatekeeper —
*"Eupub can't be opened because Apple cannot check it for malicious software"* —
and has to Control-click ▸ Open (or worse, sees *"damaged"*). Signing with an
Apple **Developer ID** certificate and **notarizing** with Apple removes that
friction: the app opens with a normal double-click on any Mac.

This is the one-time setup to ship signed builds. The [`mac`
config](../package.json) and the hardened-runtime
[`build/entitlements.mac.plist`](../build/entitlements.mac.plist) are already in
place — you supply an Apple identity and flip notarization on.

> **Runs on a Mac only.** `codesign`, `dmg` creation, and notary submission are
> macOS tools. Build on an Apple-Silicon Mac locally, or on a `macos-latest` CI
> runner — not on the Linux runner that builds the AppImage.

## What you need

- An **[Apple Developer Program](https://developer.apple.com/programs/)**
  membership (US$99 / year). Notarization itself is free; the membership is what
  lets you create a Developer ID certificate.
- **Xcode** or the **Command Line Tools** installed (`xcode-select --install`) —
  provides `codesign` and `notarytool`.
- A **Developer ID Application** certificate (Step 1).
- Notarization credentials (Step 2).

## Step 1 — Get a Developer ID Application certificate

This is the certificate for distributing **outside** the Mac App Store.

- **Easiest (Xcode):** Xcode ▸ Settings ▸ Accounts ▸ (your Apple ID) ▸ **Manage
  Certificates…** ▸ **+** ▸ **Developer ID Application**. It's created and
  installed into your **login keychain**.
- **Or the portal:** <https://developer.apple.com/account/resources/certificates>
  ▸ **+** ▸ *Developer ID Application*, follow the CSR steps, download the `.cer`,
  and double-click to add it to Keychain Access.

Verify it's present:

```sh
security find-identity -v -p codesigning
# → look for "Developer ID Application: Your Name (TEAMID)"
```

electron-builder auto-discovers this identity from the keychain, so locally you
don't have to configure a path. (For CI, export it — see [CI](#signing-in-ci).)

## Step 2 — Notarization credentials

Pick **one** of these; the App Store Connect API key is the most robust
(no password rotation, works headlessly in CI).

**Option A — App Store Connect API key (recommended).** At
<https://appstoreconnect.apple.com/access/integrations/api> create a key with the
**Developer** role and download `AuthKey_XXXXXXXXXX.p8` **once** (you can't
re-download it). You need three values:

| Env var | Value |
| --- | --- |
| `APPLE_API_KEY` | path to the `AuthKey_XXXXXXXXXX.p8` file |
| `APPLE_API_KEY_ID` | the Key ID (the `XXXXXXXXXX` part) |
| `APPLE_API_ISSUER` | the Issuer ID shown above the keys list (a UUID) |

**Option B — Apple ID + app-specific password.**

| Env var | Value |
| --- | --- |
| `APPLE_ID` | your Apple ID email |
| `APPLE_APP_SPECIFIC_PASSWORD` | make one at <https://appleid.apple.com> ▸ Sign-In & Security ▸ **App-Specific Passwords** |
| `APPLE_TEAM_ID` | your 10-character Team ID (Developer account ▸ Membership) |

## Step 3 — Turn notarization on

In [`package.json`](../package.json), flip the flag in `build.mac`:

```jsonc
"mac": {
  ...
  "notarize": true   // was false
}
```

With `notarize: true` and the Step 2 credentials in the environment,
electron-builder submits to Apple's notary service via `notarytool` and
**staples** the resulting ticket automatically. Leaving it `false` (or unset)
skips notarization — that's the current unsigned default.

## Step 4 — Build

```sh
# --- signing identity ---
# Local: nothing to set — the Developer ID cert is found in your keychain.
# (If you have several identities, pin one: export CSC_NAME="Developer ID Application: Your Name (TEAMID)")

# --- notarization creds (Option A shown) ---
export APPLE_API_KEY=~/keys/AuthKey_XXXXXXXXXX.p8
export APPLE_API_KEY_ID=XXXXXXXXXX
export APPLE_API_ISSUER=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx

npm run dist:mac
```

electron-builder then, in order: signs `Eupub.app` with the Developer ID cert
using the **hardened runtime** and the committed entitlements, builds
`release/Eupub-<version>-arm64.dmg`, uploads it to the notary service, waits for
the *Accepted* result, and staples the ticket to the app and the dmg.

> The `gatekeeperAssess: false` already in the config stops electron-builder from
> running a local Gatekeeper assessment mid-build — that check would fail until
> the ticket is stapled, and isn't meaningful before then.

## Step 5 — Verify

```sh
# Signature is valid and sealed:
codesign --verify --deep --strict --verbose=2 "release/mac-arm64/Eupub.app"

# Gatekeeper accepts it as a notarized Developer ID app:
spctl -a -vvv "release/mac-arm64/Eupub.app"
# → "source=Notarized Developer ID"

# The notarization ticket is stapled (works offline, first launch):
xcrun stapler validate "release/mac-arm64/Eupub.app"
xcrun stapler validate release/Eupub-*-arm64.dmg
```

If all three pass, the dmg opens on a clean Mac with no Gatekeeper prompt.

## Signing in CI

The release workflow already has a **`dmg`** job on `macos-latest`
([`.github/workflows/release.yml`](../.github/workflows/release.yml); the AppImage
job stays on `ubuntu-latest`). It builds an **unsigned** dmg out of the box and
signs + notarizes automatically once you add these repository **secrets**
(Settings ▸ Secrets and variables ▸ Actions):

| Secret | What it is |
| --- | --- |
| `CSC_LINK` | base64 of your exported Developer ID `.p12` (`base64 -i cert.p12 \| pbcopy`) |
| `CSC_KEY_PASSWORD` | the password you set when exporting that `.p12` |
| `APPLE_API_KEY_P8` | the **contents** of the App Store Connect `AuthKey_*.p8` |
| `APPLE_API_KEY_ID` | the key's ID |
| `APPLE_API_ISSUER` | the issuer UUID |

When `APPLE_API_KEY_ID` is present the job writes the `.p8` to a file, flips
`build.mac.notarize` on, and `npm run dist:mac` then signs (from `CSC_LINK`) and
notarizes (via the API key), attaching `Eupub-<version>-arm64.dmg` to the release
alongside the AppImage. With the secrets absent it still builds — just an
unsigned dmg — so the workflow never fails for lack of signing.

## After you ship signed builds

Once releases are signed and notarized, the Gatekeeper workaround in
[installing.md](installing.md) (Control-click ▸ Open, the `xattr` quarantine fix)
no longer applies to your users — drop that from the macOS section and just say
"open it normally."

## Notes

- **Renewal.** A Developer ID Application certificate is valid ~5 years; the
  membership renews yearly. If the cert expires, existing notarized builds keep
  working — only new signing needs a fresh cert.
- **Which chip.** `dist:mac` targets `--arm64` (Apple Silicon). To also ship
  Intel, add `--x64` (or `--universal`) and a matching `${arch}` artifact; each
  arch is signed and notarized the same way.
- **Ad-hoc / unsigned.** With no identity available, electron-builder logs
  *"skipped macOS application code signing"* and emits an unsigned dmg — the
  build still succeeds, it just needs the Gatekeeper workaround to open.
