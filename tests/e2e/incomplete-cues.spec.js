// Pins the incomplete-attribute visual cues (v1.6+): a validated finding with
// an attribute added but left without a value must mark its sentence with the
// wrap-safe `sentence-incomplete` cue (NOT plain done-green) and surface a
// "needs a value" badge on its card. A fully-complete finding shows neither.
// The cue must compose with sentence-selected without knocking either class off.

const { test, expect } = require('@playwright/test');
const { gotoApp, resetIndexedDb, seedTaxonomy } = require('./helpers');

// Seed one report whose sentence 1 carries an INCOMPLETE validated finding
// (extent added, no value) and sentence 2 a fully-complete one, then reload so
// init() renders through the production path.
async function seedIncompleteReport(page) {
  await page.evaluate(async () => {
    const text = 'FINDINGS:\nBrain Parenchyma:\n- Small acute subdural hemorrhage along the left convexity.\n- No acute infarct.';
    const findingsText = Sentences.parseFindingsSection(text);
    const { sentences, sectionBreaks } = Sentences.splitIntoSentences(findingsText);
    await Storage.atomicReplace([{
      record_id: 'R001', report_text: text, sentences, sectionBreaks,
      findings: [
        { finding_name: 'subdural hemorrhage', status: 'validated', source_sentence_idx: 1, source_text: 'Small acute subdural hemorrhage along the left convexity.', origin: 'human_added', attributes: { presence: 'present', extent: '' } },
        { finding_name: 'acute infarct', status: 'validated', source_sentence_idx: 2, source_text: 'No acute infarct.', origin: 'human_added', attributes: { presence: 'absent' } },
      ],
      validated: false, validated_at: null, custom_findings_added: [],
      taxonomyVersion: 'CT Head:0', schema_version: 7,
    }]);
  });
  await page.reload();
  await page.waitForFunction(() => Alpine.store('app').currentView === 'annotate', null, { timeout: 5000 });
}

test.describe('Incomplete-attribute visual cues', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await resetIndexedDb(page);
    await seedTaxonomy(page);
    await seedIncompleteReport(page);
  });

  test('incomplete sentence gets sentence-incomplete (not done-green); complete sentence gets done-green', async ({ page }) => {
    const s1 = page.locator('[data-sentence-idx="1"]');
    const s2 = page.locator('[data-sentence-idx="2"]');

    // Sentence 1 (incomplete): the cue, and NOT plain done-green.
    await expect(s1).toHaveClass(/sentence-incomplete/);
    await expect(s1).not.toHaveClass(/bg-green-100/);

    // Sentence 2 (complete): plain done-green, and NOT the incomplete cue.
    await expect(s2).toHaveClass(/bg-green-100/);
    await expect(s2).not.toHaveClass(/sentence-incomplete/);
  });

  test('the incomplete finding card shows a "needs a value" badge; the complete one does not', async ({ page }) => {
    // Target the card badge by its data-tip (the legend also carries the words
    // "Needs a value", so a bare text match would collide with it).
    const badge = page.locator('[data-tip="Needs a value"]');

    // Select sentence 1 → its incomplete finding card renders the badge.
    await page.evaluate(() => Alpine.store('app').selectSentence(1));
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText(/needs a value/i);

    // Select sentence 2 → the complete finding card's badge is hidden (the
    // element exists via x-show but must not display).
    await page.evaluate(() => Alpine.store('app').selectSentence(2));
    await expect(badge).toBeHidden();
  });

  test('sentence-incomplete composes with sentence-selected (both classes, no collision)', async ({ page }) => {
    await page.evaluate(() => Alpine.store('app').selectSentence(1));
    const s1 = page.locator('[data-sentence-idx="1"]');
    await expect(s1).toHaveClass(/sentence-incomplete/);
    await expect(s1).toHaveClass(/sentence-selected/);
  });
});
