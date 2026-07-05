// Pins the attribute-discoverability surfaces (v1.6+): the "+ attribute" picker
// surfaces each attribute's values inline (so `extent` is discoverable as the
// home for a qualitative "small"), never offers the system-managed `confidence`
// hedge map, and free-text attributes carry a curated measurement-style
// placeholder instead of a bare "type…".

const { test, expect } = require('@playwright/test');
const { gotoApp, resetIndexedDb, seedTaxonomy } = require('./helpers');

// One validated finding on sentence 1 with the given attributes, rendered
// through init(); sentence 1 selected so its card (and picker) show.
async function seedFinding(page, attributes) {
  await page.evaluate(async (attrs) => {
    const text = 'FINDINGS:\nBrain Parenchyma:\n- Small acute subdural hemorrhage along the left convexity.';
    const ft = Sentences.parseFindingsSection(text);
    const { sentences, sectionBreaks } = Sentences.splitIntoSentences(ft);
    await Storage.atomicReplace([{
      record_id: 'R001', report_text: text, sentences, sectionBreaks,
      findings: [
        { finding_name: 'subdural hemorrhage', status: 'validated', source_sentence_idx: 1, source_text: 'Small acute subdural hemorrhage along the left convexity.', origin: 'human_added', attributes: attrs },
      ],
      validated: false, validated_at: null, custom_findings_added: [], taxonomyVersion: 'CT Head:0', schema_version: 7,
    }]);
  }, attributes);
  await page.reload();
  await page.waitForFunction(() => Alpine.store('app').currentView === 'annotate', null, { timeout: 5000 });
  await page.evaluate(() => Alpine.store('app').selectSentence(1));
}

test.describe('Attribute discoverability', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await resetIndexedDb(page);
    await seedTaxonomy(page);
  });

  test('the "+ attribute" picker lists extent values inline and never offers confidence', async ({ page }) => {
    await seedFinding(page, { presence: 'present' });

    // Predicate: confidence + presence excluded, real attributes offered.
    const keys = await page.evaluate(() =>
      Alpine.store('app').getAvailableAttributes({ attributes: { presence: 'present' } }).map(a => a.key)
    );
    expect(keys).toContain('extent');
    expect(keys).not.toContain('confidence'); // regression anchor: pre-existing leak
    expect(keys).not.toContain('presence');

    // DOM: extent option lists its values in brackets; a 5-value enum shows a
    // first…last range; no confidence option appears anywhere in the picker.
    const optionTexts = await page.locator('select[data-tip="Add an attribute"] option').allTextContents();
    expect(optionTexts.some(t => t.includes('extent (small, medium, large)'))).toBe(true);
    expect(optionTexts.some(t => t.includes('severity (mild … severe)'))).toBe(true);
    expect(optionTexts.some(t => /confidence/i.test(t))).toBe(false);
  });

  test('a free-text size row shows the curated measurement placeholder', async ({ page }) => {
    await seedFinding(page, { presence: 'present', size: '' });
    const sizeRow = page.locator('div.grid', { has: page.locator('span', { hasText: /^size$/ }) });
    await expect(sizeRow.locator('input[type="text"]')).toHaveAttribute('placeholder', 'e.g. 3.2 cm');
  });
});
