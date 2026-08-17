// Writes dist/sample.epub, the book the desktop app opens on first launch.
//
// The mobile builds have always shipped one: android/prepare-assets.mjs and
// ios/Eupub/prepare-assets.mjs both call makeEpub() into their asset bundles,
// and their hosts point the reader at it when no last book exists. The desktop
// had no equivalent, so a first run showed the welcome screen and nothing else
// until the user found a book — which reads as an app that does nothing, both
// to a new user and to a store's certification tester.
//
// Same generator as mobile, so the three platforms open the identical book.
const path = require('node:path');
const { makeEpub } = require('../test/make-epub.js');

const dest = path.join(__dirname, '..', 'dist', 'sample.epub');
makeEpub(dest);
console.log('Sample book ->', path.relative(path.join(__dirname, '..'), dest));
