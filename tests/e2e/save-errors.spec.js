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

  test('rejected Storage.saveReport produces an error toast', async ({ page }) => {
    await page.evaluate(() => {
      window.__originalSaveReport = Storage.saveReport;
      Storage.saveReport = () => {
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
      hasUnsavedChanges: Alpine.store('app').hasUnsavedChanges,
    }));
    expect(state.toastType).toBe('error');
    expect(state.toast).toMatch(/could not save changes/i);
    expect(state.toast).toMatch(/quotaexceedederror/i);
    expect(state.toast).toMatch(/export your session/i);

    // Restore so the afterEach IndexedDB reset doesn't accidentally exercise the stub.
    await page.evaluate(() => { Storage.saveReport = window.__originalSaveReport; });
  });
});
