// Pins the D4 paste-import contract (extraction-prompt-redesign plan, step 7):
// a textarea on the import panel feeds the same Norm.text -> parseText
// pipeline the file-upload path uses, so a pasted reply — fenced, with prose
// wrapped around it, exactly the shape an LLM chat actually returns — imports
// identically to a saved-and-uploaded file.

const { test, expect } = require('@playwright/test');
const { gotoApp, resetIndexedDb, seedTaxonomy, seedReports } = require('./helpers');

test.describe('Extraction import — paste import (D4)', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await resetIndexedDb(page);
    await seedTaxonomy(page);
    await seedReports(page, ['R001']);
    await page.waitForFunction(() => Alpine.store('app').currentView === 'annotate');
  });

  test('pasting a fenced, prose-wrapped reply reaches Step 1 exactly like a file upload', async ({ page }) => {
    const reply = 'Sure, here is the extracted JSON:\n\n```json\n'
      + JSON.stringify([{ record_id: 'R001', finding_name: 'acute infarct', source_text: 'No acute infarct.', presence: 'present' }], null, 2)
      + '\n```\n\nLet me know if you need the rest of the batch!';

    await page.getByRole('button', { name: /Import & add data/i }).click();
    await page.getByText("Or paste the AI's reply instead").click();
    await page.getByPlaceholder(/Paste the AI's reply here/).fill(reply);
    await page.getByRole('button', { name: 'Import pasted text' }).click();

    await page.waitForFunction(() => Alpine.store('app').currentView === 'import-extractions');
    expect(await page.evaluate(() => Alpine.store('app').extractionStep)).toBe(1);
    expect(await page.evaluate(() => Alpine.store('app').extractionData)).toEqual([
      { record_id: 'R001', finding_name: 'acute infarct', source_text: 'No acute infarct.', presence: 'present' },
    ]);
    // Column auto-detection ran identically to the file-upload path.
    const map = await page.evaluate(() => Alpine.store('app').extractionColumnMap);
    expect(map.record_id).toBe('record_id');
    expect(map.finding_name).toBe('finding_name');
    expect(map.source_text).toBe('source_text');
    expect(map.presence).toBe('presence');

    // Drive the rest of the wizard for real — the pasted row imports cleanly.
    await page.getByRole('button', { name: 'Check my data' }).click();
    await expect(page.getByText('1 of 1 rows ready to import')).toBeVisible();
    await page.getByRole('button', { name: 'Review Matches' }).click();
    await page.getByRole('button', { name: /Import \d+ Finding/ }).click();
    await page.waitForFunction(() => Alpine.store('app').extractionsImported === true);

    const report = await page.evaluate(async () => await Storage.loadReport('R001'));
    const pending = report.findings.filter(f => f.status === 'pending');
    expect(pending.length).toBe(1);
    expect(pending[0].finding_name).toBe('acute infarct');
  });

  test('an empty paste shows an error instead of silently doing nothing', async ({ page }) => {
    await page.getByRole('button', { name: /Import & add data/i }).click();
    await page.getByText("Or paste the AI's reply instead").click();
    const btn = page.getByRole('button', { name: 'Import pasted text' });
    await expect(btn).toBeDisabled();
  });

  // Code-review regression (Phase 10): a file upload surfaces D3 repair
  // notes via the drop-zone classifier's chip, but a pasted reply skips the
  // classifier entirely — this was the paste path's only chance to tell the
  // user something was silently patched, and it was being dropped.
  test('a truncated pasted reply surfaces the "looked cut off" note, not just a silent partial import', async ({ page }) => {
    const truncated = '[' + JSON.stringify({ record_id: 'R001', finding_name: 'acute infarct', source_text: 'No acute infarct.', presence: 'present' })
      + ',{"record_id":"R001","finding_n';

    await page.getByRole('button', { name: /Import & add data/i }).click();
    await page.getByText("Or paste the AI's reply instead").click();
    await page.getByPlaceholder(/Paste the AI's reply here/).fill(truncated);
    await page.getByRole('button', { name: 'Import pasted text' }).click();

    await page.waitForFunction(() => Alpine.store('app').currentView === 'import-extractions');
    const notice = await page.evaluate(() => Alpine.store('app')._notice);
    expect(notice).toMatch(/looked cut off/i);
    expect(notice).toMatch(/recovered 1 complete finding/i);
  });
});
