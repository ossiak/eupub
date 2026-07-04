import { nodeResolve } from '@rollup/plugin-node-resolve';
import { fileURLToPath } from 'node:url';

// Mobile engine build: identical to rollup.engine.config.mjs, but a resolver
// alias swaps euspell_ext's lexicon-source.js for its .mobile variant, which has
// NO baked-in lexicon import. So the ~14 MB compiled Map is never referenced and
// never bundled — the resulting engine is ~14 MB smaller, and the host must
// inject each chapter's subset via EupubEngine.setLexicon() (fetched from the
// SQLite lexicon). See docs/android-port.md.
const MOBILE_LEXICON_SOURCE = fileURLToPath(
  new URL('../euspell_ext/src/content/lexicon-source.mobile.js', import.meta.url)
);

const aliasMobileLexicon = {
  name: 'eupub-mobile-lexicon-alias',
  resolveId(source, importer) {
    // Every importer (converter.js, tagger.js, the bootstrap) imports
    // "./lexicon-source.js" or ".../lexicon-source.js"; redirect them all.
    if (importer && /(^|[\\/])lexicon-source\.js$/.test(source)) return MOBILE_LEXICON_SOURCE;
    return null;
  },
};

export default {
  input: 'src/engine/eupub-engine.js',
  output: {
    file: 'dist/eupub-engine.mobile.js',
    format: 'iife',
    name: 'EupubEngine',
    sourcemap: false,
  },
  plugins: [aliasMobileLexicon, nodeResolve()],
};
