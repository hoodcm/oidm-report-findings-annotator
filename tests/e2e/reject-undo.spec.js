// Rejection preservation + undo (C2, now via the D5 snapshot stack).
// Rejecting a pending finding flips it to status:'rejected' (never deleted) —
// it leaves the pending panel but survives to the training-data CSV; the
// toast's generic Undo button restores the pre-reject snapshot (pending).

const { test, expect } = require('@playwright/test');
const { gotoApp, resetIndexedDb, seedTaxonomy, captureDownload } = require('./helpers');

const TEXT = 'FINDINGS:\nBrain Parenchyma:\n- No acute infarct.';

async function seedPending(page) {
  await page.evaluate(async (text) => {
    const ft = Sentences.parseFindingsSection(text);
    const { sentences, sectionBreaks } = Sentences.splitIntoSentences(ft);
    await Storage.atomicReplace([{
      record_id: 'R001', report_text: text, sentences, sectionBreaks,
      findings: [
        { finding_name: 'acute infarct', status: 'pending', source_sentence_idx: 1,
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

test.describe('Reject preservation + undo', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await resetIndexedDb(page);
    await seedTaxonomy(page);
    await seedPending(page);
  });

  test('rejecting preserves the finding as rejected and exports it as a row', async ({ page }) => {
    await page.evaluate(() => Alpine.store('app').rejectFinding(0));

    // Preserved in storage with status rejected (not deleted).
    const f = await page.evaluate(async () => (await Storage.loadReport('R001')).findings);
    expect(f.length).toBe(1);
    expect(f[0].status).toBe('rejected');
    // Gone from the pending panel.
    expect(await page.evaluate(() => Alpine.store('app').pendingFindings.length)).toBe(0);

    // Appears in the training-data CSV with status=rejected.
    const { text } = await captureDownload(page, () =>
      page.evaluate(() => Alpine.store('app').exportTrainingData()));
    expect(text).toContain('R001,rejected,acute infarct');
  });

  test('the Undo toast button flips the rejected finding back to pending', async ({ page }) => {
    await page.evaluate(() => Alpine.store('app').rejectFinding(0));
    const undoBtn = page.locator('[data-undo-last]');
    await expect(undoBtn).toBeVisible();
    await undoBtn.click();

    const f = await page.evaluate(async () => (await Storage.loadReport('R001')).findings);
    expect(f[0].status).toBe('pending');
    // Back in the pending panel.
    expect(await page.evaluate(() => Alpine.store('app').pendingFindings.length)).toBe(1);
  });
});
