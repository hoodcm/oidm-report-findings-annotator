// Annotation Guidelines overlay (D6). Presence section teaches the spectrum
// via the ti-circle-check / ti-circle-dashed-check / ti-circle-dashed /
// ti-circle-dotted Tabler icons (a rough visual approximation of certainty,
// not a literal probability) instead of the retired moon glyphs, plus the
// phrase table and the aggregate (multiple-instance) plain-language note.

const { test, expect } = require('@playwright/test');
const { gotoApp, resetIndexedDb, seedTaxonomy, seedReports } = require('./helpers');

test.describe('Annotation Guidelines overlay', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await resetIndexedDb(page);
    await seedTaxonomy(page);
    await seedReports(page, ['R001']);
    await page.locator('.drawer-summary', { hasText: 'Help' }).click();
    await page.locator('button', { hasText: 'annotation guidelines' }).click();
    await expect(page.locator('#guidelines-overlay')).toBeVisible();
  });

  test('presence section shows all four spectrum icons and no legacy indeterminate copy', async ({ page }) => {
    const overlay = page.locator('#guidelines-overlay');
    const presenceIcons = overlay.locator('li i.ti');
    await expect(presenceIcons).toHaveCount(4);
    for (let i = 0; i < 4; i++) {
      await expect(presenceIcons.nth(i)).toBeVisible();
    }
    await expect(overlay).not.toContainText('indeterminate');
  });

  test('presence phrase table names the four labels', async ({ page }) => {
    const overlay = page.locator('#guidelines-overlay');
    await expect(overlay).toContainText('Present');
    await expect(overlay).toContainText('Possible');
    await expect(overlay).toContainText('No definite');
    await expect(overlay).toContainText('Absent');
  });

  test('multiple-instances section teaches the aggregate attribute in plain language', async ({ page }) => {
    const overlay = page.locator('#guidelines-overlay');
    await expect(overlay).toContainText('Multiple instances of the same finding');
    await expect(overlay).toContainText('aggregate');
    await expect(overlay).toContainText('bilateral');
  });
});
