/**
 * Per-function unit tests for js/storage.js. Smaller-scoped than the Tier-1
 * round-trip contracts in contracts.test.js — covers the simple Dexie
 * wrappers that don't carry user data integrity guarantees but should still
 * behave predictably (update-in-place, delete, count, clear).
 *
 * Each test resets the DB so order independence is preserved. Dexie shares
 * one DB instance across the whole runner (it's a module-scoped singleton
 * in js/storage.js), so an explicit clear is necessary.
 */

async function resetAll() {
  try { await Storage.clearAllReports(); } catch (_) { /* ignore */ }
  try { await Storage.clearTaxonomy(); } catch (_) { /* ignore */ }
}

describe('Storage v4 upgrade — validated_at backfill (F1 regression)', () => {
  // The v4 index on validated_at is the sole source of truth for "validated".
  // A report validated before v4 has `validated: true` but no validated_at, so
  // without this backfill it drops out of the index and reads as unvalidated
  // after the upgrade. (The upgrade callback can't run against a fresh test DB
  // opened straight at v4, so the per-report mutation is tested directly.)
  it('stamps an epoch validated_at on a validated report that has none', () => {
    const r = { record_id: 'legacy', validated: true };
    Storage._backfillValidatedAt(r);
    assertEqual(r.validated_at, new Date(0).toISOString());
  });

  it('leaves an unvalidated report untouched', () => {
    const r = { record_id: 'pending', validated: false };
    Storage._backfillValidatedAt(r);
    assertEqual(r.validated_at, undefined);
  });

  it('preserves an existing validated_at (no clobber)', () => {
    const stamp = '2026-07-03T12:00:00.000Z';
    const r = { record_id: 'fresh', validated: true, validated_at: stamp };
    Storage._backfillValidatedAt(r);
    assertEqual(r.validated_at, stamp);
  });

  it('a backfilled report then appears in getValidatedIds (index round-trip)', async () => {
    await resetAll();
    const r = { record_id: 'legacy-1', validated: true };
    Storage._backfillValidatedAt(r);
    await Storage.savePlainReport(r);
    const ids = await Storage.getValidatedIds();
    assert(ids.includes('legacy-1'), 'backfilled report is in the validated_at index');
  });
});

describe('Storage backups — bundle assets + validated_at (C2/C3 regressions)', () => {
  // C2: a bundle-governed session's backup must carry (and restore) the bundle
  // assets — restoring reports/taxonomy without the schema that governed them
  // re-annotates under the wrong vocabulary. schema_meta never rides along.
  it('backupNow snapshots bundle assets and restoreBackup restores them (replacing current)', async () => {
    await resetAll();
    await Storage.clearDataAssets();
    await Storage.saveReport({ record_id: 'r1', report_text: 'x' });
    await Storage.saveDataAsset({ name: 'attributes', payload: { presence: { values: ['present'] } }, version: 'A:1' });
    await Storage.saveDataAsset({ name: 'schema_meta', payload: { dataSchemaVersion: 7 } });
    const id = await Storage.backupNow('c2-test');

    // Simulate a later state governed by a DIFFERENT bundle.
    await Storage.clearBundleAssets();
    await Storage.saveDataAsset({ name: 'attributes', payload: { presence: { values: ['other'] } }, version: 'B:2' });

    await Storage.restoreBackup(id);
    const attrs = await Storage.getDataAsset('attributes');
    assertEqual(attrs.version, 'A:1'); // the backup's own asset, not bundle B's
    const meta = await Storage.getDataAsset('schema_meta');
    assert(meta !== null, 'reserved schema_meta record survives the restore');
  });

  it('restoreBackup with no snapshotted assets clears the current bundle assets', async () => {
    await resetAll();
    await Storage.clearDataAssets();
    await Storage.saveReport({ record_id: 'r1', report_text: 'x' });
    const id = await Storage.backupNow('pre-bundle'); // snapshot with NO assets
    await Storage.saveDataAsset({ name: 'attributes', payload: {}, version: 'B:2' });
    await Storage.restoreBackup(id);
    assertEqual(await Storage.getDataAsset('attributes'), null); // repo default governs
  });

  // C3: a backup taken before v4 holds validated reports without validated_at;
  // restoring must backfill so they don't vanish from the validated index.
  it('restoreBackup backfills validated_at on legacy validated reports', async () => {
    await resetAll();
    await Storage.saveReport({ record_id: 'legacy-v', validated: true, validated_at: new Date(0).toISOString() });
    const id = await Storage.backupNow('c3-test');
    // Regress the stored snapshot to the pre-v4 shape (validated, no stamp).
    const b = await Storage._db.backups.get(id);
    b.reports.forEach(r => { delete r.validated_at; });
    await Storage._db.backups.put(b);

    await Storage.restoreBackup(id);
    const ids = await Storage.getValidatedIds();
    assert(ids.includes('legacy-v'), 'restored legacy validated report is in the validated_at index');
  });
});

