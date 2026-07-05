/**
 * Welcome stepper — state chips walk 1 → 2 → 3 as setup progresses.
 *
 * Contract under test (plan D1/S4): the welcome screen is a checklist
 * (taxonomy → reports → extractions-optional → start annotating) with a
 * state chip per step. Step 2 reads "waiting" until a taxonomy is loaded —
 * a visual gate only; the universal drop zone routes files correctly
 * regardless of order (covered by drop-zone.spec.js).
 */

const { test, expect } = require('@playwright/test');
const path = require('path');
const { gotoApp, resetIndexedDb, FIXTURES_DIR } = require('./helpers');

const TAXONOMY = path.join(FIXTURES_DIR, 'ct-head-taxonomy.csv');
const REPORTS = path.join(FIXTURES_DIR, 'drop-reports.csv');

const stepState = (page, step) =>
  page.locator(`[data-step="${step}"]`).getAttribute('data-step-state');

test.describe('Welcome stepper', () => {
  test('fresh profile walks 1 → 2 → 3 with state chips', async ({ page }) => {
    await gotoApp(page);
    await resetIndexedDb(page);
    await page.reload();
    await gotoApp(page);

    // Fresh profile: step 1 is current; steps 2 and 3 wait.
    expect(await stepState(page, 'taxonomy')).toBe('current');
    expect(await stepState(page, 'reports')).toBe('waiting');
    expect(await stepState(page, 'extractions')).toBe('waiting');
    // Step 2's hint names the gate; Start annotating is disabled.
    await expect(page.locator('[data-step="reports"]')).toContainText('Load a taxonomy first');
    await expect(page.locator('[data-start-annotating]')).toBeDisabled();

    // Load the taxonomy via step 1's browse input.
    await page.setInputFiles('[data-step="taxonomy"] input[type="file"]', TAXONOMY);
    await page.waitForFunction(() => Alpine.store('app').taxonomy.length > 0);
    expect(await stepState(page, 'taxonomy')).toBe('done');
    expect(await stepState(page, 'reports')).toBe('current');

    // Load reports via step 2's browse input → mapping view → import.
    await page.setInputFiles('[data-step="reports"] input[type="file"]', REPORTS);
    await page.waitForFunction(() => Alpine.store('app').currentView === 'upload-mapping');
    await page.click('button:has-text("Import Reports")');
    await page.waitForFunction(() => Alpine.store('app').currentView === 'annotate');

    // Back on the welcome screen, steps 1–2 are done, 3 is optional, start enabled.
    await page.click('[title="Back to welcome screen"]');
    await page.waitForFunction(() => Alpine.store('app').currentView === 'welcome');
    expect(await stepState(page, 'taxonomy')).toBe('done');
    expect(await stepState(page, 'reports')).toBe('done');
    expect(await stepState(page, 'extractions')).toBe('optional');
    await expect(page.locator('[data-start-annotating]')).toBeEnabled();

    // Start annotating returns to the workspace.
    await page.click('[data-start-annotating]');
    await page.waitForFunction(() => Alpine.store('app').currentView === 'annotate');
  });
});
