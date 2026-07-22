// Shared generator for the embedded PDF viewer page. Android
// (android/prepare-assets.mjs) and the desktop (build/copy-pdf-viewer.mjs) both
// derive their pdf/viewer.html from the extension's page with the same three
// deltas — only the bridge script that provides window.eupub differs — so the
// transform lives here once.
import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {string} extDir  the euspell_ext checkout (sibling repo)
 * @param {string[]} bridgeScriptTags  <script> tag(s) loaded BEFORE the viewer
 *   module, so window.eupub exists first (classic scripts, not modules)
 * @returns {string} the generated viewer.html
 */
export function generateViewerHtml(extDir, bridgeScriptTags) {
  let html = fs.readFileSync(path.join(extDir, 'src', 'pdf', 'viewer.html'), 'utf8');

  // (a) Drop the header bar. Its "Open original" link would navigate the host
  //     frame to the raw PDF, and a chrome-free page is what an embed under the
  //     reader's own toolbar wants — which owns the page readout and any
  //     download/print affordances itself. viewer.js null-guards every element
  //     in the bar (#filename, #original, #pagecount, #download, #print), so
  //     removing them needs no JS change.
  if (!/<header id="bar">[\s\S]*?<\/header>\s*/.test(html)) {
    throw new Error('pdf/viewer.html: <header id="bar"> not found');
  }
  html = html.replace(/<header id="bar">[\s\S]*?<\/header>\s*/, '');

  // (b) Load the host bridge (classic, so window.eupub exists first) then the
  //     mobile bundle, instead of the extension's ../../dist/pdf-viewer.js.
  const extScript = '<script type="module" src="../../dist/pdf-viewer.js"></script>';
  if (!html.includes(extScript)) throw new Error('pdf/viewer.html: module script tag not found');
  html = html.replace(
    extScript,
    bridgeScriptTags.join('\n    ') + '\n    <script type="module" src="pdf-viewer.mobile.js"></script>'
  );

  // (c) Its own CSP — this page is a separate document, so the reader's CSP does
  //     not apply. Tighter than the reader's: no 'unsafe-inline' for scripts,
  //     because nothing here is inline (the bridge is an external file).
  //       'wasm-unsafe-eval' — pdf.js's jbig2/openjpeg/qcms decoders
  //       style-src 'unsafe-inline' — pdf.js's TextLayer writes inline styles
  //       connect-src — the ?file= PDF, plus the wasm/ and standard_fonts/ fetches
  //     No blob: in font-src: pdf.js 6 binds embedded fonts with
  //     new FontFace(name, ArrayBuffer), so no URL is ever fetched for them.
  const csp =
    `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; ` +
    `script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; ` +
    `img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'" />`;
  if (!html.includes('<meta charset="utf-8" />')) throw new Error('pdf/viewer.html: charset meta not found');
  html = html.replace('<meta charset="utf-8" />', `<meta charset="utf-8" />\n    ${csp}`);
  return html;
}
