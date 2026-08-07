# Signing Eupub for Windows

By default `npm run dist` produces an **unsigned** `release/eupub-Setup-<version>.exe`.
It installs fine, but every user meets **SmartScreen** first —
*"Windows protected your PC — Microsoft Defender SmartScreen prevented an
unrecognized app from starting"* — and has to click **More info ▸ Run anyway**.
That warning is what [installing.md](installing.md) currently tells people to
expect. Authenticode-signing the installer replaces "unknown publisher" with your
name in the UAC prompt, and (with enough reputation, or an EV certificate)
removes the warning entirely.

This is the one-time setup. electron-builder does all the signing — of
`Eupub.exe` *and* of the NSIS installer that wraps it — as part of the normal
build, once you tell it which credential to use. Nothing in `src/` changes.

> **Signing runs on Windows.** `signtool.exe` and the Azure signing module are
> Windows tools. Build on your own Windows machine or a `windows-latest` CI
> runner. (electron-builder can cross-sign from Linux with `osslsigncode` for a
> plain `.pfx`, but not with a hardware token or Azure, so don't plan on it.)

## Step 1 — Get a code-signing credential

Since June 2023 the CA/Browser Forum requires code-signing private keys to live
on certified hardware (a USB token or a cloud HSM). **You can no longer buy an
OV certificate and get a `.pfx` file by email.** That rules out the simple
"point electron-builder at a file" path for any newly issued certificate, and it
is the single fact that decides which of these you pick:

| Option | Cost | Works on hosted CI | Notes |
| --- | --- | --- | --- |
| **Azure Artifact Signing** (renamed from Trusted Signing) | ~US$9.99/mo Basic | ✅ yes | No token to plug in — signing is an API call. Microsoft's recommended route. Individual (non-company) sign-up is currently **US/Canada only**; organisations normally need 3+ years of verifiable history. |
| **OV certificate on a cloud HSM** (SSL.com eSigner, DigiCert KeyLocker, Certum) | ~US$100–350/yr | ✅ yes | The credential is yours and portable; you drive the vendor's CLI from a custom sign hook (Step 2c). |
| **OV certificate on a USB token** | ~US$100–250/yr | ❌ no | Cheapest, but the token must be physically in the machine that signs, so releases can only be cut from your desk. |
| **EV certificate** (token or HSM) | ~US$300–600/yr | depends | The only option that gets **instant SmartScreen reputation**. Otherwise identical mechanically. |
| **Self-signed** | free | ✅ | Test the pipeline only — Windows trusts it nowhere, and SmartScreen still blocks. See [Testing the pipeline](#testing-the-pipeline-without-a-real-certificate). |

> **An OV certificate does not silence SmartScreen on day one.** Reputation
> accrues per *certificate* as installs accumulate; a fresh OV cert still shows
> the warning for the first weeks. Only EV starts with reputation. If the goal is
> specifically "no SmartScreen at launch", budget for EV.

## Step 2 — Configure electron-builder

electron-builder 26 (the version pinned here) splits Windows signing into two
mutually exclusive blocks under `build.win` in
[`package.json`](../package.json). **`signtoolOptions` is already there** (2b),
which covers a `.pfx` and a cloud-HSM hook; if you choose Azure instead, replace
it with the `azureSignOptions` block — having both is a configuration error.

### 2a — Azure Artifact Signing

```jsonc
"win": {
  "target": ["nsis"],
  "icon": "build/icon.ico",
  "artifactName": "eupub-Setup-${version}.${ext}",
  "azureSignOptions": {
    "publisherName": "Kamran Ossia",          // exact CN of the certificate
    "endpoint": "https://eus.codesigning.azure.net",
    "codeSigningAccountName": "euspell",       // your Trusted Signing account
    "certificateProfileName": "euspell-public"
  },
  "fileAssociations": [ /* unchanged */ ]
}
```

Authentication is by environment variable (Azure's `EnvironmentCredential`), so
nothing secret goes in the repo:

```powershell
$env:AZURE_TENANT_ID     = "<directory (tenant) id>"
$env:AZURE_CLIENT_ID     = "<app registration client id>"
$env:AZURE_CLIENT_SECRET = "<client secret>"
```

The service principal needs the **Artifact Signing Certificate Profile Signer**
role on the signing account. Timestamping is automatic
(`http://timestamp.acs.microsoft.com`).

### 2b — A `.pfx` file (legacy certs and self-signed tests)

**This block is already in [`package.json`](../package.json)** and is inert until
a certificate shows up:

```jsonc
"win": {
  ...
  "signtoolOptions": {
    "signingHashAlgorithms": ["sha256"],
    "rfc3161TimeStampServer": "http://timestamp.digicert.com"
  }
}
```

Add `"publisherName": "…"` to it only once you have the certificate in hand, and
make it byte-identical to the certificate's CN — it's used to verify updates, and
a wrong value is worse than none. (Left out, electron-builder reads the CN off
the certificate itself.)

Keep the certificate **out of the config and out of git** — pass it in the
environment:

| Env var | Value |
| --- | --- |
| `CSC_LINK` | path to the `.pfx` (also accepts a base64 blob or an https URL) |
| `CSC_KEY_PASSWORD` | that file's password |

(`WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` are the Windows-only spellings, useful
if the same machine also signs for macOS.)

> `signingHashAlgorithms` defaults to `["sha1", "sha256"]`, which dual-signs.
> SHA-1 code signatures have been ignored by Windows since 2016 and some
> timestamp servers now reject them, so pin `["sha256"]` as above.

### 2c — A cloud HSM (custom sign hook)

Vendors like SSL.com and DigiCert ship their own CLI that talks to the HSM.
Point electron-builder at a small hook that shells out to it — the hook is called
once per file (the app exe, then the installer):

```js
// build/sign.js — invoked by electron-builder for each file to sign
const { execFileSync } = require('node:child_process');

exports.default = async function sign(configuration) {
  execFileSync(
    process.env.CODESIGNTOOL,          // e.g. C:\eSigner\CodeSignTool.bat
    ['sign', `-input_file_path=${configuration.path}`, '-override=true',
     `-username=${process.env.ES_USERNAME}`,
     `-password=${process.env.ES_PASSWORD}`,
     `-credential_id=${process.env.ES_CREDENTIAL_ID}`,
     `-totp_secret=${process.env.ES_TOTP_SECRET}`],
    { stdio: 'inherit' },
  );
};
```

```jsonc
"win": {
  ...
  "signtoolOptions": { "sign": "build/sign.js", "publisherName": "Kamran Ossia" }
}
```

## Step 3 — Build

```powershell
# Azure (2a): the three AZURE_* vars from Step 2a must be in the environment.
# .pfx  (2b):
$env:CSC_LINK         = "C:\keys\eupub-codesign.pfx"
$env:CSC_KEY_PASSWORD = "…"

npm run dist
```

electron-builder builds as usual, then signs `Eupub.exe`, signs every other
executable it packages, and finally signs `release/eupub-Setup-<version>.exe`.
A signed build takes a little longer — each signature round-trips to a timestamp
server.

## Step 4 — Verify

```powershell
# Signature present, chain valid, and who it says signed it:
Get-AuthenticodeSignature .\release\eupub-Setup-0.2.2.exe | Format-List Status, SignerCertificate, TimeStamperCertificate

# The same check signtool's way (needs the Windows SDK); /pa = Authenticode policy:
signtool verify /pa /v .\release\eupub-Setup-0.2.2.exe
```

`Status : Valid` plus a non-null `TimeStamperCertificate` is what you want. Then
copy the installer to a machine that has never seen it and run it: the UAC prompt
should read **Verified publisher: Kamran Ossia** instead of *Unknown publisher*.

> **A missing timestamp is a time bomb.** Without one, every copy of the
> installer stops validating the day the certificate expires. With one, builds
> signed while the cert was valid keep validating forever. Both config blocks
> above timestamp by default — the `Get-AuthenticodeSignature` check above is how
> you confirm it actually happened.

## Signing in CI

[`.github/workflows/release.yml`](../.github/workflows/release.yml) now has an
**`nsis` job** on `windows-latest`, alongside `appimage` and `dmg` — same
side-by-side checkout of `euspell_ext`, same tag/version guard, same
create-or-upload publish. Until then the `.exe` on the Releases page was built by
hand.

It builds an **unsigned** installer out of the box and signs automatically once
you add two repository secrets (Settings ▸ Secrets and variables ▸ Actions):

| Secret | What it is |
| --- | --- |
| `WIN_CSC_LINK` | base64 of your code-signing `.pfx` — `[Convert]::ToBase64String([IO.File]::ReadAllBytes("cert.pfx")) \| Set-Clipboard` |
| `WIN_CSC_KEY_PASSWORD` | that `.pfx`'s password |

Unlike the `dmg` job, this needs no "configure signing" step to handle the
secrets being absent: electron-builder checks `cscLink == null || cscLink === ""`
before doing anything, so an empty secret means *unsigned*, not *broken*. Forks
and dry runs keep working.

**For the Azure route (2a)** swap those two secrets for `AZURE_TENANT_ID`,
`AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET` on the *Build installer* step, and
add `azureSignOptions` to `package.json`. Note that `azureSignOptions` is not
inert the way `signtoolOptions` is — once the block exists, electron-builder
routes signing through Azure and fails if it can't authenticate, so add it and
the secrets in the same change.

> **A USB token cannot be used from a GitHub-hosted runner.** If you go that
> route, either sign locally and upload the artifact by hand, or register a
> self-hosted runner on the machine the token is plugged into.

## Testing the pipeline without a real certificate

Worth doing before you spend money — it proves the config, not the trust:

```powershell
$c = New-SelfSignedCertificate -Type CodeSigningCert -Subject "CN=Eupub Test" `
       -CertStoreLocation Cert:\CurrentUser\My
$pw = ConvertTo-SecureString -String "test" -Force -AsPlainText
Export-PfxCertificate -Cert $c -FilePath C:\keys\eupub-test.pfx -Password $pw

$env:CSC_LINK = "C:\keys\eupub-test.pfx"; $env:CSC_KEY_PASSWORD = "test"
npm run dist
```

`Get-AuthenticodeSignature` will report `UnknownError` / *"A certificate chain
could not be built to a trusted root"* — correct and expected. What you're
checking is that a signature block is there at all, on both the app exe and the
installer. Delete the test cert from `Cert:\CurrentUser\My` afterwards.

## After you ship signed builds

- Drop the SmartScreen workaround from the **Windows** section and the
  troubleshooting table of [installing.md](installing.md) once the warning
  actually stops appearing — with an OV cert that's some weeks after launch, not
  the first signed build.
- If auto-update is ever added (`electron-updater`), `verifyUpdateCodeSignature`
  is on by default and checks the downloaded update against `publisherName`.
  Getting that string wrong breaks updates silently, so keep it byte-identical to
  the certificate's CN.

## Notes

- **Renewal.** OV/EV certificates run 1–3 years. Timestamped builds signed before
  expiry stay valid; only new signing needs a current certificate. SmartScreen
  reputation is tied to the certificate, so a *replacement* cert starts from zero
  unless you renew the same one — renew early rather than letting it lapse.
- **What gets signed.** electron-builder signs the packaged `.exe` files and the
  NSIS installer. The `.blockmap` and `latest.yml` beside it are metadata, not
  code, and are not signed.
- **Keep the credential out of git.** `release/` is already git-ignored; a `.pfx`
  is not — never put one in the repo, even briefly. Use the environment variables
  above, or a repository secret in CI.

## Sources

- [electron-builder — Windows code signing](https://github.com/electron-userland/electron-builder/blob/master/pages/code-signing-win.md)
  and the [`WindowsConfiguration` interface](https://www.electron.build/electron-builder.Interface.WindowsConfiguration.html)
  (`signtoolOptions` / `azureSignOptions` are also documented verbatim in
  `node_modules/app-builder-lib/out/options/winOptions.d.ts`)
- [Microsoft — Code signing options for Windows app developers](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options)
- [Trusted Signing is now open for individual developers](https://techcommunity.microsoft.com/blog/microsoft-security-blog/trusted-signing-is-now-open-for-individual-developers-to-sign-up-in-public-previ/4273554)
