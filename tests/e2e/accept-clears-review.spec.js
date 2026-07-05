// acceptFinding clears both review markers (B4): accepting a finding onto a
// sentence is a full review gesture — it confirms the sentence anchor AND the
// cue-guessed polarity — so the validated finding carries neither _needsReview
// nor _polarityReview.

const { test, expect } = require('@playwright/test');
const { gotoApp, resetIndexedDb, seedTaxonomy, seedReports } = require('./helpers');

test.describe('acceptFinding clears review markers', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await resetIndexedDb(page);
    await seedTaxonomy(page);
    await seedReports(page, ['R001']);
    await page.waitForFunction(() => Alpine.store('app').currentView === 'annotate');
  });

  test('accepting clears _needsReview and _polarityReview on the validated finding', async ({ page }) => {
    await page.evaluate(async () => {
      const app = Alpine.store('app');
      app.report.findings.push(
        { finding_name: 'acute infarct', status: 'pending', source_sentence_idx: 1, source_text: 'No acute infarct.',
          _needsReview: true, attributes: { presence: 'absent' } },
        { finding_name: 'mass effect', status: 'pending', source_sentence_idx: 1, source_text: 'No mass effect.',
          _polarityReview: true, attributes: { presence: 'absent' } },
      );
      await app._saveCurrentReport();
      app.selectSentence(1);
      // accept flips status in place (no splice), so indices stay stable.
      await app.acceptFinding(0);  // acute infarct (_needsReview)
      await app.acceptFinding(1);  // mass effect (_polarityReview)
    });

    const vfs = await page.evaluate(() =>
      Alpine.store('app').allValidatedFindings.map(f =>
        ({ name: f.finding_name, needsReview: f._needsReview, polarityReview: f._polarityReview })));

    const infarct = vfs.find(f => f.name === 'acute infarct');
    expect(infarct.needsReview).toBe(false);
    expect(infarct.polarityReview).toBeFalsy();

    const mass = vfs.find(f => f.name === 'mass effect');
    expect(mass.needsReview).toBe(false);
    expect(mass.polarityReview).toBeFalsy();
  });
});
