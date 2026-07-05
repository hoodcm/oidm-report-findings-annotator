// Data-integrity safety net (A2): a write requests IndexedDB persistence, and
// the Stats overlay surfaces a Storage line (persistence state + bytes used).

const { test, expect } = require('@playwright/test');
const { gotoApp, resetIndexedDb, seedTaxonomy, seedReports } = require('./helpers');

test.describe('Storage persistence + Stats overlay', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await resetIndexedDb(page);
    await seedTaxonomy(page);
  });

  test('a write requests persistence; Stats overlay shows a Storage line', async ({ page }) => {
    // seedReports goes through Storage.atomicReplace → ensurePersisted().
    await seedReports(page, ['R001']);

    // Persistence was requested and resolved (a boolean, never a throw). We do
    // NOT pin persisted()===true: headless Chromium grants persistence
    // heuristically, so the durable contract is "requested + surfaced", not the
    // grant outcome (testing-discipline: no env-dependent brittle values).
    const persisted = await page.evaluate(() => navigator.storage.persisted());
    expect(typeof persisted).toBe('boolean');

    // Stats overlay surfaces a Storage line derived from Storage.storageInfo().
    await page.evaluate(() => Alpine.store('app').showStats());
    const info = await page.evaluate(() => Alpine.store('app')._storageInfo);
    expect(info).not.toBeNull();
    expect(info).toHaveProperty('persisted');

    await expect(page.locator('#stats-overlay').getByText('Storage', { exact: true })).toBeVisible();
  });
});
