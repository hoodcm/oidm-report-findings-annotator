/**
 * Regenerate tests/fixtures/sample.idm — the .idm bundle test fixture.
 *
 *   node tests/fixtures/make-idm.js
 *
 * Zips the repo's data/ directory (the conceptually-unpacked .idm) behind a
 * hand-written manifest. This script is the reference producer for the
 * manifest contract in js/idm-loader.js until the imaging-findings-workbench
 * exporter exists; when that lands it should target the same spec.
 */

const fs = require('fs');
const path = require('path');
const { zipSync, strToU8 } = require('fflate');

const ROOT = path.join(__dirname, '..', '..');
const read = (f) => new Uint8Array(fs.readFileSync(path.join(ROOT, 'data', f)));

const manifest = {
  format: 'oidm-idm',
  format_version: 1,
  name: 'CXR findings bundle (test fixture)',
  exam_type: 'CXR',
  generated_by: 'tests/fixtures/make-idm.js',
  // Fixed timestamp: the loader derives the taxonomy/attributes version
  // stamp from generated_at, and tests pin against it.
  generated_at: '2026-07-03T00:00:00.000Z',
  contents: {
    taxonomy: 'taxonomy.json',
    attributes: 'attributes.json',
    normality_mappings: 'normality-mappings.json',
    actionability_rules: 'actionability-rules.json',
  },
};

const zip = zipSync({
  'manifest.json': strToU8(JSON.stringify(manifest, null, 2)),
  'taxonomy.json': read('taxonomy.json'),
  'attributes.json': read('attributes.json'),
  'normality-mappings.json': read('normality-mappings.json'),
  'actionability-rules.json': read('actionability-rules.json'),
});

const out = path.join(__dirname, 'sample.idm');
fs.writeFileSync(out, zip);
console.log(`wrote ${out} (${zip.length} bytes)`);
