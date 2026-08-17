# Eupub Windows installer — exit codes

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

## Notes

- **Nothing here requires administrator rights.** Eupub installs per-user, into
  `%LOCALAPPDATA%\Programs\Eupub` by default, so a standard user account can
  install and update it without elevation.
- **Silent installation** uses `/S`. `/D=<absolute path>` sets the target
  directory and, if given, must be the last argument and unquoted.
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
[windows-store-submission.md](windows-store-submission.md).
