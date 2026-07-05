// Copy fixes (B7): the shortcuts overlay spells out j = previous / k = next, and
// the sidebar "annotation guidelines" button no longer shows a misleading `?`
// chip (`?` opens the shortcuts overlay, not the guidelines). The
// floating-workspace redesign moved both buttons into the Help drawer and
// replaced the old text-based `?` chip with distinct Tabler icons
// (ti-book / ti-keyboard) on both rows — the guard below now asserts no
// stray "?" text reappears on either button, the same failure class the
// original fix targeted.

const { test, expect } = require('@playwright/test');
const { gotoApp, resetIndexedDb, seedTaxonomy, seedReports } = require('./helpers');

test.describe('Shortcuts + guidelines copy', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await resetIndexedDb(page);
    await seedTaxonomy(page);
    await seedReports(page, ['R001']); // annotate view (sidebar buttons present)
  });

  test('shortcuts overlay shows j = previous / k = next', async ({ page }) => {
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('open-shortcuts')));
    const sentRow = page.locator('#shortcuts-overlay div.flex.justify-between')
      .filter({ hasText: 'Navigate sentences' });
    await expect(sentRow).toContainText('previous');
    await expect(sentRow).toContainText('next');
  });

  test('the "annotation guidelines" button carries no ? chip', async ({ page }) => {
    await page.locator('.drawer-summary', { hasText: 'Help' }).click();
    const guidelinesBtn = page.locator('button', { hasText: 'annotation guidelines' });
    await expect(guidelinesBtn).toBeVisible();
    await expect(guidelinesBtn.locator('kbd')).toHaveCount(0);
    await expect(guidelinesBtn.locator('i.ti-book')).toHaveCount(1);
    // The keyboard-shortcuts button carries its own distinct icon, not a "?" chip.
    const shortcutsBtn = page.locator('button', { hasText: 'keyboard shortcuts' });
    await expect(shortcutsBtn.locator('kbd')).toHaveCount(0);
    await expect(shortcutsBtn.locator('i.ti-keyboard')).toHaveCount(1);
  });
});
