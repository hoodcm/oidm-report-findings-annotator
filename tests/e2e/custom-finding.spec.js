// Custom-finding dead end (B1): at zero search results the dropdown must still
// render and offer a one-click, pre-filled "Add '<query>' as a custom finding".
// Contract: search-dropdown behavior at 0 results.

const { test, expect } = require('@playwright/test');
const { gotoApp, resetIndexedDb, seedTaxonomy, seedReports } = require('./helpers');

test.describe('Custom finding at zero search results', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await resetIndexedDb(page);
    await seedTaxonomy(page);
    await seedReports(page, ['R001']); // annotate view, sentence 1 auto-selected
  });

  test('off-taxonomy query shows the custom option; clicking adds it as custom', async ({ page }) => {
    await page.locator('#finding-search-input').fill('zzznotarealfinding');

    // Dropdown renders even with zero matches; "No matches" + custom button visible.
    await expect(page.getByText('No matches in the taxonomy.')).toBeVisible();
    const customBtn = page.locator('[data-custom-finding]');
    await expect(customBtn).toBeVisible();

    await customBtn.click();

    const added = await page.evaluate(() =>
      (Alpine.store('app').allValidatedFindings || []).map(f => ({ name: f.finding_name, custom: !!f.is_custom }))
    );
    expect(added).toContainEqual({ name: 'zzznotarealfinding', custom: true });
  });
});
