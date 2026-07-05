// Export hardening (A4): on an empty store, the all-reports exports toast an
// explicit error instead of silently downloading nothing (the unreproduced
// Chrome "export did nothing" report). The 60s object-URL revoke is verified by
// code review — there's no automated harness for download-stream timing.

const { test, expect } = require('@playwright/test');
const { gotoApp, resetIndexedDb, seedTaxonomy, seedReports, captureDownload, expectToast } = require('./helpers');

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

  // Regression (L2): a record_id containing path/OS-hostile characters must
  // be sanitized in the download filename (a raw "/" breaks the save path).
  test('per-report exports sanitize hostile characters out of the filename', async ({ page }) => {
    await seedReports(page, ['R001']);
    await page.evaluate(() => { Alpine.store('app').report.record_id = 'a/b\\c:d e'; });

    const json = await captureDownload(page, () =>
      page.evaluate(() => Alpine.store('app').exportCurrentReportJson()));
    expect(json.filename).toBe('a_b_c_d_e.json');

    const csv = await captureDownload(page, () =>
      page.evaluate(() => {
        const app = Alpine.store('app');
        app.report.findings = [{ status: 'pending', finding_name: 'f1', source_sentence_idx: 1, attributes: { presence: 'present' } }];
        return app.exportCurrentReportCsv();
      }));
    expect(csv.filename).toBe('a_b_c_d_e-findings.csv');
  });

  // Contract: exportCurrentReportCsv with zero findings informs instead of
  // downloading an empty CSV.
  test('exportCurrentReportCsv with no findings toasts and does not download', async ({ page }) => {
    await seedReports(page, ['R001']);
    const noDownload = page.waitForEvent('download', { timeout: 1200 }).then(() => 'downloaded').catch(() => 'none');
    await page.evaluate(() => Alpine.store('app').exportCurrentReportCsv());
    await expectToast(page, 'No findings to export');
    expect(await noDownload).toBe('none');
  });
});
