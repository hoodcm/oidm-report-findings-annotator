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
    await Storage.saveReport({ record_id: 'a', validated: true });
    await Storage.saveReport({ record_id: 'b', validated: false });
    await Storage.saveReport({ record_id: 'c', validated: true });
    const p = await Storage.getProgress();
    assertEqual(p.total, 3);
    assertEqual(p.validated, 2);
  });

  it('getValidatedIds returns only validated record_ids', async () => {
    await resetAll();
    await Storage.saveReport({ record_id: 'v1', validated: true });
    await Storage.saveReport({ record_id: 'p1', validated: false });
    await Storage.saveReport({ record_id: 'v2', validated: true });
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
