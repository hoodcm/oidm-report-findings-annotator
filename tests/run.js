/**
 * Headless test runner. Run with: node tests/run.js
 *
 * Loads the app modules with a minimal `window` shim so the same files that
 * run in the browser work in Node, then runs the same test files the browser
 * runner uses. Exits 1 on any failure.
 */

global.window = global;

// Wire fake-indexeddb + Dexie into the Node runtime BEFORE loading js/storage.js.
// js/storage.js does `new Dexie('AnnotationDB')` at module top-level, so both
// `indexedDB` (via fake-indexeddb/auto) and the global `Dexie` constructor must
// be present at require time. The browser loads Dexie from a CDN; in Node we
// use the published package.
require('fake-indexeddb/auto');
global.Dexie = require('dexie').Dexie || require('dexie').default || require('dexie');
// The browser loads PapaParse from a vendored script; in Node we use the
// published package (js/file-classifier.js parses CSV samples with it).
global.Papa = require('papaparse');
// Same for fflate (js/idm-loader.js unzips .idm bundles with it).
global.fflate = require('fflate');

require('../js/sentences.js');
require('../js/taxonomy.js');
require('../js/schema.js');
require('../js/extraction-import.js');
require('../js/file-classifier.js');
require('../js/undo.js');
require('../js/idm-loader.js');
require('../js/extraction-prompt.js');
require('../js/extraction-example.js');
require('../js/exam-type.js');
require('../js/storage.js');

require('./framework.js');
require('./sentences.test.js');
require('./extraction-import.test.js');
require('./file-classifier.test.js');
require('./undo.test.js');
require('./idm-loader.test.js');
require('./extraction-prompt.test.js');
require('./exam-type.test.js');
require('./taxonomy.test.js');
require('./schema.test.js');
require('./contracts.test.js');
require('./storage.test.js');

(async () => {
  const r = await runTests();
  for (const s of r.suites) {
    const ok = s.failed === 0;
    console.log(`${ok ? '✓' : '✗'} ${s.name}  (${s.passed}/${s.tests.length})`);
    for (const t of s.tests) {
      if (!t.passed) {
        console.log(`    ✗ ${t.name}`);
        console.log(`      ${t.error}`);
      }
    }
  }
  console.log('');
  console.log(`${r.passed}/${r.total} passed${r.failed ? `  —  ${r.failed} failed` : ''}`);
  if (r.failed > 0) process.exit(1);
})();
