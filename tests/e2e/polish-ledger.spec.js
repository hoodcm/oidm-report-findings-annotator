/**
 * S10 polish ledger (plan D5): tiered toasts and the batch of small fixes
 * from the review — one assertion per item.
 */

const { test, expect } = require('@playwright/test');
const { gotoApp, resetIndexedDb, seedTaxonomy, seedReports, captureDownload } = require('./helpers');

async function seedMixedFindings(page) {
  await page.evaluate(async () => {
    const app = Alpine.store('app');
    app.report.findings.push(
      { finding_name: 'acute infarct', status: 'pending', source_sentence_idx: 1, source_text: 'No acute infarct.', attributes: { presence: 'absent' }, origin: 'llm' },
      { finding_name: 'mass effect', status: 'validated', source_sentence_idx: 1, source_text: 'No mass effect.', attributes: { presence: 'absent' }, confidence: { severity: 'hedged' }, flagged: true, flag_reason: 'check', is_custom: true, origin: 'human_added' },
      { finding_name: 'hydrocephalus', status: 'pending', source_sentence_idx: null, source_text: '', attributes: { presence: 'present' }, origin: 'llm' },
    );
    app.report.flagged = true;
    await app._saveCurrentReport();
    app.selectSentence(1);
  });
}

test.describe('S10 polish ledger', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await resetIndexedDb(page);
    await seedTaxonomy(page);
    await seedReports(page, ['R001', 'R002']);
    await seedMixedFindings(page);
  });

  test('accepting an unassigned finding via `a` toasts the sentence it landed on', async ({ page }) => {
    // Reject the anchored pending finding so the unassigned one is the a-target.
    await page.evaluate(() => Alpine.store('app').rejectFinding(0));
    await page.keyboard.press('a');
    await page.waitForFunction(() =>
      /Accepted Hydrocephalus → sentence 1/.test(Alpine.store('app').toastMessage));
  });

  test('error toasts outlive the info tier and carry a working dismiss ×', async ({ page }) => {
    await page.evaluate(() => Alpine.store('app').showToast('boom', 'error'));
    await page.waitForTimeout(5000); // info (4 s) would have expired by now
    await expect(page.locator('[data-toast-dismiss]')).toBeVisible();
    await page.click('[data-toast-dismiss]');
    await page.waitForFunction(() => !Alpine.store('app').toastVisible);
  });

  test('import summary renders as a dismissible banner, not a toast', async ({ page }) => {
    await page.evaluate(() => Alpine.store('app').showNotice('Imported 3 findings into 1 reports.'));
    const banner = page.locator('[data-notice-banner]');
    await expect(banner).toBeVisible();
    await page.click('[data-notice-dismiss]');
    await expect(banner).toBeHidden();
  });

  test('recovery-panel delete asks the styled confirm first', async ({ page }) => {
    // Make a validated finding unanchored so the recovery panel shows.
    await page.evaluate(async () => {
      const app = Alpine.store('app');
      app.report.findings[1].source_sentence_idx = null;
      await app._saveCurrentReport();
    });
    await page.click('[data-panel="unassigned-validated"] button[title="Delete"]');
    await expect(page.locator('[data-confirm-dialog]')).toBeVisible();
    await page.click('[data-confirm-cancel]');
    // Cancel keeps the finding.
    expect(await page.evaluate(() => Alpine.store('app').report.findings.length)).toBe(3);
  });

  test('Clear All Data uses the styled confirm with the backup reassurance', async ({ page }) => {
    await page.locator('.drawer-summary', { hasText: 'Help' }).click();
    await page.click('button:has-text("Clear all data")');
    const dialog = page.locator('[data-confirm-dialog]');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('backup');
    await page.click('[data-confirm-cancel]');
    expect(await page.evaluate(() => Alpine.store('app').totalCount)).toBe(2);
  });

  test('search results over 20 show the cap hint', async ({ page }) => {
    // Seed a 30-finding taxonomy so a broad query overflows the cap.
    await page.evaluate(() => {
      const app = Alpine.store('app');
      app.taxonomy = Array.from({ length: 30 }, (_, i) => (
        { id: `T${i}`, name: `test finding ${i}`, synonyms: [], category: 'x', parent_id: null, finding_type: 'observation' }
      ));
      app.updateSearch('test');
    });
    await expect(page.locator('[data-search-cap-hint]')).toBeVisible();
    await expect(page.locator('[data-search-cap-hint]')).toContainText('Showing 20 of 30');
  });

  test('features input placeholder reads comma-separated', async ({ page }) => {
    expect(await page.evaluate(() => Alpine.store('app').attrPlaceholder('features')))
      .toContain('comma-separated');
  });

  test('Stats overlay adds flag/hedge counts and the custom-names copy list', async ({ page }) => {
    await page.evaluate(() => Alpine.store('app').showStats());
    const overlay = page.locator('#stats-overlay');
    await expect(overlay).toContainText('Flagged exams');
    await expect(overlay).toContainText('Flagged findings');
    await expect(overlay).toContainText('Hedged attributes');
    await expect(overlay.locator('[data-copy-custom-names]')).toBeVisible();
    await expect(overlay).toContainText('mass effect'); // the custom name listed
  });

  test('export-grid "All reports · CSV" cell triggers the training-data export', async ({ page }) => {
    await page.locator('.drawer-summary', { hasText: 'Save & export' }).click();
    const { filename } = await captureDownload(page, () =>
      page.click('[title="All annotations · CSV (training data)"]'));
    expect(filename).toMatch(/^training-data-.*\.csv$/);
  });

  test('JSON exports strip transient fields but keep durable review flags (F7)', async ({ page }) => {
    await page.evaluate(async () => {
      const app = Alpine.store('app');
      app.report.findings[0]._needsReview = true;   // durable, not recomputable → must survive
      app.report.findings[0]._polarityReview = true; // durable review flag → must survive
      app.report.findings[0]._matchError = 'stale';  // transient runtime → stripped
      await app._saveCurrentReport();
    });
    const { text } = await captureDownload(page, () =>
      page.evaluate(() => Alpine.store('app').exportCurrentReportJson()));
    // F7 regression: the blanket _*-strip silently dropped these non-recomputable
    // review flags across a round-trip. They must now survive export.
    expect(text).toContain('_needsReview');
    expect(text).toContain('_polarityReview');
    expect(text).not.toContain('_matchError'); // genuinely transient — still stripped
    expect(text).toContain('acute infarct');   // real content survives
  });

  test('popstate restores the sentence param', async ({ page }) => {
    await page.evaluate(() => Alpine.store('app').selectSentence(2));
    await page.evaluate(() => Alpine.store('app').navigateTo(1)); // pushes R002 entry
    await page.waitForFunction(() => Alpine.store('app').currentIdx === 1);
    await page.goBack();
    await page.waitForFunction(() => Alpine.store('app').currentIdx === 0);
    expect(await page.evaluate(() => Alpine.store('app').selectedSentenceIdx)).toBe(2);
  });

  test('taxonomy viewer explains the obs/dx chips', async ({ page }) => {
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('open-taxonomy')));
    const legend = page.locator('[data-taxonomy-legend]');
    await expect(legend).toBeVisible();
    await expect(legend).toContainText('observation');
    await expect(legend).toContainText('diagnosis');
  });

  test('reject popover stores an optional reason that reaches the CSV export', async ({ page }) => {
    await page.click('[data-panel="pending"] button[title="Reject"]');
    const pop = page.locator('.reason-pop', { hasText: 'Reject reason' });
    await expect(pop).toBeVisible();
    await pop.locator('textarea').fill('duplicate of another row');
    await pop.locator('[data-reject-confirm]').click();

    const f = await page.evaluate(async () =>
      (await Storage.loadReport('R001')).findings.find(x => x.finding_name === 'acute infarct'));
    expect(f.status).toBe('rejected');
    expect(f.reject_reason).toBe('duplicate of another row');

    const { text } = await captureDownload(page, () =>
      page.evaluate(() => Alpine.store('app').exportTrainingData()));
    expect(text.split('\n')[0]).toContain('reject_reason');
    expect(text).toContain('duplicate of another row');
  });

  test('un-validating cancels a pending auto-advance', async ({ page }) => {
    // Accept/reject pending work first so validation isn't gated.
    await page.evaluate(async () => {
      const app = Alpine.store('app');
      await app.rejectFinding(0);
      await app.rejectFinding(2);
      await app.toggleValidation();   // validate → arms the 300 ms auto-advance
      await app.toggleValidation();   // un-validate immediately → must cancel it
    });
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => Alpine.store('app').currentIdx)).toBe(0); // no advance
  });
});
