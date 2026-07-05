// NaN jump guard (B2): an empty jump input (parseInt('') = NaN) must leave the
// current report loaded instead of loading recordIds[NaN] = undefined; Prev/Next
// keep working afterward.

const { test, expect } = require('@playwright/test');
const { gotoApp, resetIndexedDb, seedTaxonomy, seedReports } = require('./helpers');

test.describe('Navigation NaN guard', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await resetIndexedDb(page);
    await seedTaxonomy(page);
    await seedReports(page, ['R001', 'R002', 'R003']);
  });

  test('empty jump leaves the current report loaded; Prev/Next still work', async ({ page }) => {
    await page.evaluate(() => Alpine.store('app').navigateTo(1)); // report 2
    const before = await page.evaluate(() => ({
      idx: Alpine.store('app').currentIdx, rid: Alpine.store('app').report.record_id,
    }));
    expect(before.idx).toBe(1);

    // Empty jump input → jumpToReport(NaN). Must be a no-op.
    await page.evaluate(() => Alpine.store('app').jumpToReport(parseInt('', 10)));
    const after = await page.evaluate(() => ({
      idx: Alpine.store('app').currentIdx, rid: Alpine.store('app').report?.record_id,
    }));
    expect(after.idx).toBe(1);
    expect(after.rid).toBe(before.rid);

    // Prev/Next still work.
    await page.evaluate(() => Alpine.store('app').navigateNext());
    expect(await page.evaluate(() => Alpine.store('app').currentIdx)).toBe(2);
    await page.evaluate(() => Alpine.store('app').navigatePrev());
    expect(await page.evaluate(() => Alpine.store('app').currentIdx)).toBe(1);
  });
});
