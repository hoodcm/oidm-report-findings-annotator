// Multi-value axes (D6): temporal_status / chronicity store an array, rendered
// as removable chips + an add-dropdown; the click-to-cycle body is disabled;
// export joins elements with "; ".

const { test, expect } = require('@playwright/test');
const { gotoApp, resetIndexedDb, seedTaxonomy, captureDownload } = require('./helpers');

const TEXT = 'FINDINGS:\nBrain Parenchyma:\n- No acute infarct.';

async function seedValidated(page, attrs) {
  await page.evaluate(async ({ text, attrs }) => {
    const ft = Sentences.parseFindingsSection(text);
    const { sentences, sectionBreaks } = Sentences.splitIntoSentences(ft);
    await Storage.atomicReplace([{
      record_id: 'R001', report_text: text, sentences, sectionBreaks,
      findings: [{ finding_name: 'acute infarct', status: 'validated', source_sentence_idx: 1,
        source_text: 'No acute infarct.', origin: 'human_added', attributes: attrs }],
      validated: false, validated_at: null, custom_findings_added: [],
      taxonomyVersion: 'CT Head:0', schema_version: 7,
    }]);
  }, { text: TEXT, attrs });
  await page.reload();
  await page.waitForFunction(() => Alpine.store('app').currentView === 'annotate', null, { timeout: 5000 });
  await page.evaluate(() => Alpine.store('app').selectSentence(1));
}

const readFinding = (page) => page.evaluate(async () => (await Storage.loadReport('R001')).findings[0]);

test.describe('Multi-value chronicity axis', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await resetIndexedDb(page);
    await seedTaxonomy(page);
  });

  test('add and remove chronicity values via the store; cycling is disabled', async ({ page }) => {
    await seedValidated(page, { presence: 'present', chronicity: [] });
    await page.evaluate(async () => {
      const app = Alpine.store('app');
      await app.addMultiValue(0, 'chronicity', 'acute');
      await app.addMultiValue(0, 'chronicity', 'evolving');
      await app.addMultiValue(0, 'chronicity', 'acute'); // dedup
    });
    expect((await readFinding(page)).attributes.chronicity).toEqual(['acute', 'evolving']);

    // Cycling a multi-value axis is a no-op (would overwrite the array).
    await page.evaluate(async () => Alpine.store('app').cycleAttribute(0, 'chronicity'));
    expect((await readFinding(page)).attributes.chronicity).toEqual(['acute', 'evolving']);

    await page.evaluate(() => Alpine.store('app').removeMultiValue(0, 'chronicity', 'acute'));
    expect((await readFinding(page)).attributes.chronicity).toEqual(['evolving']);
  });

  test('the chips UI renders each value with a remove control', async ({ page }) => {
    await seedValidated(page, { presence: 'present', chronicity: ['acute', 'subacute'] });
    const chronRow = page.locator('div.grid', { has: page.locator('span', { hasText: /^chronicity$/ }) });
    await expect(chronRow).toContainText('acute');
    await expect(chronRow).toContainText('subacute');
    // No click-to-advance body control on a multi-value row.
    await expect(chronRow.locator('button[data-tip="Click to advance"]')).toHaveCount(0);
    // Remove a chip via its × button. The click handler's save is async, so
    // poll the read-back rather than asserting immediately after the click.
    await chronRow.locator('button[data-tip="Remove"]').first().click();
    await expect(async () => {
      expect((await readFinding(page)).attributes.chronicity).toEqual(['subacute']);
    }).toPass();
  });

  test('export joins multi-value elements with "; "', async ({ page }) => {
    await seedValidated(page, { presence: 'present', chronicity: ['acute', 'evolving'] });
    const { text } = await captureDownload(page, () =>
      page.evaluate(() => Alpine.store('app').exportTrainingData()));
    // The chronicity column cell is the joined array (quoted by PapaParse for the ;).
    expect(text).toMatch(/acute; evolving/);
  });
});
