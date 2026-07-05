// Pins the save-error contract: when Storage.saveReport rejects (quota
// exceeded, Dexie/IDB failure, two-tab schema mismatch), the user gets an
// actionable error toast pointing at the session-export recovery path
// rather than a silent unhandled rejection.

const { test, expect } = require('@playwright/test');
const { gotoApp, resetIndexedDb, seedTaxonomy, seedReports } = require('./helpers');

test.describe('_saveCurrentReport surfaces storage failures', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await resetIndexedDb(page);
    await seedTaxonomy(page);
    await seedReports(page);
  });

  test('rejected report save produces an error toast', async ({ page }) => {
    // _saveCurrentReport writes via savePlainReport (the no-re-clone hot path);
    // inject the failure there.
    await page.evaluate(() => {
      window.__originalSaveReport = Storage.savePlainReport;
      Storage.savePlainReport = () => {
        const err = new Error('simulated');
        err.name = 'QuotaExceededError';
        return Promise.reject(err);
      };
    });

    await page.evaluate(async () => {
      await Alpine.store('app')._saveCurrentReport();
    });

    const state = await page.evaluate(() => ({
      toast: Alpine.store('app').toastMessage,
      toastType: Alpine.store('app').toastType,
      saveFailed: Alpine.store('app')._saveFailed,
    }));
    expect(state.toastType).toBe('error');
    expect(state.toast).toMatch(/could not save changes/i);
    expect(state.toast).toMatch(/quotaexceedederror/i);
    expect(state.toast).toMatch(/export your session/i);
    // A real save failure arms the beforeunload guard.
    expect(state.saveFailed).toBe(true);

    // Restore, then a successful save clears the flag (closing is safe again).
    await page.evaluate(async () => {
      Storage.savePlainReport = window.__originalSaveReport;
      await Alpine.store('app')._saveCurrentReport();
    });
    expect(await page.evaluate(() => Alpine.store('app')._saveFailed)).toBe(false);
  });
});
