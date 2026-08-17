# Publishing Eupub to the Microsoft Store

What a Microsoft Store listing would need, and why it is worth more here than the
equivalent on the other platforms. Signing is covered in
[windows-signing.md](windows-signing.md), which this assumes; the installer that
document produces is most of what a submission wants.

Microsoft's documentation was read on **17 August 2026**. Two of its pages have
moved since they were last written about, so the items this could not confirm are
listed as open rather than stated — see [What is not yet
verified](#what-is-not-yet-verified).

## Where this stands today

| | State |
| --- | --- |
| Installer | `eupub-Setup-<version>.exe`, NSIS, built and attached by CI for every release |
| Code signing | **Done** — Authenticode via Azure Trusted Signing (account `euspell`, profile `euspell-public`) |
| Install scope | Per-user (`perMachine: false`), so no admin elevation |
| Architectures | **x64 only** — no `arch` is configured, so electron-builder's default applies |
| File associations | `.epub` (see `build.win.fileAssociations`) |
| Silent install | **Supported** — `/S`, established from the NSIS template this installer is compiled from (§5) |
| Partner Center account | Not registered |
| Store listing | None |
| Privacy policy URL | Written, not yet served — waiting on the site deploy |

## 1. Why bother — the argument specific to Windows

The other two stores were weighed and declined: Google Play in
[android-play-submission.md](android-play-submission.md) §1, and an addons.mozilla.org
listing for the browser extension in euspell's `docs/signing.md`. The Microsoft
Store is a different case, because it solves a problem that exists today.

**A Store install does not meet SmartScreen.** [installing.md](installing.md) has
to warn that early downloads may still see *"Windows protected your PC"* even
though the installer is correctly signed, because SmartScreen reputation accrues
per certificate and this certificate is new. That warning is the single largest
piece of friction in the Windows install path, it lands on first-time users, and
nothing but time and volume removes it. A Store listing sidesteps it entirely.

**And unlike Play, it is cheap to reverse.** Google re-signs an upload with its
own key, which is why a Play release cannot update a sideloaded install. In the
EXE route below **Microsoft does not re-sign anything** — the package is the same
installer, signed by the same certificate. Store and direct downloads stay
mutually compatible, so listing later, delisting later, or doing both costs
nothing structural.

Two smaller gains: automatic updates for anyone who installs from the Store, and
discovery by people who never visit a GitHub Releases page.

## 2. The package format: EXE, not MSIX

Microsoft accepts unpackaged Win32 installers. Packages are uploaded per
architecture and language combination — one package per combination — and
replaced from the **Manage packages** page on each update.

The alternative is repackaging as **MSIX**, which electron-builder can produce
with its `appx` target. It is the more modern format and the Store prefers it,
but it changes the app's install model: a virtualized filesystem and registry,
package identity, no user-chosen install directory, and different file-association
behaviour. All of that would need retesting, and none of it buys anything the EXE
route does not already give.

> **Take the EXE route.** It submits the artifact that is already built, signed,
> released and tested, and it is the reason §1's reversal argument holds.

## 3. Open the developer account — and start in the right place

Registration is now **free** for both account types. It did not used to be, and
the fee is still charged on the old path:

> **The free flow exists only from <https://storedeveloper.microsoft.com>.**
> Microsoft's own FAQ states that other entry points — Partner Center directly,
> Visual Studio, Xbox — show the legacy flow. Starting anywhere else is how you
> end up paying for something that is now free.

| | Individual | Company |
| --- | --- | --- |
| Who it is for | Distribution *not* in relation to a business, trade or profession | Businesses, or freelancers distributing as part of their trade |
| Verification | Government-issued ID and a selfie | D-U-N-S number, or business documents |
| Sign-in | Personal Microsoft account only (no Entra ID) | Personal MSA or Entra ID |
| Wait | Usually immediate | 2–5 business days if it goes to manual review |

**Individual is the right choice here**: Eupub is free, GPL-3, and not a
commercial undertaking. Note that Partner Center **cannot convert an Individual
account to a Company account** — that requires creating a second account — so
this is worth a moment's thought rather than a click.

## 4. Reserve the name

"Eupub" must be reserved in Partner Center before a submission exists to attach
packages to. Do this early: name reservation is first-come, and it costs nothing
to hold.

## 5. What the installer must satisfy

- **Signed by a trusted certificate.** Already true — Azure Trusted Signing,
  Microsoft ID Verified chain. This is the requirement that usually costs money
  and time, and it is behind us.
- **Silent installation.** The Store installs on the user's behalf, so the
  installer must run unattended. **`/S` works with this configuration**, which
  was the open question — `oneClick: false` and
  `allowToChangeInstallationDirectory: true` do not prevent it.

  Established on 17 August 2026 from `app-builder-lib`'s NSIS templates rather
  than from a trial install. Two things settle it. `SilentInstall silent` appears
  in [`installer.nsi`](../node_modules/app-builder-lib/templates/nsis/installer.nsi)
  only under `!ifdef BUILD_UNINSTALLER`, so the installer is an ordinary NSIS
  one — and NSIS handles `/S` natively for any installer, suppressing its pages.
  More directly, `installSection.nsh` carries a branch written specifically for
  this case:

  ```nsis
  # for assisted installer run only if silent, because assisted installer has
  # run after finish option
  ${if} ${isForceRun}
  ${andIf} ${Silent}
  ```

  An assisted installer that had no silent path would not need that test. The
  chain to the shipped binary holds: the lockfile pins `app-builder-lib` to
  26.15.3, CI installs with `npm ci`, so the template read here is the one
  compiled into `eupub-Setup-0.3.0.exe`.

  In silent mode the directory page is skipped and the default is used;
  `/D=<absolute path>` overrides it and must be the **last** argument, unquoted.

  > **What this does not prove** is that a silent run completes cleanly on a real
  > machine — exit code, shortcuts, file associations. That wants one run in a
  > throwaway VM before submitting, not because `/S` is in doubt but because
  > "installs unattended" and "installs correctly unattended" are different
  > claims. Windows Sandbox is the cheapest venue; it is not enabled on the
  > development machine (`Containers-DisposableClientVM`), and turning it on
  > needs elevation and a reboot.
- **Architecture.** x64 today. Windows on ARM has to run x64 under emulation,
  which works but is slower and larger in memory; adding an arm64 package is a
  separate build target and a second package upload, not a blocker.

## 6. The listing, and the declarations

| Item | Eupub's position |
| --- | --- |
| Name | Eupub (reserve in §4) |
| Description | Reuse the App Store and Chrome Web Store copy |
| Screenshots | **None exist.** Every screenshot in the project is of the browser extension, shot for the Chrome Web Store; there is not one of the Eupub desktop app. They have to be captured from the running reader, and a screenshot only earns its place if the reformed spelling is legible in it |
| Logo / tile art | From `build/icon.ico` and the press logo pair |
| Category | Books & reference |
| Age rating | Completed through the **IARC** questionnaire. No user-generated content, no ads, no purchases, no data collection — the answers are all trivial |
| Privacy policy URL | **Required**, and the one external dependency: it needs the site deployed, or that page served |
| Support contact | `kamran@euspell.org` |
| Notes for certification | Written — paste [`windows-store-certification-notes.txt`](windows-store-certification-notes.txt) verbatim (3,036 chars, plain ASCII). See below for why it opens the way it does |

The data and privacy answers are as easy here as they were for Apple and Google:
no account, no server, no telemetry, no network.

### The first-run problem — fixed in the app, not papered over

Until 0.3.1 the desktop app opened on a welcome screen and did nothing further
until the tester supplied a file. Both mobile builds had always seeded a bundled
sample on first launch (`Bridge.swift` on iOS, `maybeSeedSample` on Android); the
Electron app had no equivalent. A certification tester who launches an app, finds
no content and moves on is entitled to record that it does not demonstrably do
anything — a likelier failure here than any policy question.

**0.3.1 seeds the sample on desktop too**, so all three platforms open the same
book immediately. The certification notes were rewritten to match: they now say
the app needs no setup, rather than explaining how to work around it.

> **Submit 0.3.1 or later, never 0.3.0.** The 0.3.0 installer is the version with
> the empty first run, and it is still on the Releases page. Uploading it would
> put the worst first impression of the app in front of a tester *and* contradict
> the notes, which is the sort of small inconsistency that costs a round trip.

## 7. Updates

Each new release means uploading the new installer on the **Manage packages**
page and deleting the superseded one. That is a manual step; it does not follow
from tagging a release the way the four GitHub assets now do, so treat the Store
as a deliberate publish rather than an automatic one — at least until it has been
done by hand often enough to be worth automating through the Store submission
API.

## What is not yet verified

Recorded honestly rather than guessed, because the requirements pages have moved:

- **The precise silent-install requirement** Microsoft imposes, and its expected
  exit-code behaviour. That `/S` works is settled (§5); what the Store *demands*
  is not, because the official wording was not locatable at the URLs the older
  documentation used.
- **How install success is detected** by the Store for an unpackaged app, and
  whether anything beyond a zero exit code is required.
- **That a silent run completes correctly** end to end — shortcuts, file
  associations, exit code — which needs one run in a disposable VM (§5).
- **Certification time** for a first unpackaged submission.
- **Whether Microsoft hosts the installer** or links to a developer-hosted URL.
  The package-management documentation describes packages being uploaded to and
  managed in Partner Center, which implies Microsoft hosts them, but that was not
  stated outright on the pages read.

Check these against Partner Center's own submission checklist when the account
exists — it is authoritative and current in a way that documentation links are
not.

## Sources

- [Open a developer account](https://learn.microsoft.com/en-us/windows/apps/publish/partner-center/open-a-developer-account)
- [Publish apps & games to Microsoft Store](https://learn.microsoft.com/en-us/windows/apps/publish/)
- [App package management for MSI/EXE apps](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msi/app-package-management)
