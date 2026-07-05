// Sidebar redesign (docs/plans/archive/2026-07-04-sidebar-redesign-plan.md):
// the three footer drawers (Import & add data / Save & export / Help) share
// one Alpine `openDrawer` state so only one is ever open at a time, and the
// "Save & export" subheads carry click-to-open "?" tooltips (not hover, no
// layout shift). Neither behavior existed before this redesign (the old
// footer used a single native <details> with no tooltip), so both get a
// dedicated regression test here.

const { test, expect } = require('@playwright/test');
const { gotoApp, resetIndexedDb, seedTaxonomy, seedReports } = require('./helpers');

test.describe('Sidebar drawers: single-open accordion + click tooltips', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await resetIndexedDb(page);
    await seedTaxonomy(page);
    await seedReports(page, ['R001']);
  });

  test('opening one drawer closes any other open drawer', async ({ page }) => {
    await page.locator('.drawer-summary', { hasText: 'Import & add data' }).click();
    await expect(page.locator('.dropzone-big')).toBeVisible();

    await page.locator('.drawer-summary', { hasText: 'Save & export' }).click();
    await expect(page.locator('.dropzone-big')).toBeHidden();
    await expect(page.locator('.export-grid')).toBeVisible();

    await page.locator('.drawer-summary', { hasText: 'Help' }).click();
    await expect(page.locator('.export-grid')).toBeHidden();
    await expect(page.locator('.drawer-body button:has-text("Annotation guidelines")')).toBeVisible();
  });

  test('clicking the same drawer again closes it', async ({ page }) => {
    const importSummary = page.locator('.drawer-summary', { hasText: 'Import & add data' });
    await importSummary.click();
    await expect(page.locator('.dropzone-big')).toBeVisible();
    await importSummary.click();
    await expect(page.locator('.dropzone-big')).toBeHidden();
  });

  test('"?" tooltip opens on click, toggles closed on a second click, and closes on click-away', async ({ page }) => {
    await page.locator('.drawer-summary', { hasText: 'Save & export' }).click();
    const qbtn = page.locator('.qbtn').first();

    await qbtn.click();
    await expect(page.locator('.help-pop').first()).toBeVisible();

    await qbtn.click();
    await expect(page.locator('.help-pop').first()).toBeHidden();

    await qbtn.click();
    await expect(page.locator('.help-pop').first()).toBeVisible();
    await page.locator('.export-grid').click({ position: { x: 5, y: 5 } });
    await expect(page.locator('.help-pop').first()).toBeHidden();
  });
});
