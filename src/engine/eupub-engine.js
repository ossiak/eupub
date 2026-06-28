// Engine bootstrap — the only new code that touches the euspell engine, and it
// only *calls* it. converter.convert() and dom-walker.walkTextNodes() are reused
// verbatim from euspell_ext (the same pair the browser content script and the
// PDF viewer drive). This file is bundled into dist/eupub-engine.js and injected
// into each chapter iframe, where `document` is the chapter document.
import { convert } from '../../../euspell_ext/src/content/converter.js';
import { walkTextNodes } from '../../../euspell_ext/src/content/dom-walker.js';

// Convert the whole chapter body in place. walkTextNodes groups text by
// block-level ancestor and converts each block as one token stream, so the
// disambiguation rules see full in-block context — identical to a webpage.
function run() {
  walkTextNodes(document.body, convert);
}

// Exposed so the reader can re-run conversion if a chapter mutates (it normally
// does not — EPUB chapters are static — but this keeps the hook available and
// mirrors the content-script contract). Auto-run once on injection.
window.__eupubConvert = run;
run();
