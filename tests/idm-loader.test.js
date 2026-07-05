/**
 * Tests for js/idm-loader.js — the .idm bundle manifest contract (spec v1)
 * and parseBundle structure checks, plus the Dexie v4 schema contract
 * (validated_at index + dataAssets table).
 *
 * The manifest schema is cross-repo: the imaging-findings-workbench exporter
 * will target it, so these tests pin the acceptance/rejection rules rather
 * than incidental behavior.
 */

const fs = require('fs');
const path = require('path');
const { zipSync, strToU8 } = require('fflate');

const GOOD_MANIFEST = {
  format: 'oidm-idm',
  format_version: 1,
  name: 'test bundle',
  exam_type: 'CXR',
  generated_by: 'test',
  generated_at: '2026-07-03T00:00:00.000Z',
  contents: { taxonomy: 'taxonomy.json' },
};

const zipOf = (files) => zipSync(
  Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(typeof v === 'string' ? v : JSON.stringify(v))]))
);

describe('IdmLoader.validateManifest — manifest schema v1', () => {
  it('accepts a well-formed v1 manifest', () => {
    const r = IdmLoader.validateManifest(GOOD_MANIFEST);
    assert(r.ok, r.errors.join('; '));
  });

  it('accepts a manifest with no contents (all entries optional)', () => {
    const r = IdmLoader.validateManifest({ format: 'oidm-idm', format_version: 1 });
    assert(r.ok, r.errors.join('; '));
  });

  it('rejects a wrong format tag', () => {
    const r = IdmLoader.validateManifest({ ...GOOD_MANIFEST, format: 'something-else' });
    assert(!r.ok);
    assert(r.errors.some(e => e.includes('oidm-idm')), 'names the expected format');
  });

  it('rejects a missing format_version', () => {
    const m = { ...GOOD_MANIFEST };
    delete m.format_version;
    const r = IdmLoader.validateManifest(m);
    assert(!r.ok);
  });

  it('rejects an unsupported (newer) format_version with a plain-language message', () => {
    const r = IdmLoader.validateManifest({ ...GOOD_MANIFEST, format_version: 2 });
    assert(!r.ok);
    assert(r.errors.some(e => /newer version/.test(e)), 'says the bundle is newer than the app');
  });

  it('rejects format_version < 1 and non-integer versions', () => {
    assert(!IdmLoader.validateManifest({ ...GOOD_MANIFEST, format_version: 0 }).ok);
    assert(!IdmLoader.validateManifest({ ...GOOD_MANIFEST, format_version: '1' }).ok);
  });

  it('rejects a non-object manifest and a malformed contents block', () => {
    assert(!IdmLoader.validateManifest(null).ok);
    assert(!IdmLoader.validateManifest([1, 2]).ok);
    assert(!IdmLoader.validateManifest({ ...GOOD_MANIFEST, contents: ['taxonomy.json'] }).ok);
  });
});

describe('IdmLoader.parseBundle — zip structure', () => {
  it('parses a good bundle and returns manifest + entries', () => {
    const bytes = zipOf({ 'manifest.json': GOOD_MANIFEST, 'taxonomy.json': [{ id: 'T1', name: 'nodule', category: 'lung' }] });
    const { manifest, entries } = IdmLoader.parseBundle(bytes);
    assertEqual(manifest.exam_type, 'CXR');
    assert(entries['taxonomy.json'] instanceof Uint8Array);
  });

  it('throws on bytes that are not a zip', () => {
    assertThrows(() => IdmLoader.parseBundle(strToU8('not a zip at all')));
  });

  it('throws on an empty zip', () => {
    assertThrows(() => IdmLoader.parseBundle(zipSync({})));
  });

  it('throws when manifest.json is missing', () => {
    assertThrows(() => IdmLoader.parseBundle(zipOf({ 'taxonomy.json': [] })));
  });

  it('throws when manifest.json is not valid JSON', () => {
    assertThrows(() => IdmLoader.parseBundle(zipOf({ 'manifest.json': '{oops' })));
  });

  it('throws when the manifest fails validation (bad format)', () => {
    assertThrows(() => IdmLoader.parseBundle(zipOf({ 'manifest.json': { ...GOOD_MANIFEST, format: 'nope' } })));
  });

  it('the committed fixture tests/fixtures/sample.idm parses under the same contract', () => {
    const bytes = new Uint8Array(fs.readFileSync(path.join(__dirname, 'fixtures', 'sample.idm')));
    const { manifest, entries } = IdmLoader.parseBundle(bytes);
    assertEqual(manifest.format, 'oidm-idm');
    assertEqual(manifest.format_version, 1);
    assertEqual(manifest.exam_type, 'CXR');
    for (const p of Object.values(manifest.contents)) {
      assert(entries[p], `contents entry ${p} present in the zip`);
    }
  });
});

describe('IdmLoader._normalizeTaxonomy — bundled JSON taxonomy path', () => {
  it('normalizes to the same post-parse shape as the CSV path (flat taxonomy legal)', () => {
    const rows = [{ id: 'T1', name: 'nodule', category: 'lung', synonyms: ['spot'] }];
    const out = IdmLoader._normalizeTaxonomy(rows);
    assertDeepEqual(out, [{ id: 'T1', name: 'nodule', category: 'lung', parent_id: null, synonyms: ['spot'], finding_type: null }]);
  });

  it('splits string synonyms and drops rows without id or name', () => {
    const out = IdmLoader._normalizeTaxonomy([
      { id: 'T1', name: 'nodule', category: 'lung', synonyms: 'spot, lesion' },
      { id: '', name: 'nameless', category: 'x' },
    ]);
    assertEqual(out.length, 1);
    assertDeepEqual(out[0].synonyms, ['spot', 'lesion']);
  });

  it('throws on a non-array or all-invalid taxonomy', () => {
    assertThrows(() => IdmLoader._normalizeTaxonomy({}));
    assertThrows(() => IdmLoader._normalizeTaxonomy([{ category: 'lung' }]));
  });
});

describe('Dexie v4 schema contract — validated_at index + dataAssets', () => {
  it('reports store carries the validated_at index (null validated_at excluded)', async () => {
    // Functional pin: orderBy('validated_at') is a real index query, and a
    // null validated_at is absent from it — exactly the unvalidated set.
    await window.Storage.saveReport({ record_id: 'IDX1', validated: false, validated_at: null, findings: [] });
    await window.Storage.saveReport({ record_id: 'IDX2', validated: true, validated_at: '2026-07-03T00:00:00Z', findings: [] });
    const keys = await window.Storage._db.reports.orderBy('validated_at').primaryKeys();
    assert(keys.includes('IDX2'), 'validated report present in index');
    assert(!keys.includes('IDX1'), 'null validated_at excluded from index');
    await window.Storage.deleteReport('IDX1');
    await window.Storage.deleteReport('IDX2');
  });

  it('dataAssets round-trips by name and lists', async () => {
    await window.Storage.saveDataAsset({ name: 'normality_mappings', payload: { a: 1 }, version: 'CXR:123', source: 'sample.idm' });
    const got = await window.Storage.getDataAsset('normality_mappings');
    assertDeepEqual(got.payload, { a: 1 });
    assertEqual(got.version, 'CXR:123');
    const all = await window.Storage.listDataAssets();
    assert(all.some(a => a.name === 'normality_mappings'));
    await window.Storage.clearDataAssets();
    assertEqual(await window.Storage.getDataAsset('normality_mappings'), null);
  });
});
