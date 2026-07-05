// Pins the D4 coverage-summary contract (extraction-prompt-redesign plan,
// step 9): "findings cover N of M loaded reports" + uncovered record_ids,
// informational and non-blocking — the signal for a silently partial
// extraction (the AI skipped some of the attached reports, or its reply got
// cut off before reaching them).

const { test, expect } = require('@playwright/test');
const { gotoApp, resetIndexedDb, seedTaxonomy, seedReports } = require('./helpers');

test.describe('Extraction import — coverage summary (D4)', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await resetIndexedDb(page);
    await seedTaxonomy(page);
    await seedReports(page, ['R001', 'R002']);
    await page.waitForFunction(() => Alpine.store('app').currentView === 'annotate');
  });

  test('partial coverage (1 of 2) names the uncovered report', async ({ page }) => {
    await page.evaluate(async () => {
      const app = Alpine.store('app');
      app.extractionData = [{ record_id: 'R001', finding_name: 'acute infarct', source_text: 'No acute infarct.', presence: 'present' }];
      app.extractionFields = ['record_id', 'finding_name', 'source_text', 'presence'];
      app.extractionColumnMap = { record_id: 'record_id', finding_name: 'finding_name', source_text: 'source_text', presence: 'presence' };
      app.recordIds = ['R001', 'R002'];
      app.currentView = 'import-extractions';
      await app.runExtractionValidation();
    });

    await expect(page.getByText('Findings cover 1 of 2 loaded reports')).toBeVisible();
    await expect(page.getByText('not covered:')).toBeVisible();
    await expect(page.getByText('R002', { exact: false })).toBeVisible();
  });

  test('full coverage (N = M) shows no uncovered-reports callout', async ({ page }) => {
    await page.evaluate(async () => {
      const app = Alpine.store('app');
      app.extractionData = [
        { record_id: 'R001', finding_name: 'acute infarct', source_text: 'No acute infarct.', presence: 'present' },
        { record_id: 'R002', finding_name: 'mass effect', source_text: 'No midline shift.', presence: 'absent' },
      ];
      app.extractionFields = ['record_id', 'finding_name', 'source_text', 'presence'];
      app.extractionColumnMap = { record_id: 'record_id', finding_name: 'finding_name', source_text: 'source_text', presence: 'presence' };
      app.recordIds = ['R001', 'R002'];
      app.currentView = 'import-extractions';
      await app.runExtractionValidation();
    });

    await expect(page.getByText('Findings cover 2 of 2 loaded reports')).toBeVisible();
    await expect(page.getByText('not covered:')).toBeHidden();
  });

  test('a report that only produced a rejected row still counts as covered (an attempt, not a skip)', async ({ page }) => {
    await page.evaluate(async () => {
      const app = Alpine.store('app');
      app.extractionData = [
        { record_id: 'R001', finding_name: 'acute infarct', source_text: 'No acute infarct.', presence: 'present' },
        // R002 gets an attempt, but a bad one (hallucinated source_text) — it
        // still "attempted" R002, so R002 counts as covered, not skipped.
        { record_id: 'R002', finding_name: 'mass effect', source_text: 'This text is not in the report.', presence: 'present' },
      ];
      app.extractionFields = ['record_id', 'finding_name', 'source_text', 'presence'];
      app.extractionColumnMap = { record_id: 'record_id', finding_name: 'finding_name', source_text: 'source_text', presence: 'presence' };
      app.recordIds = ['R001', 'R002'];
      app.currentView = 'import-extractions';
      await app.runExtractionValidation();
    });

    await expect(page.getByText('Findings cover 2 of 2 loaded reports')).toBeVisible();
  });
});
