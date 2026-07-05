// Pins the D4 fix-it prompt content contract (extraction-prompt-redesign
// plan, step 8): packages rejected rows into a self-contained message a
// fresh LLM chat (no memory of the original extraction prompt) can act on.

const { test, expect } = require('@playwright/test');
const { gotoApp, resetIndexedDb, seedTaxonomy, seedReports } = require('./helpers');

test.describe('Extraction import — fix-it prompt (D4)', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await resetIndexedDb(page);
    await seedTaxonomy(page);
    await seedReports(page, ['R001', 'R002']);
    await page.waitForFunction(() => Alpine.store('app').currentView === 'annotate');
  });

  test('hidden when there are no rejected rows', async ({ page }) => {
    await page.evaluate(async () => {
      const app = Alpine.store('app');
      app.extractionData = [{ record_id: 'R001', finding_name: 'acute infarct', source_text: 'No acute infarct.', presence: 'present' }];
      app.extractionFields = ['record_id', 'finding_name', 'source_text', 'presence'];
      app.extractionColumnMap = { record_id: 'record_id', finding_name: 'finding_name', source_text: 'source_text', presence: 'presence' };
      app.recordIds = ['R001', 'R002'];
      app.currentView = 'import-extractions';
      await app.runExtractionValidation();
    });
    await expect(page.getByRole('button', { name: 'Copy fix-it prompt for the rejected rows' })).toBeHidden();
  });

  test('content contract: finding_name + error, required-fields line, enum values, and each affected report\'s FINDINGS text', async ({ page }) => {
    await page.evaluate(async () => {
      const app = Alpine.store('app');
      app.extractionData = [
        // Rejected: bad laterality enum value, in R001.
        { record_id: 'R001', finding_name: 'acute infarct', source_text: 'No acute infarct.', presence: 'present', laterality: 'sideways' },
        // Rejected: hallucinated source_text, in R002.
        { record_id: 'R002', finding_name: 'mass effect', source_text: 'This sentence does not exist anywhere.', presence: 'present' },
      ];
      app.extractionFields = ['record_id', 'finding_name', 'source_text', 'presence', 'laterality'];
      app.extractionColumnMap = {
        record_id: 'record_id', finding_name: 'finding_name', source_text: 'source_text',
        presence: 'presence', laterality: 'laterality',
      };
      app.recordIds = ['R001', 'R002'];
      app.currentView = 'import-extractions';
      await app.runExtractionValidation();
    });

    const summary = await page.evaluate(() => Alpine.store('app').extractionValidationSummary.counts);
    expect(summary.badEnum).toBe(1);
    expect(summary.notInReport).toBe(1);

    await expect(page.getByRole('button', { name: 'Copy fix-it prompt for the rejected rows' })).toBeVisible();

    const promptText = await page.evaluate(() => Alpine.store('app').buildFixItPromptText());

    // Required-fields restatement.
    expect(promptText).toContain('REQUIRED fields on every finding object: record_id, finding_name, presence');
    expect(promptText).toContain('source_text (a verbatim sentence from the FINDINGS text below)');

    // Each rejected row's finding_name + its error.
    expect(promptText).toContain('record_id=R001 finding_name=acute infarct');
    expect(promptText).toContain('laterality value "sideways" not recognized');
    expect(promptText).toContain('record_id=R002 finding_name=mass effect');
    expect(promptText).toContain('source_text not found in R002');

    // The relevant enum vocabulary (laterality, since that's what errored).
    expect(promptText).toMatch(/laterality:.*"left".*"right".*"bilateral"/);

    // FINDINGS text of BOTH affected reports, for verbatim quoting.
    expect(promptText).toContain('--- R001 ---');
    expect(promptText).toContain('No acute infarct.');
    expect(promptText).toContain('--- R002 ---');
    expect(promptText).toContain('Small acute subdural hemorrhage along the left convexity.');

    // The button actually copies this same text to the clipboard. Clipboard
    // access requires the page to be the focused tab — bringToFront() guards
    // against a full-suite run leaving focus on a different page/tab.
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.bringToFront();
    await page.getByRole('button', { name: 'Copy fix-it prompt for the rejected rows' }).click();
    await expect(async () => {
      const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
      expect(clipboardText).toBe(promptText);
    }).toPass({ timeout: 5000 });
  });
});
