// Atomicity contracts: pre-existing data must survive a failed import.
//
// IE1 (reports upload): confirmUpload/_writeReportsAndStartSession must call
//   atomicReplace, not clear-then-loop. Inject a failure mid-write and assert
//   the original reports remain.
//
// H1 (session restore): restoreSession must wrap clear+bulkPut in one Dexie
//   transaction. Same shape — failure mid-restore must leave the prior
//   reports intact.

const { test, expect } = require('@playwright/test');
const { gotoApp, resetIndexedDb, seedTaxonomy, seedReports } = require('./helpers');

test.describe('Atomic-replace contracts: failed imports do not destroy prior data', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await resetIndexedDb(page);
    await seedTaxonomy(page);
    await seedReports(page, ['R001', 'R002', 'R003']);
    await page.waitForFunction(() => Alpine.store('app').currentView === 'annotate');
  });

  test('IE1: reports upload failure leaves the seeded reports intact', async ({ page }) => {
    const idsBefore = await page.evaluate(async () => (await Storage.listReportIds()).sort());
    expect(idsBefore).toEqual(['R001', 'R002', 'R003']);

    // Monkey-patch atomicReplace to reject after a microtask. This stands in
    // for any kind of mid-write failure (quota error, schema constraint,
    // browser crash) — what we're pinning is the structural guarantee:
    // confirmUpload must use atomicReplace, so the transaction wrapping
    // means the clear() rolls back when the bulkPut rejects.
    await page.evaluate(() => {
      window.__originalAtomicReplace = Storage.atomicReplace;
      Storage.atomicReplace = async () => {
        throw new Error('injected mid-write failure');
      };
    });

    // Drive an upload via the underlying path. Note: confirmUpload depends on
    // uploadData / uploadIdCol / uploadTextCol being preset. Easier to call
    // _writeReportsAndStartSession directly with new reports — that's the
    // method confirmUpload uses for the atomic write.
    let threw = false;
    try {
      await page.evaluate(async () => {
        await Alpine.store('app')._writeReportsAndStartSession([
          { record_id: 'NEW-1', report_text: 'x', sentences: [], schema_version: 5, validated: false, validated_findings: [], llm_extractions: [] },
        ]);
      });
    } catch (e) {
      threw = true;
    }
    expect(threw).toBe(true);

    // Restore the real atomicReplace so future calls work.
    await page.evaluate(() => { Storage.atomicReplace = window.__originalAtomicReplace; });

    // The original three reports must still be present.
    const idsAfter = await page.evaluate(async () => (await Storage.listReportIds()).sort());
    expect(idsAfter).toEqual(['R001', 'R002', 'R003']);
  });

  test('H1: session restore failure leaves the seeded reports intact', async ({ page }) => {
    await page.evaluate(() => {
      window.__originalAtomicReplace = Storage.atomicReplace;
      Storage.atomicReplace = async () => {
        throw new Error('injected restore failure');
      };
    });

    // Drive restoreSession with a valid-looking session blob.
    await page.evaluate(async () => {
      const blob = new Blob([JSON.stringify({
        version: 1,
        created_at: '2025-01-01T00:00:00Z',
        reports: [{ record_id: 'NEW-RESTORE', report_text: 'FINDINGS: A:\n- One.', validated: false, validated_findings: [], llm_extractions: [] }],
      })], { type: 'application/json' });
      const file = new File([blob], 'session.json', { type: 'application/json' });
      await Alpine.store('app').restoreSession(file);
    });

    // restoreSession swallows the throw and shows an error toast; verify state.
    const state = await page.evaluate(async () => ({
      toastType: Alpine.store('app').toastType,
      ids: (await Storage.listReportIds()).sort(),
    }));
    expect(state.toastType).toBe('error');
    expect(state.ids).toEqual(['R001', 'R002', 'R003']);

    await page.evaluate(() => { Storage.atomicReplace = window.__originalAtomicReplace; });
  });
});
