import { nodeResolve } from '@rollup/plugin-node-resolve';

// Bundles the euspell conversion engine — reused *as-is* from the sibling
// euspell_ext project — into a single classic IIFE. The bundle is injected into
// each chapter iframe (see src/renderer/reader.js), so when it runs, `document`
// is the chapter's own document: exactly the environment dom-walker.js expects
// from a content script. Nothing in euspell_ext is modified; we only import its
// entry points. The relative imports inside converter.js / tagger.js resolve
// against their own location, so they keep pointing at euspell_ext/dist/*.
export default {
  input: 'src/engine/eupub-engine.js',
  output: {
    file: 'dist/eupub-engine.js',
    format: 'iife',
    name: 'EupubEngine',
    sourcemap: false,
  },
  plugins: [nodeResolve()],
};
