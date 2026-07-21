/**
 * Universal drop zone — routing, dependency ordering, queueing, error chips.
 *
 * Contract under test (plan D1/S3): one drop target accepts every file type
 * the app understands; files route by content signature in dependency order
 * (taxonomy → reports → extractions) regardless of drop order; extractions
 * dropped before reports queue visibly and auto-import when reports arrive;
 * unrecognized files get an error chip naming what failed.
 */

const { test, expect } = require('@playwright/test');
const path = require('path');
const { gotoApp, resetIndexedDb, expectToast, FIXTURES_DIR } = require('./helpers');

const TAXONOMY = path.join(FIXTURES_DIR, 'ct-head-taxonomy.csv');
const REPORTS = path.join(FIXTURES_DIR, 'drop-reports.csv');
const EXTRACTIONS = path.join(FIXTURES_DIR, 'drop-extractions.csv');
const GARBAGE = path.join(FIXTURES_DIR, 'garbage.txt');
const EMPTY_TAXONOMY = path.join(FIXTURES_DIR, 'empty-taxonomy.csv');

const DROP_INPUT = '#universal-drop input[type="file"]';

test.describe('Universal drop zone', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await resetIndexedDb(page);
    await page.reload();
    await gotoApp(page);
  });

  test('reverse-order multi-drop routes all three in dependency order; extraction panel opens last', async ({ page }) => {
    // Deliberately reversed: extractions first, taxonomy last.
    await page.setInputFiles(DROP_INPUT, [EXTRACTIONS, REPORTS, TAXONOMY]);

    // Taxonomy landed (routed first despite being dropped last).
    await page.waitForFunction(() => Alpine.store('app').taxonomy.length > 0);

    // Reports routed to the existing mapping view; extraction is queued
    // (reports aren't committed until the mapping is confirmed).
    await page.waitForFunction(() => Alpine.store('app').currentView === 'upload-mapping');
    const queued = await page.evaluate(() =>
      Alpine.store('app').dropResults.filter(r => r.status === 'queued').length);
    expect(queued).toBe(1);

    // Confirm the (auto-detected) mapping.
    await page.click('button:has-text("Import Reports")');

    // Reports committed → queued extraction auto-runs → import panel opens last.
    await page.waitForFunction(() => Alpine.store('app').currentView === 'import-extractions');
    const state = await page.evaluate(() => ({
      total: Alpine.store('app').totalCount,
      rows: (Alpine.store('app').extractionData || []).length,
      queuedLeft: Alpine.store('app').queuedExtractions.length,
    }));
    expect(state.total).toBe(2);
    expect(state.rows).toBe(2);
    expect(state.queuedLeft).toBe(0);
  });

  test('extractions dropped alone queue with a visible waiting chip', async ({ page }) => {
    await page.setInputFiles(DROP_INPUT, [EXTRACTIONS]);

    const chip = page.locator('[data-drop-chip][data-chip-status="queued"]');
    await expect(chip).toBeVisible();
    await expect(chip).toContainText('waiting for reports');
    // Still on the welcome screen — nothing errored, nothing imported.
    const view = await page.evaluate(() => Alpine.store('app').currentView);
    expect(view).toBe('welcome');
  });

  test('an unrecognized file gets an error chip naming the failed signature', async ({ page }) => {
    await page.setInputFiles(DROP_INPUT, [GARBAGE]);

    const chip = page.locator('[data-drop-chip][data-chip-status="error"]');
    await expect(chip).toBeVisible();
    await expect(chip).toContainText('garbage.txt');
    // The rationale names, in plain language, the file kinds it looked for.
    await expect(chip).toContainText(/doesn't match a findings list|isn't a data bundle/);
  });

  test('routed files show a plain-language rationale chip', async ({ page }) => {
    await page.setInputFiles(DROP_INPUT, [TAXONOMY]);
    await page.waitForFunction(() => Alpine.store('app').taxonomy.length > 0);

    const chip = page.locator('[data-drop-chip][data-chip-status="routed"]');
    await expect(chip).toBeVisible();
    await expect(chip).toContainText('recognized as a taxonomy');
  });

  test('a recognized file that fails during import flips its chip to error', async ({ page }) => {
    await page.setInputFiles(DROP_INPUT, [EMPTY_TAXONOMY]);

    const chip = page.locator('[data-drop-chip]').filter({ hasText: 'taxonomy import failed' });
    await expect(chip).toBeVisible();
    await expect(chip).toContainText('taxonomy import failed');
  });
});
