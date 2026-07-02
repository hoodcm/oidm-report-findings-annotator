// E2E for the per-attribute hedge model, per-finding flag, and whole-exam flag
// (docs/plans/2026-07-01-attribute-hedge-and-flagging-plan.md, Steps 1–5).
//
// app.js is not in the Node harness (it's the Alpine component), so its store
// methods + the Unified Rows editor are exercised here against the real app:
// seed a report with a validated finding, drive Alpine.store('app'), read back.

const { test, expect } = require('@playwright/test');
const { gotoApp, resetIndexedDb, seedTaxonomy, captureDownload } = require('./helpers');

const REPORT_TEXT =
  'FINDINGS:\nBrain Parenchyma:\n- Small acute subdural hemorrhage along the left convexity.\n- No midline shift.';

// Seed a single-report, single-validated-finding session, reload through the
// production init() path, then select sentence 1 so the finding renders.
async function seedOneFinding(page, findingOverrides = {}, reportOverrides = {}) {
  await page.evaluate(async ({ f, r, text }) => {
    const findingsText = Sentences.parseFindingsSection(text);
    const { sentences, sectionBreaks } = Sentences.splitIntoSentences(findingsText);
    const finding = Object.assign({
      finding_name: 'subdural hemorrhage',
      taxonomy_id: 'HID002',
      source_sentence_idx: 1,
      source_text: sentences[0] || '',
      _needsReview: false,
      is_custom: false,
      origin: 'llm',
      was_modified: false,
      attributes: { presence: 'present', laterality: 'left', chronicity: 'acute' },
    }, f);
    const report = Object.assign({
      record_id: 'R001',
      report_text: text,
      sentences, sectionBreaks,
      llm_extractions: [],
      validated_findings: [finding],
      validated: false,
      validated_at: null,
      custom_findings_added: [],
      taxonomyVersion: 'CT Head:0',
      schema_version: 4,
    }, r);
    await Storage.atomicReplace([report]);
  }, { f: findingOverrides, r: reportOverrides, text: REPORT_TEXT });

  await page.reload();
  await page.waitForFunction(
    () => typeof window.Alpine === 'object' && Alpine.store && Alpine.store('app')
      && Alpine.store('app').currentView === 'annotate',
    { timeout: 10000 }
  );
  await page.evaluate(() => { Alpine.store('app').selectedSentenceIdx = 1; });
  // Card renders once a sentence with findings is selected.
  await expect(page.locator('.group\\/card')).toBeVisible();
}

// Read back the single seeded finding from storage (post-save, ground truth).
async function readFinding(page) {
  return page.evaluate(async () => {
    const r = await Storage.loadReport('R001');
    return r.validated_findings[0];
  });
}

test.beforeEach(async ({ page }) => {
  await gotoApp(page);
  await resetIndexedDb(page);
  await seedTaxonomy(page);
});

// ---- Step 1: defensive reads on old-shape data ----

