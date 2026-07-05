// Re-import warning copy (B3): the Step-2 validated-findings notice must be an
// amber "your annotations are kept" heads-up, not a red "permanently deleted"
// warning — because confirmExtractionImport merges and preserves, never deletes.

const { test, expect } = require('@playwright/test');
const { gotoApp, resetIndexedDb, seedTaxonomy, seedReports } = require('./helpers');

test.describe('Re-import validated-findings notice copy', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await resetIndexedDb(page);
    await seedTaxonomy(page);
    await seedReports(page, ['R001']);
    await page.waitForFunction(() => Alpine.store('app').currentView === 'annotate');
    // Give R001 a validated finding so the re-import notice fires.
    await page.evaluate(async () => {
      const app = Alpine.store('app');
      app.report.findings.push({
        finding_name: 'acute infarct', status: 'validated', taxonomy_id: 'HID005', source_sentence_idx: 1,
        source_text: 'No acute infarct.', origin: 'llm', is_custom: false,
        attributes: { presence: 'absent' },
      });
      await app._saveCurrentReport();
    });
  });

  test('Step 2 shows the amber preserve notice; no "permanently deleted" text', async ({ page }) => {
    await page.evaluate(async () => {
      const app = Alpine.store('app');
      app.extractionData = [{ record_id: 'R001', finding_name: 'mass effect', source_text: 'No mass effect.', presence: 'absent' }];
      app.extractionFields = ['record_id', 'finding_name', 'source_text', 'presence'];
      app.extractionColumnMap = { record_id: 'record_id', finding_name: 'finding_name', source_text: 'source_text', presence: 'presence' };
      app.recordIds = ['R001'];
      app.currentView = 'import-extractions';
      await app.runExtractionValidation();
      await app.processExtractionImport(); // advances to Step 2, populates the notice
    });

    await expect(page.getByText(/Your annotations are kept/i)).toBeVisible();
    await expect(page.getByText(/permanently deleted/i)).toHaveCount(0);
  });
});
