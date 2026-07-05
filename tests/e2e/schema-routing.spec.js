// Schema routing (D1): the four attribute-enumeration sites all derive from
// Schema.findingAttributeKeys(), so the metadata keys (presence, confidence)
// never leak into the "+ attribute" picker or the export canonical columns.

const { test, expect } = require('@playwright/test');
const { gotoApp, resetIndexedDb, seedTaxonomy, captureDownload } = require('./helpers');

const TEXT = 'FINDINGS:\nBrain Parenchyma:\n- No acute infarct.';

async function seedValidated(page) {
  await page.evaluate(async (text) => {
    const ft = Sentences.parseFindingsSection(text);
    const { sentences, sectionBreaks } = Sentences.splitIntoSentences(ft);
    await Storage.atomicReplace([{
      record_id: 'R001', report_text: text, sentences, sectionBreaks,
      findings: [
        { finding_name: 'acute infarct', status: 'validated', source_sentence_idx: 1,
          source_text: 'No acute infarct.', origin: 'human_added', attributes: { presence: 'absent' } },
      ],
      validated: false, validated_at: null, custom_findings_added: [],
      taxonomyVersion: 'CT Head:0', schema_version: 7,
    }]);
  }, TEXT);
  await page.reload();
  await page.waitForFunction(() => Alpine.store('app').currentView === 'annotate', null, { timeout: 5000 });
  await page.evaluate(() => Alpine.store('app').selectSentence(1));
}

test.describe('Schema-derived attribute enumeration', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await resetIndexedDb(page);
    await seedTaxonomy(page);
    await seedValidated(page);
  });

  test('the "+ attribute" picker offers no presence/confidence row', async ({ page }) => {
    const keys = await page.evaluate(() => {
      const app = Alpine.store('app');
      return app.getAvailableAttributes(app.validatedFindings[0]).map(a => a.key);
    });
    expect(keys).not.toContain('presence');
    expect(keys).not.toContain('confidence');
    expect(keys).toContain('laterality');   // a real annotatable attribute is offered
    expect(keys).toContain('aggregate');    // the renamed boolean
  });

  test('the export canonical columns include presence but no stray confidence attr column', async ({ page }) => {
    const { text } = await captureDownload(page, () =>
      page.evaluate(() => Alpine.store('app').exportTrainingData()));
    const header = text.replace(/^﻿/, '').split('\n')[0].split(',');
    expect(header).toContain('presence');
    expect(header).toContain('laterality');
    // Exactly one confidence column (the JSON hedge map) — the canonical loop no
    // longer emits a second, and the renamed boolean is 'aggregate' not 'multiple'.
    expect(header.filter(c => c === 'confidence').length).toBe(1);
    expect(header).toContain('aggregate');
    expect(header).not.toContain('multiple');
  });
});