test('old-shape finding/report (no confidence/flagged fields) renders without throwing', async ({ page }) => {
  // No confidence, no flagged on the finding; no flagged on the report.
  await seedOneFinding(page, { attributes: { presence: 'present', laterality: 'left' } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  // Reading the attribute rows + flag state must not throw.
  const out = await page.evaluate(() => {
    const app = Alpine.store('app');
    const f = app.report.validated_findings[0];
    return {
      confidence: f.confidence ?? null,
      findingFlagged: f.flagged ?? null,
      reportFlagged: app.report.flagged ?? null,
      rowCount: app.getSetAttributes(f).length,
    };
  });
  expect(out.confidence).toBeNull();
  expect(out.findingFlagged).toBeNull();
  expect(out.reportFlagged).toBeNull();
  expect(out.rowCount).toBe(1); // laterality (presence rendered separately)
  expect(errors).toEqual([]);
});

// ---- Step 2: confidence mutators, ordering, blank-value semantics ----

test('toggleHedge sets and clears confidence.chronicity', async ({ page }) => {
  await seedOneFinding(page);
  await page.evaluate(() => Alpine.store('app').toggleHedge(0, 'chronicity'));
  expect((await readFinding(page)).confidence).toEqual({ chronicity: 'hedged' });
  await page.evaluate(() => Alpine.store('app').toggleHedge(0, 'chronicity'));
  // Clearing the last hedge drops the whole confidence object (canonical shape).
  expect((await readFinding(page)).confidence).toBeUndefined();
});

test('toggleHedge on presence is a no-op (presence is never hedgeable)', async ({ page }) => {
  await seedOneFinding(page);
  await page.evaluate(() => Alpine.store('app').toggleHedge(0, 'presence'));
  expect((await readFinding(page)).confidence).toBeUndefined();
});

test('toggleHedge on an empty-valued attribute is a no-op (confidence invariant)', async ({ page }) => {
  await seedOneFinding(page);
  // Add an empty severity row, then try to hedge it.
  await page.evaluate(() => Alpine.store('app').addAttribute(0, 'severity'));
  await page.evaluate(() => Alpine.store('app').toggleHedge(0, 'severity'));
  const f = await readFinding(page);
  expect(f.confidence).toBeUndefined();
  expect('severity' in f.attributes).toBe(true); // row still there, just unset
  expect(f.attributes.severity).toBe('');
});

test('getSetAttributes returns canonical order and keeps empty-valued rows', async ({ page }) => {
  // Seed attributes in NON-canonical insertion order; expect canonical output.
  await seedOneFinding(page, { attributes: { presence: 'present', chronicity: 'acute', laterality: 'left' } });
  await page.evaluate(() => Alpine.store('app').addAttribute(0, 'severity')); // empty row
  const keys = await page.evaluate(() =>
    Alpine.store('app').getSetAttributes(Alpine.store('app').report.validated_findings[0]).map(a => a.key));
  // Canonical order per attributes.json: laterality < chronicity < severity.
  expect(keys).toEqual(['laterality', 'chronicity', 'severity']);
});

test('getAvailableAttributes excludes a just-added empty attribute (no double-add)', async ({ page }) => {
  await seedOneFinding(page);
  await page.evaluate(() => Alpine.store('app').addAttribute(0, 'severity'));
  const avail = await page.evaluate(() =>
    Alpine.store('app').getAvailableAttributes(Alpine.store('app').report.validated_findings[0]).map(a => a.key));
  expect(avail).not.toContain('severity');
});

test('removeAttribute on a hedged attribute leaves no stale confidence key', async ({ page }) => {
  await seedOneFinding(page);
  await page.evaluate(() => Alpine.store('app').toggleHedge(0, 'chronicity'));
  await page.evaluate(() => Alpine.store('app').removeAttribute(0, 'chronicity'));
  const f = await readFinding(page);
  expect('chronicity' in f.attributes).toBe(false);
  expect(f.confidence).toBeUndefined(); // no dangling { chronicity: 'hedged' }
});

test('clearing a hedged attribute value to empty keeps the row but drops the hedge', async ({ page }) => {
  await seedOneFinding(page);
  await page.evaluate(() => Alpine.store('app').toggleHedge(0, 'chronicity'));
  await page.evaluate(() => Alpine.store('app').updateAttribute(0, 'chronicity', ''));
  const f = await readFinding(page);
  expect('chronicity' in f.attributes).toBe(true);
  expect(f.attributes.chronicity).toBe('');
  expect(f.confidence).toBeUndefined(); // cleared row must not stay hedged
});

test('emptying a hedged array attribute via a comma-only input drops the dangling hedge', async ({ page }) => {
  // Regression: updateAttribute's array branch can collapse to [] from input
  // like ',' — that logically-empty value must clear the hedge (invariant),
  // not leave confidence.features='hedged' on a blank axis.
  await seedOneFinding(page, {
    attributes: { presence: 'present', features: ['spiculated', 'irregular'] },
  });
  await page.evaluate(() => Alpine.store('app').toggleHedge(0, 'features'));
  expect((await readFinding(page)).confidence).toEqual({ features: 'hedged' });
  await page.evaluate(() => Alpine.store('app').updateAttribute(0, 'features', ' , '));
  const f = await readFinding(page);
  expect(f.attributes.features).toEqual([]); // row stays, value empty
  expect(f.confidence).toBeUndefined();       // hedge dropped (no dangling key)
});

test('clearing a canonical value to empty keeps the row (add-then-choose semantics)', async ({ page }) => {
  await seedOneFinding(page);
  await page.evaluate(() => Alpine.store('app').updateAttribute(0, 'laterality', ''));
  const f = await readFinding(page);
  expect('laterality' in f.attributes).toBe(true);
  expect(f.attributes.laterality).toBe('');
});

// ---- Step 3: Unified Rows markup ----

test('hedging via the eye flips indigo styling and leaves the top hairline gray', async ({ page }) => {
  await seedOneFinding(page);
  const chronRow = page.locator('div.grid', { has: page.locator('span', { hasText: /^chronicity$/ }) });
  await expect(chronRow).toHaveClass(/border-l-transparent/);
  await chronRow.hover();
  await chronRow.locator('button:has(.ti-eye-question)').click();
  // Indigo left accent on the row; top hairline stays border-t-gray-100 (the
  // regression anchor for the border-scope bug — must be side-scoped border-l).
  await expect(chronRow).toHaveClass(/border-l-indigo-400/);
  await expect(chronRow).toHaveClass(/border-t-gray-100/);
  await expect(chronRow).not.toHaveClass(/border-l-transparent/);
});

test('presence row has no hedge control', async ({ page }) => {
  await seedOneFinding(page);
  const presenceRow = page.locator('div.grid', { has: page.locator('span', { hasText: /^presence$/ }) });
  await expect(presenceRow.locator('.ti-eye-question')).toHaveCount(0);
});

test('cycling laterality advances the value', async ({ page }) => {
  await seedOneFinding(page);
  const latRow = page.locator('div.grid', { has: page.locator('span', { hasText: /^laterality$/ }) });
  await latRow.locator('button[data-tip="Click to advance"]').click();
  // left → right (values: left, right, bilateral)
  await expect(latRow.locator('button[data-tip="Click to advance"]')).toHaveText('right');
  expect((await readFinding(page)).attributes.laterality).toBe('right');
});

test('adding an attribute shows an empty (—) row', async ({ page }) => {
  await seedOneFinding(page);
  await page.locator('select[data-tip="Add an attribute"]').selectOption('severity');
  const sevRow = page.locator('div.grid', { has: page.locator('span', { hasText: /^severity$/ }) });
  await expect(sevRow).toBeVisible();
  await expect(sevRow.locator('button[data-tip="Click to advance"]')).toHaveText('—');
});

test('boolean attribute renders a hybrid cycle+dropdown and cycles false↔true', async ({ page }) => {
  await seedOneFinding(page);
  await page.locator('select[data-tip="Add an attribute"]').selectOption('multiple');
  const mulRow = page.locator('div.grid', { has: page.locator('span', { hasText: /^multiple$/ }) });
  // Hybrid control (a cycle button + a real dropdown), NOT a free-text input.
  await expect(mulRow.locator('button[data-tip="Click to advance"]')).toBeVisible();
  await expect(mulRow.locator('input')).toHaveCount(0);
  await expect(mulRow.locator('select')).toHaveCount(1);
  const cycle = mulRow.locator('button[data-tip="Click to advance"]');
  await cycle.click(); // '' → false
  await expect(cycle).toHaveText('false');
  expect((await readFinding(page)).attributes.multiple).toBe('false');
  await cycle.click(); // false → true
  await expect(cycle).toHaveText('true');
  expect((await readFinding(page)).attributes.multiple).toBe('true');
});

// ---- Step 4: per-finding flag + popover ----

test('per-finding flag: open, add reason, click-outside close, reopen persists, remove clears', async ({ page }) => {
  await seedOneFinding(page);
  const card = page.locator('.group\\/card').first();
  const flagBtn = card.locator('button[data-tip="Flag this finding"]');
  await flagBtn.click();
  const textarea = card.locator('.reason-pop textarea');
  await expect(textarea).toBeVisible();
  await textarea.fill('wrong heading — cannot annotate');
  await textarea.blur(); // @change persists the reason
  await expect(async () => {
    expect((await readFinding(page)).flag_reason).toBe('wrong heading — cannot annotate');
  }).toPass();

  // Click outside (the report title) closes the popover.
  await page.locator('h2').first().click();
  await expect(card.locator('.reason-pop')).toHaveCount(0);

  // Reopen via the depressed flag; the reason persists.
  await card.locator('button[data-tip="Flagged — click to view/edit"]').click();
  await expect(card.locator('.reason-pop textarea')).toHaveValue('wrong heading — cannot annotate');

  // Remove flag clears both fields.
  await card.locator('.reason-pop button:has-text("Remove flag")').click();
  const f = await readFinding(page);
  expect(f.flagged).toBe(false);
  expect(f.flag_reason).toBe('');
});

test('flagged finding shows the reason dot only when a reason is present', async ({ page }) => {
  await seedOneFinding(page, { flagged: true, flag_reason: '' });
  const card = page.locator('.group\\/card').first();
  // Dot uses x-show (stays in the DOM, toggled by display) — assert visibility.
  await expect(card.locator('[data-tip="Has a reason note"]')).toBeHidden();
  await page.evaluate(() => Alpine.store('app').setFindingFlagReason(0, 'some reason'));
  await expect(card.locator('[data-tip="Has a reason note"]')).toBeVisible();
});

// ---- Step 6: export columns + flagged-empty sentinel ----

test('export row carries confidence JSON, finding flag, and report flag', async ({ page }) => {
  await seedOneFinding(page, {
    flagged: true,
    flag_reason: 'mismap',
    attributes: { presence: 'present', chronicity: 'acute' },
    confidence: { chronicity: 'hedged' },
  }, { flagged: true, flag_reason: 'exam is a problem' });

  const row = await page.evaluate(() => {
    const app = Alpine.store('app');
    return app._buildFindingRows(app.report)[0];
  });
  expect(row.confidence).toBe('{"chronicity":"hedged"}');
  expect(row.flagged).toBe(true);
  expect(row.flag_reason).toBe('mismap');
  expect(row.report_flagged).toBe(true);
  expect(row.report_flag_reason).toBe('exam is a problem');
});

test('a fully-definite finding exports confidence={} and carries no confidence key in JSON', async ({ page }) => {
  await seedOneFinding(page); // no confidence, no flags
  const out = await page.evaluate(() => {
    const app = Alpine.store('app');
    const row = app._buildFindingRows(app.report)[0];
    return { rowConfidence: row.confidence, hasKey: 'confidence' in app.report.validated_findings[0] };
  });
  expect(out.rowConfidence).toBe('{}');
  expect(out.hasKey).toBe(false); // JSON export omits confidence for definite findings
});

test('flagged report with zero findings still emits one sentinel CSV row', async ({ page }) => {
  // Seed a report with NO findings but flagged (the Hana/Omar un-annotatable case).
  await page.evaluate(async ({ text }) => {
    const findingsText = Sentences.parseFindingsSection(text);
    const { sentences, sectionBreaks } = Sentences.splitIntoSentences(findingsText);
    await Storage.atomicReplace([{
      record_id: 'R001', report_text: text, sentences, sectionBreaks,
      llm_extractions: [], validated_findings: [],
      validated: false, validated_at: null, custom_findings_added: [],
      taxonomyVersion: 'CT Head:0', schema_version: 4,
      flagged: true, flag_reason: 'wrong heading',
    }]);
  }, { text: REPORT_TEXT });
  await page.reload();
  await page.waitForFunction(
    () => Alpine.store && Alpine.store('app') && Alpine.store('app').currentView === 'annotate',
    { timeout: 10000 }
  );

  const rows = await page.evaluate(() => {
    const app = Alpine.store('app');
    return app._buildFindingRows(app.report);
  });
  expect(rows).toHaveLength(1);
  expect(rows[0].status).toBe('report_flagged');
  expect(rows[0].report_flagged).toBe(true);
  expect(rows[0].report_flag_reason).toBe('wrong heading');
  expect(rows[0].finding_name).toBe(''); // finding columns blank
  expect(rows[0].flagged).toBe(false);
});

// ---- Step 5: whole-exam flag ----

// ---- Step 8: round-trip (JSON session export → re-import) ----

test('JSON session round-trip preserves confidence, finding flag, and exam flag', async ({ page }) => {
  await seedOneFinding(page, {
    flagged: true,
    flag_reason: 'finding reason',
    attributes: { presence: 'present', chronicity: 'acute' },
    confidence: { chronicity: 'hedged' },
  }, { flagged: true, flag_reason: 'exam reason' });

  const { text } = await captureDownload(page, () =>
    page.evaluate(() => Alpine.store('app').exportSession()));

  // restoreSession ends with _loadSession() (navigates); atomicReplace persists
  // first, so swallow only the navigation error and read back from Storage.
  try {
    await page.evaluate(async (json) => {
      const file = new File([json], 'session.json', { type: 'application/json' });
      await Alpine.store('app').restoreSession(file);
    }, text);
  } catch (e) {
    if (!/context was destroyed|navigation/i.test(e.message)) throw e;
  }

  await expect(async () => {
    const r = await page.evaluate(() => Storage.loadReport('R001'));
    expect(r.flagged).toBe(true);
    expect(r.flag_reason).toBe('exam reason');
    const f = r.validated_findings[0];
    expect(f.confidence.chronicity).toBe('hedged');
    expect(f.flagged).toBe(true);
    expect(f.flag_reason).toBe('finding reason');
  }).toPass();
});

// ---- Step 5: whole-exam flag ----

test('whole-exam flag + reason persist across reload', async ({ page }) => {
  await seedOneFinding(page);
  await page.locator('button:has-text("Flag exam")').click();
  const reason = page.locator('input[placeholder^="why is this exam"]');
  await expect(reason).toBeVisible();
  await reason.fill('Omar mismap: ILD → pulmonary fibrosis');
  await reason.blur();
  await expect(async () => {
    const r = await page.evaluate(() => Storage.loadReport('R001'));
    expect(r.flagged).toBe(true);
    expect(r.flag_reason).toBe('Omar mismap: ILD → pulmonary fibrosis');
  }).toPass();

  await page.reload();
  await page.waitForFunction(
    () => Alpine.store && Alpine.store('app') && Alpine.store('app').currentView === 'annotate',
    { timeout: 10000 }
  );
  await expect(page.locator('button:has-text("Exam flagged")')).toBeVisible();
  await expect(page.locator('input[placeholder^="why is this exam"]')).toHaveValue('Omar mismap: ILD → pulmonary fibrosis');
});
