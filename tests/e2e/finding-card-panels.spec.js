/**
 * Unified finding-card component (plan D5/S8): every panel — pending,
 * validated, unassigned, unassigned-validated, rejected — renders the same
 * card shell ([data-finding-card], parameterized by data-card-mode), and the
 * rejected panel restores a finding back to pending review.
 */

const { test, expect } = require('@playwright/test');
const { gotoApp, resetIndexedDb, seedTaxonomy, seedReports } = require('./helpers');

test.describe('Unified finding-card panels', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await resetIndexedDb(page);
    await seedTaxonomy(page);
    await seedReports(page, ['R001']);
    // One finding per status, all anchored to sentence 1 except the
    // unassigned pair (null / out-of-range anchors).
    await page.evaluate(async () => {
      const app = Alpine.store('app');
      app.report.findings.push(
        { finding_name: 'acute infarct', status: 'pending', source_sentence_idx: 1, source_text: 'No acute infarct.', attributes: { presence: 'absent' }, origin: 'llm' },
        { finding_name: 'mass effect', status: 'validated', source_sentence_idx: 1, source_text: 'No mass effect.', attributes: { presence: 'absent' }, origin: 'human_added' },
        { finding_name: 'midline shift', status: 'rejected', source_sentence_idx: 1, source_text: 'No midline shift.', attributes: { presence: 'absent' }, origin: 'llm' },
        { finding_name: 'hydrocephalus', status: 'pending', source_sentence_idx: null, source_text: '', attributes: { presence: 'present' }, origin: 'llm' },
        { finding_name: 'cerebral edema', status: 'validated', source_sentence_idx: null, source_text: '', attributes: { presence: 'present' }, origin: 'human_added' },
      );
      await app._saveCurrentReport();
      app.selectSentence(1);
    });
  });

  test('all five panels render the same card shell with their mode', async ({ page }) => {
    for (const [panel, mode] of [
      ['pending', 'triage'],
      ['validated', 'edit'],
      ['unassigned', 'triage'],
      ['unassigned-validated', 'recovery'],
      ['rejected', 'rejected'],
    ]) {
      const card = page.locator(`[data-panel="${panel}"] [data-finding-card]`);
      await expect(card, `${panel} panel card`).toHaveCount(1);
      await expect(card).toHaveAttribute('data-card-mode', mode);
    }
  });

  test('rejected panel is collapsed by default and restores a finding to pending', async ({ page }) => {
    const panel = page.locator('[data-panel="rejected"]');
    await expect(panel).toContainText('Rejected (1)');
    // Collapsed: the Restore button exists but isn't visible until expanded.
    const restore = panel.locator('[data-restore-rejected]');
    await expect(restore).toBeHidden();
    await panel.locator('summary').click();
    await expect(restore).toBeVisible();

    await restore.click();
    // The finding moved to the pending panel; the rejected panel disappears.
    await page.waitForFunction(() => Alpine.store('app').rejectedFindings.length === 0);
    const status = await page.evaluate(() =>
      Alpine.store('app').report.findings.find(f => f.finding_name === 'midline shift').status);
    expect(status).toBe('pending');
    await expect(page.locator('[data-panel="pending"]')).toContainText('Pending Review (2)');
    await expect(panel).toHaveCount(0);
  });

  test('read-only cards show presence badge; edit card shows the spectrum control', async ({ page }) => {
    // Triage card: presence badge, no attribute editor.
    const pendingCard = page.locator('[data-panel="pending"] [data-finding-card]');
    await expect(pendingCard).toContainText('absent');
    await expect(pendingCard.locator('button[data-tip="Click to advance"]')).toHaveCount(0);
    // Edit card: the presence spectrum row exists.
    const validatedCard = page.locator('[data-panel="validated"] [data-finding-card]');
    await expect(validatedCard.locator('span:has-text("presence")').first()).toBeVisible();
  });
});
