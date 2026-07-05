// Pins a real round-trip for the D1 corpus-injection contract (extraction-
// prompt-redesign plan, step 3a): the reports CSV's real ID-column name,
// written through the actual upload feature, must reach the actual
// prompt-building code on the playbook page — not just each half tested in
// isolation against a hand-built payload (a code-review finding: the prior
// coverage only unit-tested Storage.saveDataAsset/getDataAsset directly and
// ExtractionPrompt.build with a hand-constructed `corpus` object, never the
// real write-side feature followed by the real read-side feature).

const { test, expect } = require('@playwright/test');
const { gotoApp, resetIndexedDb } = require('./helpers');

test.describe('corpus_id_column real round-trip (D1)', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await resetIndexedDb(page);
  });

  test('a reports CSV with a distinctive ID column name flows through the real upload feature into the real playbook prompt', async ({ page }) => {
    await page.evaluate(async () => {
      const app = Alpine.store('app');
      const csv = 'accession_number,report_text\n'
        + 'ARN-0001,"FINDINGS:\n\nNo acute findings."\n'
        + 'ARN-0002,"FINDINGS:\n\nNo acute findings."\n';
      const file = new File([csv], 'reports.csv', { type: 'text/csv' });
      await app.handleReportsCsvUpload(file);
      // handleReportsCsvUpload auto-detects columns via CsvImport.detectColumns
      // (real code path) — confirm it actually found them before proceeding.
      if (!app.uploadIdCol || !app.uploadTextCol) throw new Error('column auto-detect failed: ' + JSON.stringify({ id: app.uploadIdCol, text: app.uploadTextCol }));
      await app.confirmUpload();
    });
    await page.waitForFunction(() => Alpine.store('app').currentView === 'annotate');

    // Real write-side assertion: the asset actually landed in IndexedDB with
    // the real column name (not a hand-built payload).
    const asset = await page.evaluate(async () => await Storage.getDataAsset('corpus_id_column'));
    expect(asset.payload.idColumn).toBe('accession_number');

    // Real read-side assertion: the playbook page's own DOMContentLoaded
    // handler (not a hand-called ExtractionPrompt.build) renders it into
    // the actual prompt shown to the user.
    await page.goto('/pages/llm-extractions.html');
    await page.waitForLoadState('networkidle');
    const promptText = await page.locator('#prompt-text').textContent();
    expect(promptText).toContain('`accession_number` column');
    expect(promptText).toMatch(/ARN-0001.*ARN-0002|ARN-0002.*ARN-0001/s);
  });
});
