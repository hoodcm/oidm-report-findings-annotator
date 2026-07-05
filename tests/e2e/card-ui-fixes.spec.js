// E2E regression anchors for the card-UI + correctness fixes landed alongside
// the code review (F1–F10) and Michael's card feedback (U1–U8). Each test pins
// the CONTRACT of one fix so a future refactor can't silently undo it.
//
// Seeds a report with one or more findings via Storage + reload (the production
// init() path), then drives Alpine.store('app') and reads state back.

const { test, expect } = require('@playwright/test');
const { gotoApp, resetIndexedDb, seedTaxonomy } = require('./helpers');

const REPORT_TEXT =
  'FINDINGS:\nBrain Parenchyma:\n- Small acute subdural hemorrhage along the left convexity.\n- No midline shift.';

// Seed a single report whose findings[] the caller supplies (each merged over a
// sensible validated default), then reload through init() and select sentence 1.
async function seedFindings(page, findings, reportOverrides = {}) {
  await page.evaluate(async ({ fs, r, text }) => {
    const findingsText = Sentences.parseFindingsSection(text);
    const { sentences, sectionBreaks } = Sentences.splitIntoSentences(findingsText);
    const built = fs.map((f) => Object.assign({
      finding_name: 'subdural hemorrhage',
      taxonomy_id: 'HID002',
      status: 'validated',
      source_sentence_idx: 1,
      source_text: sentences[0] || '',
      is_custom: false,
      origin: 'llm',
      was_modified: false,
      attributes: { presence: 'present' },
    }, f));
    const report = Object.assign({
      record_id: 'R001',
      report_text: text,
      sentences, sectionBreaks,
      findings: built,
      validated: false,
      validated_at: null,
      custom_findings_added: [],
      taxonomyVersion: 'CT Head:0',
      schema_version: 7,
    }, r);
    await Storage.atomicReplace([report]);
  }, { fs: findings, r: reportOverrides, text: REPORT_TEXT });

  await page.reload();
  await page.waitForFunction(
    () => window.Alpine && Alpine.store && Alpine.store('app')
      && Alpine.store('app').currentView === 'annotate',
    { timeout: 10000 }
  );
  await page.evaluate(() => { Alpine.store('app').selectedSentenceIdx = 1; });
}

const readFinding = (page, idx = 0) =>
  page.evaluate((i) => Alpine.store('app').report.findings[i], idx);

test.beforeEach(async ({ page }) => {
  await gotoApp(page);
  await resetIndexedDb(page);
  await seedTaxonomy(page);
});

// U6: clicking the presence body advances it through the spectrum (was
// dropdown-only). present → possible (present + hedged).
test('U6: clicking the presence body advances presence through the spectrum', async ({ page }) => {
  await seedFindings(page, [{ attributes: { presence: 'present' } }]);
  const card = page.locator('.group\\/card').first();
  await card.locator('button[data-tip="Click to advance"]').first().click();
  await expect(async () => {
    const f = await readFinding(page);
    expect(f.attributes.presence).toBe('present');
    expect(f.confidence && f.confidence.presence).toBe('hedged'); // "possible"
  }).toPass();
});

// U1: a flagged finding renders the outline ti-flag (the filled variant isn't in
// the vendored webfont — it used to render blank/"malformed" on click).
test('U1: flag icon is the outline ti-flag both unflagged and flagged (no missing glyph)', async ({ page }) => {
  await seedFindings(page, [{ attributes: { presence: 'present' } }]);
  const card = page.locator('.group\\/card').first();
  const flagBtn = card.locator('button[data-tip="Flag this finding"]');
  const icon = () => flagBtn.locator('i.ti');
  await expect(icon()).toHaveClass(/ti-flag(\s|$)/);
  await expect(icon()).not.toHaveClass(/ti-flag-filled/);
  await flagBtn.click();
  // After flagging the reason popover opens; the depressed button keeps ti-flag.
  const flagged = card.locator('button[data-tip="Flagged — click to edit"] i.ti');
  await expect(flagged).toHaveClass(/ti-flag(\s|$)/);
  await expect(flagged).not.toHaveClass(/ti-flag-filled/);
});

// F5: a rejected finding with no sentence anchor still appears in the Rejected
// panel and is restorable (was orphaned into no panel).
test('F5: an unanchored rejected finding is restorable from the Rejected panel', async ({ page }) => {
  await seedFindings(page, [
    { status: 'pending', source_sentence_idx: null, finding_name: 'midline shift', taxonomy_id: 'HID003' },
  ]);
  await page.evaluate(() => Alpine.store('app').rejectFinding(0));
  const rejectedPanel = page.locator('[data-panel="rejected"]');
  await expect(rejectedPanel).toBeVisible();
  // The Rejected panel is collapsed by default — expand it to reach Restore.
  await rejectedPanel.locator('summary').click();
  await rejectedPanel.locator('[data-restore-rejected]').click();
  await expect(async () => {
    expect((await readFinding(page)).status).toBe('pending');
  }).toPass();
});

// F10: a manually toggled panel keeps its collapse state across a mutation
// (the getter re-runs constantly; it used to snap back to the default).
test('F10: a collapsed panel stays collapsed after an edit', async ({ page }) => {
  await seedFindings(page, [{ attributes: { presence: 'present' } }]);
  const details = page.locator('[data-panel="validated"] details');
  await expect(details).toHaveJSProperty('open', true);
  await page.locator('[data-panel="validated"] summary').click();
  await expect(details).toHaveJSProperty('open', false);
  // Mutate the report; the panel must NOT reopen.
  await page.evaluate(() => Alpine.store('app').cyclePresence(0));
  await expect(details).toHaveJSProperty('open', false);
});

// F2: a full (re)load clears the snapshot undo stack, so a stale snapshot can't
// restore over a same-record_id report in a freshly loaded corpus.
test('F2: _loadSession resets the undo/redo stacks', async ({ page }) => {
  await seedFindings(page, [{ attributes: { presence: 'present' } }]);
  await page.evaluate(() => Alpine.store('app').cyclePresence(0));
  expect(await page.evaluate(() => Alpine.store('app').canUndo)).toBe(true);
  // Seed a ghost stack (a colliding record_id from a prior corpus) and reload.
  await page.evaluate(() => { Alpine.store('app')._undo.R001 = ['{"record_id":"R001"}']; });
  await page.evaluate(() => Alpine.store('app')._loadSession());
  const state = await page.evaluate(() => ({
    undoKeys: Object.keys(Alpine.store('app')._undo).length,
    redoKeys: Object.keys(Alpine.store('app')._redo).length,
  }));
  expect(state.undoKeys).toBe(0);
  expect(state.redoKeys).toBe(0);
});

// F9: the migration banner and the notice banner stack (single fixed column)
// rather than overlapping at top-0.
test('F9: migration + notice banners stack without overlapping', async ({ page }) => {
  await seedFindings(page, [{ attributes: { presence: 'present' } }]);
  await page.evaluate(() => {
    const app = Alpine.store('app');
    app._migrationBanner = 'migration text';
    app._notice = 'notice text';
  });
  const migration = page.locator('[data-migration-banner]');
  const notice = page.locator('[data-notice-banner]');
  await expect(migration).toBeVisible();
  await expect(notice).toBeVisible();
  const mBox = await migration.boundingBox();
  const nBox = await notice.boundingBox();
  // Notice sits fully below the migration banner (no vertical overlap).
  expect(nBox.y).toBeGreaterThanOrEqual(mBox.y + mBox.height - 1);
});
