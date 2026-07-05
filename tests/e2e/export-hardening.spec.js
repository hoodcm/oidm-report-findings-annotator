// Export hardening (A4): on an empty store, the all-reports exports toast an
// explicit error instead of silently downloading nothing (the unreproduced
// Chrome "export did nothing" report). The 60s object-URL revoke is verified by
// code review — there's no automated harness for download-stream timing.

const { test, expect } = require('@playwright/test');
const { gotoApp, resetIndexedDb, seedTaxonomy, expectToast } = require('./helpers');

test.describe('Export hardening: empty-store guards', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await resetIndexedDb(page);       // 0 reports
    await seedTaxonomy(page);
  });

  for (const fn of ['exportAllJson', 'exportTrainingData']) {
    test(`${fn} on an empty store toasts an error and does not download`, async ({ page }) => {
      const noDownload = page.waitForEvent('download', { timeout: 1200 }).then(() => 'downloaded').catch(() => 'none');
      await page.evaluate((m) => Alpine.store('app')[m](), fn);
      await expectToast(page, '0 reports found in storage');
      expect(await noDownload).toBe('none');
      expect(await page.evaluate(() => Alpine.store('app').toastType)).toBe('error');
    });
  }
});
