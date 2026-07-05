/**
 * Snapshot undo stack (plan D5/S9): every mutation in the annotate view is
 * Ctrl-Z-able. Ctrl+Z restores the prior snapshot, Ctrl+Shift+Z re-applies
 * it (single-level redo), and a new mutation invalidates the redo.
 */

const { test, expect } = require('@playwright/test');
const { gotoApp, resetIndexedDb, seedTaxonomy, seedReports } = require('./helpers');

async function seedValidatedFinding(page) {
  await page.evaluate(async () => {
    const app = Alpine.store('app');
    app.report.findings.push({
      finding_name: 'acute infarct', status: 'validated', source_sentence_idx: 1,
      source_text: 'No acute infarct.', attributes: { presence: 'absent', severity: 'mild' },
      origin: 'human_added',
    });
    await app._saveCurrentReport();
    app.selectSentence(1);
  });
}

test.describe('Snapshot undo / redo', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await resetIndexedDb(page);
    await seedTaxonomy(page);
    await seedReports(page, ['R001']);
    await seedValidatedFinding(page);
  });

  test('cycle an attribute → Ctrl+Z restores → Ctrl+Shift+Z re-applies', async ({ page }) => {
    const severity = () => page.evaluate(async () =>
      (await Storage.loadReport('R001')).findings[0].attributes.severity);

    // Cycle severity (mild → mild_to_moderate) via the store mutator.
    await page.evaluate(() => Alpine.store('app').cycleAttribute(0, 'severity'));
    expect(await severity()).toBe('mild_to_moderate');

    await page.keyboard.press('Control+z');
    await page.waitForFunction(() =>
      Alpine.store('app').report.findings[0].attributes.severity === 'mild');
    expect(await severity()).toBe('mild');       // persisted, not just in-memory

    await page.keyboard.press('Control+Shift+z');
    await page.waitForFunction(() =>
      Alpine.store('app').report.findings[0].attributes.severity === 'mild_to_moderate');
    expect(await severity()).toBe('mild_to_moderate');
  });

  test('delete a finding → Ctrl+Z brings it back', async ({ page }) => {
    await page.evaluate(() => Alpine.store('app').deleteFinding(0));
    expect(await page.evaluate(() => Alpine.store('app').report.findings.length)).toBe(0);

    await page.keyboard.press('Control+z');
    await page.waitForFunction(() => Alpine.store('app').report.findings.length === 1);
    const f = await page.evaluate(async () => (await Storage.loadReport('R001')).findings[0]);
    expect(f.finding_name).toBe('acute infarct');
  });

  test('a new mutation invalidates the single-level redo', async ({ page }) => {
    await page.evaluate(() => Alpine.store('app').cycleAttribute(0, 'severity')); // mild→mild_to_moderate
    await page.keyboard.press('Control+z');                                       // back to mild
    await page.waitForFunction(() =>
      Alpine.store('app').report.findings[0].attributes.severity === 'mild');
    // New mutation while a redo is pending.
    await page.evaluate(() => Alpine.store('app').updateAttribute(0, 'severity', 'severe'));
    await page.keyboard.press('Control+Shift+z');                                 // redo must be gone
    await page.waitForFunction(() =>
      Alpine.store('app').toastMessage === 'Nothing to redo');
    expect(await page.evaluate(() =>
      Alpine.store('app').report.findings[0].attributes.severity)).toBe('severe');
  });
});
