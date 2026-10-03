// electron-builder afterSign hook: refuse to go any further if the app was
// signed via Apple's retiring Developer ID sub-CA.
//
// That authority expires 2027-02-01, and every certificate it issued stops
// working that day regardless of the certificate's own notAfter. Replacements
// come from the G2 sub-CA and run to 2031. The catch is that both authorities
// issue leaves with an IDENTICAL CN ("Developer ID Application: <name> (TEAM)"),
// so nothing in codesign's own output distinguishes them -- only the issuer OU
// on the intermediate does. A build signed with the old certificate therefore
// looks perfect today, installs fine, and stops installing in February.
//
// This runs before notarization, so a wrong certificate costs seconds rather
// than a round trip to Apple. The release workflow checks the same thing, but
// a local `npm run dist:mac` bypasses CI entirely -- which is how v0.3.5
// shipped on the old certificate.
'use strict'

const { execFileSync } = require('node:child_process')
const { mkdtempSync, rmSync, existsSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')

const WANT_OU = 'OU=G2'

exports.default = async function verifySigningChain(context) {
  if (context.electronPlatformName !== 'darwin') return

  // Deliberately unsigned builds (no cert configured) are a visible state, not
  // the failure this guards against.
  if (process.env.CSC_IDENTITY_AUTO_DISCOVERY === 'false') return

  const app = join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  )
  if (!existsSync(app)) {
    throw new Error(`verify-signing-chain: no app bundle at ${app}`)
  }

  const dir = mkdtempSync(join(tmpdir(), 'eupub-chain-'))
  try {
    // Writes <prefix>0 (leaf), <prefix>1 (intermediate), <prefix>2 (root).
    // Nothing is written when the signature carries no certificates at all.
    try {
      execFileSync('codesign', ['-d', `--extract-certificates=${join(dir, 'c')}`, app], {
        stdio: 'ignore'
      })
    } catch {
      console.warn(`  • verify-signing-chain: ${app} is unsigned, skipping`)
      return
    }

    // On arm64 every Mach-O carries at least an ad-hoc signature, so "has a
    // signature" is not the same as "has a certificate": an unsigned build
    // reaches here with a valid ad-hoc signature and no certificates at all.
    if (!existsSync(join(dir, 'c0'))) {
      console.warn(
        `  • verify-signing-chain: ${app} is ad-hoc signed (no certificate), skipping`
      )
      return
    }

    const intermediate = join(dir, 'c1')
    if (!existsSync(intermediate)) {
      throw new Error(
        'verify-signing-chain: the signature has a leaf certificate but no ' +
          'intermediate, so the issuing authority cannot be identified. Ensure ' +
          'the signing .p12 carries its intermediate ' +
          '(openssl pkcs12 -export -certfile ...).'
      )
    }

    const subject = execFileSync(
      'openssl',
      ['x509', '-inform', 'DER', '-in', intermediate, '-noout', '-subject'],
      { encoding: 'utf8' }
    ).trim()

    if (!subject.includes(WANT_OU)) {
      throw new Error(
        `verify-signing-chain: ${app} was signed via the pre-G2 sub-CA, which ` +
          'expires 2027-02-01.\n' +
          `  intermediate: ${subject}\n` +
          '  Request a Developer ID certificate from the G2 Sub-CA and sign with ' +
          'that one; see docs/macos-signing.md.'
      )
    }

    console.log(`  • verify-signing-chain: ok (${WANT_OU})`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
