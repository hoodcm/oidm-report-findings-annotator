// Pins the D4 closest-sentence-suggestion click-through contract
// (extraction-prompt-redesign plan, step 6): a row whose source_text is a
// paraphrase (not a verbatim quote) gets a "Use this sentence" button in the
// validation panel; clicking it fixes the row, moves it from invalid to
// ready, and the imported finding carries the _needsReview flag so the
// annotator double-checks the auto-matched sentence.

const { test, expect } = require('@playwright/test');
const { gotoApp, resetIndexedDb, seedTaxonomy, seedReports } = require('./helpers');

test.describe('Extraction import — closest-sentence suggestion click-through (D4)', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await resetIndexedDb(page);
    await seedTaxonomy(page);
    await seedReports(page, ['R001']);
    await page.waitForFunction(() => Alpine.store('app').currentView === 'annotate');
  });

  test('clicking "Use this sentence" fixes the row, and the imported finding is flagged for review', async ({ page }) => {
    // R001 sentence 1 is "No acute infarct." — this paraphrase doesn't match
    // verbatim but clears the fuzzy-match floor/margin uniquely against it.
    await page.evaluate(async () => {
      const app = Alpine.store('app');
      app.extractionData = [{
        record_id: 'R001', finding_name: 'acute infarct',
        source_text: 'No evidence of acute infarct.', presence: 'present',
      }];
      app.extractionFields = ['record_id', 'finding_name', 'source_text', 'presence'];
      app.extractionColumnMap = {
        record_id: 'record_id', finding_name: 'finding_name',
        source_text: 'source_text', presence: 'presence',
      };
      app.recordIds = ['R001'];
      app.currentView = 'import-extractions';
      await app.runExtractionValidation();
    });

    // The suggestion block is visible with the closest-sentence text.
    await expect(page.getByText('1 row(s) have a close match')).toBeVisible();
    await expect(page.getByText('No acute infarct.', { exact: false })).toBeVisible();

    // Before the fix: not ready to import.
    expect(await page.evaluate(() => Alpine.store('app').extractionValidationSummary.counts.ready)).toBe(0);

    await page.getByRole('button', { name: 'Use this sentence' }).click();

    // After the fix: the row moved from invalid to valid/ready.
    const afterFix = await page.evaluate(() => {
      const s = Alpine.store('app').extractionValidationSummary;
      return { ready: s.counts.ready, invalidLen: s.invalid.length, needsReview: s.valid[0]?._needsReview };
    });
    expect(afterFix.ready).toBe(1);
    expect(afterFix.invalidLen).toBe(0);
    expect(afterFix.needsReview).toBe(true);

    // Drive the rest of the wizard for real: Review Matches -> Import.
    await page.getByRole('button', { name: 'Review Matches' }).click();
    await page.getByRole('button', { name: /Import \d+ Finding/ }).click();
    // confirmExtractionImport is async (Storage writes + _loadSession); the
    // click resolves as soon as the event fires, not when the handler
    // finishes — wait for its own completion flag before reading storage.
    await page.waitForFunction(() => Alpine.store('app').extractionsImported === true);

    const report = await page.evaluate(async () => await Storage.loadReport('R001'));
    const pending = report.findings.filter(f => f.status === 'pending');
    expect(pending.length).toBe(1);
    expect(pending[0].finding_name).toBe('acute infarct');
    expect(pending[0].source_sentence_idx).toBe(1);
    expect(pending[0]._needsReview).toBe(true);

    // The finding card renders the "needs review" badge.
    await page.waitForFunction(() => Alpine.store('app').pendingFindings.length === 1);
    await expect(page.getByText('needs review', { exact: false }).first()).toBeVisible();
  });
});
