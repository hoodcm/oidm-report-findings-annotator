// _globalIdx backing-index invariant under the unified findings[] (C1).
// findings[] is heterogeneous by status, so a getter that assigned _globalIdx
// from the FILTERED position (rather than the backing report.findings index)
// would mutate the wrong element whenever a differently-statused finding
// precedes the visible row. Seed [validated, pending] on the same sentence and
// assert reject/edit hit exactly the intended backing element.

const { test, expect } = require('@playwright/test');
const { gotoApp, resetIndexedDb, seedTaxonomy } = require('./helpers');

const TEXT = 'FINDINGS:\nBrain Parenchyma:\n- No acute infarct.\n- No mass effect.';

async function seedMixed(page) {
  await page.evaluate(async (text) => {
    const ft = Sentences.parseFindingsSection(text);
    const { sentences, sectionBreaks } = Sentences.splitIntoSentences(ft);
    await Storage.atomicReplace([{
      record_id: 'MIX-1', report_text: text, sentences, sectionBreaks,
      findings: [
        // Backing index 0: validated, on sentence 1.
        { finding_name: 'acute infarct', status: 'validated', source_sentence_idx: 1,
          source_text: 'No acute infarct.', origin: 'human_added', attributes: { presence: 'absent' } },
        // Backing index 1: pending, ALSO on sentence 1 (so both show on the same sentence).
        { finding_name: 'mass effect', status: 'pending', source_sentence_idx: 1,
          source_text: 'No acute infarct.', attributes: { presence: 'absent' } },
      ],
      validated: false, validated_at: null, custom_findings_added: [],
      taxonomyVersion: 'CT Head:0', schema_version: 7,
    }]);
  }, TEXT);
  await page.reload();
  await page.waitForFunction(() => Alpine.store('app').currentView === 'annotate', null, { timeout: 5000 });
  await page.evaluate(() => Alpine.store('app').selectSentence(1));
}

test.describe('_globalIdx is the backing findings[] index (mixed-status)', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await resetIndexedDb(page);
    await seedTaxonomy(page);
  });

  test('the pending row getter carries the backing index (1), not the filtered position (0)', async ({ page }) => {
    await seedMixed(page);
    const idx = await page.evaluate(() => Alpine.store('app').pendingFindings[0]._globalIdx);
    expect(idx).toBe(1); // backing index — a filter-then-index slip would give 0
  });

  test('rejecting the pending row flips only findings[1]; the validated row is untouched', async ({ page }) => {
    await seedMixed(page);
    await page.evaluate(() => {
      const app = Alpine.store('app');
      app.rejectFinding(app.pendingFindings[0]._globalIdx);
    });
    const statuses = await page.evaluate(async () =>
      (await Storage.loadReport('MIX-1')).findings.map(f => ({ name: f.finding_name, status: f.status })));
    expect(statuses).toEqual([
      { name: 'acute infarct', status: 'validated' }, // unchanged
      { name: 'mass effect', status: 'rejected' },     // the pending row, flipped
    ]);
  });

  test('editing the validated row hits only findings[0]; the pending row is untouched', async ({ page }) => {
    await seedMixed(page);
    await page.evaluate(() => {
      const app = Alpine.store('app');
      app.updatePresence(app.validatedFindings[0]._globalIdx, { presence: 'present', hedged: false });
    });
    const findings = await page.evaluate(async () => (await Storage.loadReport('MIX-1')).findings);
    expect(findings[0].attributes.presence).toBe('present'); // edited
    expect(findings[1].attributes.presence).toBe('absent');  // pending untouched
    expect(findings[1].status).toBe('pending');
  });
});