describe('Storage.saveReport / loadReport — basic semantics', () => {
  it('saveReport overwrites the previous value for the same record_id', async () => {
    await resetAll();
    await Storage.saveReport({ record_id: 'r1', report_text: 'first', validated: false });
    await Storage.saveReport({ record_id: 'r1', report_text: 'second', validated: true });
    const r = await Storage.loadReport('r1');
    assertEqual(r.report_text, 'second');
    assertEqual(r.validated, true);
  });

  it('loadReport returns null for an id that was never saved', async () => {
    await resetAll();
    const r = await Storage.loadReport('never-existed');
    assertEqual(r, null);
  });
});

describe('Storage.deleteReport / clearAllReports', () => {
  it('deleteReport removes a single row and leaves siblings alone', async () => {
    await resetAll();
    await Storage.saveReport({ record_id: 'keep-1', report_text: 'a' });
    await Storage.saveReport({ record_id: 'drop-1', report_text: 'b' });
    await Storage.deleteReport('drop-1');
    assertEqual(await Storage.loadReport('drop-1'), null);
    const kept = await Storage.loadReport('keep-1');
    assertEqual(kept.report_text, 'a');
  });

  it('clearAllReports empties the table', async () => {
    await resetAll();
    await Storage.saveReport({ record_id: 'a', report_text: 'x' });
    await Storage.saveReport({ record_id: 'b', report_text: 'y' });
    await Storage.clearAllReports();
    assertEqual(await Storage.getReportCount(), 0);
  });
});

// corpus_id_column: the reports CSV's original ID-column name, recorded so
// the LLM extraction prompt (built on a later visit, possibly a different
// page load) can name the real column instead of a generic placeholder.
describe('Storage corpus_id_column asset lifecycle', () => {
  it('clearAllReports drops corpus_id_column (meaningless without a corpus)', async () => {
    await resetAll();
    await Storage.clearDataAssets();
    await Storage.saveDataAsset({ name: 'corpus_id_column', payload: { idColumn: 'accession_number' } });
    await Storage.clearAllReports();
    assertEqual(await Storage.getDataAsset('corpus_id_column'), null);
  });

  it('clearBundleAssets preserves corpus_id_column (report-scoped, not bundle-governed)', async () => {
    await resetAll();
    await Storage.clearDataAssets();
    await Storage.saveDataAsset({ name: 'corpus_id_column', payload: { idColumn: 'accession_number' } });
    await Storage.saveDataAsset({ name: 'attributes', payload: { presence: {} } });
    await Storage.clearBundleAssets();
    const kept = await Storage.getDataAsset('corpus_id_column');
    assertEqual(kept && kept.payload.idColumn, 'accession_number');
    assertEqual(await Storage.getDataAsset('attributes'), null);
  });
});

describe('Storage.listReportIds / getReportCount', () => {
  it('listReportIds returns the ids in sorted order', async () => {
    await resetAll();
    await Storage.saveReport({ record_id: 'r-c' });
    await Storage.saveReport({ record_id: 'r-a' });
    await Storage.saveReport({ record_id: 'r-b' });
    const ids = await Storage.listReportIds();
    assertDeepEqual(ids, ['r-a', 'r-b', 'r-c']);
  });

  it('getReportCount returns numeric count', async () => {
    await resetAll();
    assertEqual(await Storage.getReportCount(), 0);
    await Storage.saveReport({ record_id: 'one' });
    await Storage.saveReport({ record_id: 'two' });
    assertEqual(await Storage.getReportCount(), 2);
  });
});

describe('Storage.getProgress / getValidatedIds', () => {
  it('getProgress reports validated / total', async () => {
    await resetAll();
    // The app writes validated + validated_at together; the v4 index on
    // validated_at is the source of truth (null = unvalidated).
    await Storage.saveReport({ record_id: 'a', validated: true, validated_at: '2026-07-01T00:00:00Z' });
    await Storage.saveReport({ record_id: 'b', validated: false, validated_at: null });
    await Storage.saveReport({ record_id: 'c', validated: true, validated_at: '2026-07-02T00:00:00Z' });
    const p = await Storage.getProgress();
    assertEqual(p.total, 3);
    assertEqual(p.validated, 2);
  });

  it('getValidatedIds returns only validated record_ids', async () => {
    await resetAll();
    await Storage.saveReport({ record_id: 'v1', validated: true, validated_at: '2026-07-01T00:00:00Z' });
    await Storage.saveReport({ record_id: 'p1', validated: false, validated_at: null });
    await Storage.saveReport({ record_id: 'v2', validated: true, validated_at: '2026-07-02T00:00:00Z' });
    const ids = (await Storage.getValidatedIds()).sort();
    assertDeepEqual(ids, ['v1', 'v2']);
  });
});

describe('Storage.clearTaxonomy', () => {
  it('clearTaxonomy makes a subsequent loadTaxonomy return null', async () => {
    await resetAll();
    await Storage.saveTaxonomy('CT Head', 'ct.csv', [{ id: 'X', name: 'a', synonyms: [], category: 'c', parent_id: null, finding_type: 'observation' }], false);
    assert((await Storage.loadTaxonomy()) !== null, 'precondition: taxonomy present');
    await Storage.clearTaxonomy();
    assertEqual(await Storage.loadTaxonomy(), null);
  });
});
