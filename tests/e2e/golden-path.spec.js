// Golden-path smoke: full annotation workflow end-to-end. Catches whole-feature
// regressions that don't surface in unit tests (e.g., a script-tag broken in
// index.html, a global never registered, an Alpine init ordering bug).

const { test, expect } = require('@playwright/test');
const path = require('path');
const {
  gotoApp, resetIndexedDb, seedTaxonomy, seedReports, captureDownload,
} = require('./helpers');

test.describe('Golden path: taxonomy → reports → annotate → export', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await resetIndexedDb(page);
  });

  test('user can validate a finding and see it in the all-reports CSV export', async ({ page }) => {
    await seedTaxonomy(page);
    await seedReports(page);

    // Wait for the annotate view to mount (currentView flips after _loadSession).
    await page.waitForFunction(() => Alpine.store('app').currentView === 'annotate', null, { timeout: 5000 });

    // Click the first sentence to select it.
    await page.locator('[data-sentence-idx="1"]').first().click();
    await expect.poll(() => page.evaluate(() => Alpine.store('app').selectedSentenceIdx)).toBe(1);

    // Search for a finding and add it.
    await page.locator('#finding-search-input').fill('infarct');
    await page.waitForFunction(() => Alpine.store('app').searchResults.length > 0);
    await page.keyboard.press('Enter');

    // The validated finding should appear on the current report.
    await expect.poll(async () => {
      return await page.evaluate(() =>
        (Alpine.store('app').report.validated_findings || []).length
      );
    }).toBe(1);

    // Mark report validated.
    await page.evaluate(() => Alpine.store('app').toggleValidation());
    await expect.poll(() => page.evaluate(() => Alpine.store('app').report.validated)).toBe(true);

    // Export and verify the validated finding appears in the CSV.
    const { filename, text } = await captureDownload(page, () =>
      page.evaluate(() => Alpine.store('app').exportTrainingData())
    );
    expect(filename).toMatch(/training-data-\d{4}-\d{2}-\d{2}\.csv/);
    expect(text).toContain('record_id,status,finding_name');
    expect(text).toMatch(/R001,validated,acute infarct/);
  });
});
