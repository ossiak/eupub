# Eupub Windows installer — parameters and exit codes

`eupub-Setup-<version>.exe` is an NSIS installer produced by electron-builder. It
reports its outcome through the process exit code, which is what an unattended
installation (`/S`) has to be judged by, since there is no window to read.

**The rule that matters: `0` means the installation succeeded. Any other value
means it did not, and the install should be treated as failed.**

| Code | Decimal | Meaning |
| --- | --- | --- |
| `0` | 0 | **Success.** The application was installed (or upgraded) and is ready to run |
| `2` | 2 | **Failed to remove the previous version.** An upgrade ran the installed version's uninstaller and it returned an error, so the new version was not installed. The existing installation is left in place |
| `0x666666` | 6711142 | **Elevation was required and not granted.** The installer relaunched itself to obtain administrator rights and the elevated instance did not have them. Not expected for Eupub, which installs per-user and never requests elevation — listed for completeness |

Any other non-zero value comes from NSIS itself rather than from Eupub, and
arises from the installation being cancelled or from a file-system or
permissions error. Treat all of them as a failed installation.

## The standard outcome categories

Store submissions offer a fixed list of outcomes to map return codes onto. Eupub
emits a distinct code for none of them, so none should be mapped — a value
supplied here would make the installer report a cause that is not the real one.

| Outcome | Eupub |
| --- | --- |
| **Cancelled by the user** | No distinct code. It also cannot arise during an unattended install: `/S` presents no cancel button, and the one prompt that could appear — the application is running and must be closed — answers itself with OK under `/SD IDOK` and proceeds |
| **Application already exists** | Not an error condition. Installing over an existing copy is an in-place upgrade and returns `0`. The installer never refuses because the app is present |
| **Installation already in progress** | The installer does hold a named mutex and a second instance stops rather than running concurrently, but it exits without setting a distinct code, so there is nothing to map |
| **Disk space is full** | No distinct code; it surfaces as a generic failure |
| **Reboot required** | **Never happens.** No driver, no service, no in-use system file is touched, and the installer never sets a reboot flag. Nothing should be mapped here, and a restart is never requested |
| **Network failure** | Not applicable. The installer makes no network requests of any kind |
| **Package rejected by device security policy** | Not applicable. That decision is the operating system's, and the installer is not run to report it |

The practical consequence is the rule at the top of this page: map `0` to
success, and treat every other value as a failure whose cause is not
distinguishable from the exit code alone.

## Installer parameters

| Operation | Parameter |
| --- | --- |
| **Silent install** | `/S` |
| **Silent uninstall** | `/S` |

Nothing else is needed, and nothing else should be passed.

- **`/S` is honoured by the uninstaller as well as the installer.** That is worth
  stating because it is not automatic for NSIS uninstallers; this one parses the
  flag explicitly and switches itself to silent mode.
- **Do not pass `/D=`.** It overrides the install directory, and it is
  positionally fragile — it must be the final argument and must not be quoted, so
  anything appended after it silently breaks the install. The default
  (`%LOCALAPPDATA%\Programs\Eupub`) is the right location.
- **`/allusers` and `/currentuser` exist but are irrelevant here.** Eupub is a
  per-user application (`perMachine: false`), so current-user is already what
  happens.
- **A silent install does not launch the app afterwards.** Starting the app on
  completion is gated on a force-run flag used by the updater, which nothing in a
  store-driven install passes.

## Notes

- **Nothing here requires administrator rights.** Eupub installs per-user, into
  `%LOCALAPPDATA%\Programs\Eupub` by default, so a standard user account can
  install and update it without elevation.
- **Reboots are never required.** The installer does not install drivers or
  services and does not replace files that are in use by the operating system,
  so it neither requests nor requires a restart, and returns no reboot-pending
  code.
- The codes above were read from the NSIS templates the installer is compiled
  from (`app-builder-lib` 26.15.3), not inferred from observed behaviour.

## Where this is used

Microsoft Store submissions for unpackaged (EXE) apps ask for the installer's
return codes, and for a URL documenting any that are not enumerated in the
submission form. This page is that URL. See
the internal Microsoft Store submission note.
