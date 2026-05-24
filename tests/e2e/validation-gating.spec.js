// Pins the v1.3.0 toggleValidation gate: a report cannot be marked validated
// while any of its validated_findings lacks a `presence` value. Before this
// change, partial-state findings shipped silently into the validated set.

const { test, expect } = require('@playwright/test');
const { gotoApp, resetIndexedDb, seedTaxonomy, seedReports } = require('./helpers');

test.describe('toggleValidation enforces presence on every finding', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await resetIndexedDb(page);
    await seedTaxonomy(page);
    await seedReports(page, ['R001']);
    await page.waitForFunction(() => Alpine.store('app').currentView === 'annotate');
  });

  test('blocks validation when a validated finding has no presence value', async ({ page }) => {
    // Inject a validated finding directly with missing presence. We bypass
    // the UI add flow because acceptFinding/addFinding both seed presence
    // by default — this test pins the gate, not the seeding path.
    await page.evaluate(async () => {
      const app = Alpine.store('app');
      app.report.validated_findings.push({
        finding_name: 'acute infarct',
        source_sentence_idx: 1,
        source_text: 'No acute infarct.',
        attributes: {}, // intentionally no presence
      });
      await app._saveCurrentReport();
    });

    await page.evaluate(() => Alpine.store('app').toggleValidation());

    // Report must not be validated; toast must surface a presence error.
    expect(await page.evaluate(() => Alpine.store('app').report.validated)).toBe(false);
    const toast = await page.evaluate(() => ({
      msg: Alpine.store('app').toastMessage,
      type: Alpine.store('app').toastType,
    }));
    expect(toast.type).toBe('error');
    expect(toast.msg).toMatch(/presence/i);
  });

  test('allows validation when every finding has a presence value', async ({ page }) => {
    await page.evaluate(async () => {
      const app = Alpine.store('app');
      app.report.validated_findings.push({
        finding_name: 'acute infarct',
        source_sentence_idx: 1,
        source_text: 'No acute infarct.',
        attributes: { presence: 'absent' },
      });
      await app._saveCurrentReport();
    });

    await page.evaluate(() => Alpine.store('app').toggleValidation());
    expect(await page.evaluate(() => Alpine.store('app').report.validated)).toBe(true);
  });
});
