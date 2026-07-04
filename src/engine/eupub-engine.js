// Engine bootstrap — the only new code that touches the euspell engine, and it
// only *calls* it. converter.convert() and dom-walker.walkTextNodes() are reused
// verbatim from euspell_ext (the same pair the browser content script and the
// PDF viewer drive). This file is bundled into dist/eupub-engine.js and injected
// into each chapter iframe, where `document` is the chapter document.
import { convert } from '../../../euspell_ext/src/content/converter.js';
import { walkTextNodes } from '../../../euspell_ext/src/content/dom-walker.js';
import { setLexicon, resetLexicon } from '../../../euspell_ext/src/content/lexicon-source.js';

// Convert the whole chapter body in place. walkTextNodes groups text by
// block-level ancestor and converts each block as one token stream, so the
// disambiguation rules see full in-block context — identical to a webpage.
function run() {
  walkTextNodes(document.body, convert);
}

// Exposed so the reader can re-run conversion if a chapter mutates, and — the
// reason it's a public API — so the reader process can reform arbitrary text
// (a detached element) to build a euspell search index. walkTextNodes uses the
// ambient document's createTreeWalker, so the reader reforms a node it owns.
window.__eupubConvert = run;
// setLexicon/resetLexicon let a host swap the active lexicon. In the default
// (desktop) build the lexicon is baked in and these are optional; in the mobile
// build (lexicon excluded) the host MUST setLexicon() a per-chapter subset from
// the SQLite lexicon before converting. See docs/android-port.md.
window.EupubEngine = { convert: convert, walkTextNodes: walkTextNodes, setLexicon: setLexicon, resetLexicon: resetLexicon };

// Auto-run in chapter iframes. The reader loads this bundle with __eupubNoAuto
// set, to obtain the API only (so it does NOT reform the reader's own UI).
if (!window.__eupubNoAuto) run();
