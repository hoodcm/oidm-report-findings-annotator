// Pins the D4 merge-mode contract (extraction-prompt-redesign plan, step 5):
// re-importing an extraction file onto a report that already has UNREVIEWED
// (pending) findings from an earlier import no longer silently drops them.
//
//   - 'add' (default): existing pending findings are kept; the new import's
//     rows are appended alongside them.
//   - 'replace': reproduces the pre-plan behavior — existing pending findings
//     are dropped and replaced by the new import's rows.
//
// Validated-finding merge behavior (attribute fill-in-only, never overwrite)
// is unchanged in both modes and is covered separately in
// extraction-import-preserves-validated.spec.js.

const { test, expect } = require('@playwright/test');
const { gotoApp, resetIndexedDb, seedTaxonomy, seedReports } = require('./helpers');

async function runImport(page, payload, mergeMode, recordIds = ['R001']) {
  return page.evaluate(async ({ payload, mergeMode, recordIds }) => {
    const app = Alpine.store('app');
    app.extractionData = payload;
    app.extractionFields = Object.keys(payload[0] || {});
    app.extractionColumnMap = {
      record_id: 'record_id',
      finding_name: 'finding_name',
      source_text: 'source_text',
      presence: 'presence',
    };
    app.recordIds = recordIds;
    app.extractionMergeMode = mergeMode;
    await app.runExtractionValidation();
    await app.processExtractionImport();
    await app.confirmExtractionImport();
  }, { payload, mergeMode, recordIds });
}

test.describe('Extraction import merge-mode (D4)', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await resetIndexedDb(page);
    await seedTaxonomy(page);
    await seedReports(page, ['R001']);
    await page.waitForFunction(() => Alpine.store('app').currentView === 'annotate');

    // Seed R001 with one PRE-EXISTING PENDING finding (an earlier import the
    // annotator hasn't reviewed yet) anchored to sentence #2 ("No mass effect.").
    await page.evaluate(async () => {
      const app = Alpine.store('app');
      app.report.findings.push({
        finding_name: 'old_pending_finding',
        status: 'pending',
        source_sentence_idx: 2,
        source_text: 'No mass effect.',
        attributes: { presence: 'absent' },
      });
      await app._saveCurrentReport();
    });
  });

  test('processExtractionImport surfaces the report as having existing pending findings', async ({ page }) => {
    await page.evaluate(async () => {
      const app = Alpine.store('app');
      app.extractionData = [{ record_id: 'R001', finding_name: 'acute infarct', source_text: 'No acute infarct.', presence: 'present' }];
      app.extractionFields = ['record_id', 'finding_name', 'source_text', 'presence'];
      app.extractionColumnMap = { record_id: 'record_id', finding_name: 'finding_name', source_text: 'source_text', presence: 'presence' };
      app.recordIds = ['R001'];
      await app.runExtractionValidation();
      await app.processExtractionImport();
    });
    const withExisting = await page.evaluate(() => Alpine.store('app').extractionReportsWithExisting);
    expect(withExisting).toContain('R001');
  });

  test("'add' mode (default) keeps the old pending finding and appends the new one", async ({ page }) => {
    await runImport(page, [
      { record_id: 'R001', finding_name: 'acute infarct', source_text: 'No acute infarct.', presence: 'present' },
    ], 'add');

    const report = await page.evaluate(async () => await Storage.loadReport('R001'));
    const pending = report.findings.filter(f => f.status === 'pending');
    expect(pending.length).toBe(2);
    const names = pending.map(f => f.finding_name).sort();
    expect(names).toEqual(['acute infarct', 'old_pending_finding']);
  });

  test("'replace' mode drops the old pending finding and keeps only the new import", async ({ page }) => {
    await runImport(page, [
      { record_id: 'R001', finding_name: 'acute infarct', source_text: 'No acute infarct.', presence: 'present' },
    ], 'replace');

    const report = await page.evaluate(async () => await Storage.loadReport('R001'));
    const pending = report.findings.filter(f => f.status === 'pending');
    expect(pending.length).toBe(1);
    expect(pending[0].finding_name).toBe('acute infarct');
  });

  test("same-mergeKey discrete rows from one sentence simply append in 'add' mode (no dedup)", async ({ page }) => {
    // Three discrete rows sharing one sentence (e.g. three rib fractures) —
    // 'add' mode is a plain append, not a smart merge, so all three land as
    // new pending rows alongside the old one.
    await runImport(page, [
      { record_id: 'R001', finding_name: 'rib_fracture', source_text: 'No acute infarct.', presence: 'present', laterality: 'left' },
      { record_id: 'R001', finding_name: 'rib_fracture', source_text: 'No acute infarct.', presence: 'present', laterality: 'right' },
    ], 'add');

    const report = await page.evaluate(async () => await Storage.loadReport('R001'));
    const pending = report.findings.filter(f => f.status === 'pending');
    expect(pending.length).toBe(3); // 1 old + 2 new discrete rows
  });
});
