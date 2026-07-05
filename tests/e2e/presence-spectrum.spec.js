// Presence spectrum control (D2). One control, four one-gesture options
// (present / possible / no definite / absent) derived from
// Schema.presenceOptions. Stored decomposed (presence polarity + optional
// confidence.presence:'hedged'); the disabled '—' placeholder dissolves the
// presence-trap bug; touching presence clears a cue-guessed _polarityReview.

const { test, expect } = require('@playwright/test');
const { gotoApp, resetIndexedDb, seedTaxonomy } = require('./helpers');

const TEXT = 'FINDINGS:\nBrain Parenchyma:\n- No acute infarct.';

// Seed one validated finding; `attrs`/`extra` let a test control presence state.
async function seedOne(page, attrs = { presence: 'present' }, extra = {}) {
  await page.evaluate(async ({ text, attrs, extra }) => {
    const ft = Sentences.parseFindingsSection(text);
    const { sentences, sectionBreaks } = Sentences.splitIntoSentences(ft);
    await Storage.atomicReplace([{
      record_id: 'R001', report_text: text, sentences, sectionBreaks,
      findings: [Object.assign({
        finding_name: 'acute infarct', status: 'validated', source_sentence_idx: 1,
        source_text: 'No acute infarct.', origin: 'human_added', attributes: attrs,
      }, extra)],
      validated: false, validated_at: null, custom_findings_added: [],
      taxonomyVersion: 'CT Head:0', schema_version: 7,
    }]);
  }, { text: TEXT, attrs, extra });
  await page.reload();
  await page.waitForFunction(() => Alpine.store('app').currentView === 'annotate', null, { timeout: 5000 });
  await page.evaluate(() => Alpine.store('app').selectSentence(1));
}

const readFinding = (page) => page.evaluate(async () => (await Storage.loadReport('R001')).findings[0]);

test.describe('Presence spectrum control', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await resetIndexedDb(page);
    await seedTaxonomy(page);
  });

  test('choosing Possible stores present + confidence.presence hedged; cell shows icon + "possible"', async ({ page }) => {
    await seedOne(page);
    // Drive the store with the "Possible" option (present + hedged).
    await page.evaluate(() => {
      const app = Alpine.store('app');
      const possible = app.presenceOptions().find(o => o.presence === 'present' && o.hedged);
      app.updatePresence(app.validatedFindings[0]._globalIdx, possible);
    });
    const f = await readFinding(page);
    expect(f.attributes.presence).toBe('present');
    expect(f.confidence.presence).toBe('hedged');
    expect(await page.evaluate(() => Alpine.store('app').presenceCellDisplay(Alpine.store('app').validatedFindings[0]))).toBe('possible');
    const icon = await page.evaluate(() => Alpine.store('app').presenceCellIcon(Alpine.store('app').validatedFindings[0]));
    expect(icon).toBe('ti-circle-dashed-check');
    expect(icon).toBe(await page.evaluate(() => Alpine.store('app').presenceOptions().find(o => o.presence === 'present' && o.hedged).icon));
  });

  test('the d shortcut cycles all four spectrum options', async ({ page }) => {
    await seedOne(page, { presence: 'present' }); // Present
    const seq = [];
    for (let i = 0; i < 4; i++) {
      await page.locator('body').press('d');
      const f = await readFinding(page);
      seq.push(`${f.attributes.presence}${f.confidence && f.confidence.presence === 'hedged' ? '+h' : ''}`);
    }
    // present → present+h (possible) → absent+h (no definite) → absent → back to present.
    expect(seq).toEqual(['present+h', 'absent+h', 'absent', 'present']);
  });

  test('a presence-less finding accepts the first choice (presence-trap regression)', async ({ page }) => {
    await seedOne(page, {}); // no presence at all
    // The disabled '—' placeholder is selected; choosing Present must persist.
    await page.evaluate(() => {
      const app = Alpine.store('app');
      const present = app.presenceOptions().find(o => o.presence === 'present' && !o.hedged);
      app.updatePresence(app.validatedFindings[0]._globalIdx, present);
    });
    expect((await readFinding(page)).attributes.presence).toBe('present');
  });

  test('touching presence clears a cue-guessed _polarityReview and its review badge', async ({ page }) => {
    // A finding validated at migration time carrying _polarityReview (never
    // passes through acceptFinding) — the presence control is its only clear-path.
    await seedOne(page, { presence: 'present' }, { _polarityReview: true });
    // Badge visible before.
    await expect(page.locator('.group\\/card').getByText('needs review')).toBeVisible();
    await page.evaluate(() => {
      const app = Alpine.store('app');
      const absent = app.presenceOptions().find(o => o.presence === 'absent' && !o.hedged);
      app.updatePresence(app.validatedFindings[0]._globalIdx, absent);
    });
    const f = await readFinding(page);
    expect(f._polarityReview).toBeUndefined();
  });
});
