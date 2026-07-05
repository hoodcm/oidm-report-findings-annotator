// Small sidebar / center-panel affordances:
//
//   1. goToNextUnvalidated distinguishes "no other unvalidated reports"
//      (current is the only one) from "all reports validated" (true success).
//      Previously the loop started at offset=1 and never checked the current
//      report, so a session of one unvalidated report falsely showed
//      "All reports validated!".
//   2. _isSentenceAnchor (Number.isInteger-guarded) decides whether a
//      finding's source_sentence_idx is a real anchor; unassignedValidatedFindings
//      is its exact complement. The floating-workspace redesign retired the
//      sidebar's "X/Y sentences with findings" label (and annotatedSentenceCount,
//      its sole caller) — not every sentence gets a finding, so the metric
//      misled — but the restored-data guard still matters for every other
//      _isSentenceAnchor caller (export, recovery, incomplete-block).
//   3. Center panel renders a "No annotatable text found" placeholder when
//      the splitter extracts zero sentences (instead of an empty void), and
//      hides the click-to-edit subtitle + colour legend in that state.
//   4. The colour legend is a flex-none footer, out of the report column's
//      scrolling area — it stays put at a fixed position as the prose
//      scrolls past it (floating-workspace redesign, step 6).

const { test, expect } = require('@playwright/test');
const { gotoApp, resetIndexedDb, seedTaxonomy, seedReports, expectToast } = require('./helpers');

test.describe('Sidebar + empty-state affordances', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await resetIndexedDb(page);
  });

  test('Next Unvalidated: navigates to next unvalidated report when one exists', async ({ page }) => {
    await seedTaxonomy(page);
    await seedReports(page, ['R001', 'R002', 'R003']);

    // Mark R002 validated; we're sitting on R001 (the first one loaded).
    await page.evaluate(async () => {
      const app = Alpine.store('app');
      await app.navigateTo(1);             // jump to R002
      await app.toggleValidation();        // validate it
      await app.navigateTo(0);             // back to R001
    });

    await page.evaluate(() => Alpine.store('app').goToNextUnvalidated());
    await expect.poll(() => page.evaluate(() => Alpine.store('app').report.record_id)).toBe('R003');
  });

  test('Next Unvalidated: current report is the only unvalidated one → toast says so, no nav', async ({ page }) => {
    await seedTaxonomy(page);
    await seedReports(page, ['R001', 'R002', 'R003']);

    // Validate R002 and R003; sit on R001 (still unvalidated).
    await page.evaluate(async () => {
      const app = Alpine.store('app');
      await app.navigateTo(1); await app.toggleValidation();
      await app.navigateTo(2); await app.toggleValidation();
      await app.navigateTo(0);
    });

    await page.evaluate(() => Alpine.store('app').goToNextUnvalidated());
    await expectToast(page, 'No other unvalidated reports');
    // Should not have navigated away from R001.
    expect(await page.evaluate(() => Alpine.store('app').report.record_id)).toBe('R001');
  });

  test('Next Unvalidated: every report validated → toast "All reports validated!"', async ({ page }) => {
    await seedTaxonomy(page);
    await seedReports(page, ['R001', 'R002']);

    await page.evaluate(async () => {
      const app = Alpine.store('app');
      await app.navigateTo(0); await app.toggleValidation();
      await app.navigateTo(1); await app.toggleValidation();
    });

    await page.evaluate(() => Alpine.store('app').goToNextUnvalidated());
    await expectToast(page, 'All reports validated');
  });

  test('_isSentenceAnchor rejects non-integer source_sentence_idx (restored-data shape)', async ({ page }) => {
    // Review-flagged regression: a bare `idx >= 1 && idx <= max` lets a string
    // "1" and a number 1 land as separate entries, so a malformed shape can
    // silently pass as anchored. Number.isInteger() must screen them out.
    // _isSentenceAnchor now feeds unassignedValidatedFindings (exact
    // complement) rather than the retired annotatedSentenceCount sidebar
    // label, but the guard it protects is unchanged.
    await seedTaxonomy(page);
    await seedReports(page, ['R001']);

    await page.evaluate(() => {
      const app = Alpine.store('app');
      const stamp = new Date().toISOString();
      app.report.findings.push(
        { finding_name: 'real',  status: 'validated', source_text: 'a', source_sentence_idx: 1,    attributes: { presence: 'present' }, validated_at: stamp },
        { finding_name: 'str',   status: 'validated', source_text: 'b', source_sentence_idx: '1',  attributes: { presence: 'present' }, validated_at: stamp },
        { finding_name: 'flt',   status: 'validated', source_text: 'c', source_sentence_idx: 1.5,  attributes: { presence: 'present' }, validated_at: stamp },
        { finding_name: 'huge',  status: 'validated', source_text: 'd', source_sentence_idx: 999,  attributes: { presence: 'present' }, validated_at: stamp },
        { finding_name: 'zero',  status: 'validated', source_text: 'e', source_sentence_idx: 0,    attributes: { presence: 'present' }, validated_at: stamp },
      );
    });

    const unassignedNames = await page.evaluate(() =>
      Alpine.store('app').unassignedValidatedFindings.map(f => f.finding_name));
    // Only the real integer-1 finding is anchored; every malformed shape
    // (string "1", float, out-of-range, zero) falls to "unassigned".
    expect(unassignedNames.sort()).toEqual(['flt', 'huge', 'str', 'zero']);
  });

  test('Empty report: center panel shows "No annotatable text found" when splitter yields zero sentences', async ({ page }) => {
    await seedTaxonomy(page);

    // Seed a single report whose sentences array is empty (legitimately —
    // upstream parser found no findings text). Reload so init() picks it up.
    await page.evaluate(async () => {
      const SCHEMA_VERSION = 7;
      await Storage.atomicReplace([{
        record_id: 'R_EMPTY',
        report_text: 'IMPRESSION: see above.',
        sentences: [],
        sectionBreaks: [],
        findings: [],
        validated: false,
        validated_at: null,
        custom_findings_added: [],
        extraction_model: null,
        extraction_timestamp: null,
        taxonomyVersion: 'CT Head:0',
        schema_version: SCHEMA_VERSION,
      }]);
    });
    await page.reload();
    await page.waitForFunction(() => Alpine.store('app').currentView === 'annotate', null, { timeout: 5000 });

    // Placeholder is visible; the prose block is hidden.
    // `exact: true` dodges the strict-mode trip from the Annotation Guidelines
    // modal, which mentions "No annotatable text found" in quotes as part of
    // its empty-report explainer.
    await expect(page.getByText('No annotatable text found', { exact: true })).toBeVisible();
    await expect(page.locator('text=Click highlighted text to view and edit findings')).toBeHidden();
    await expect(page.locator('text=Validated findings').first()).toBeHidden();  // legend hidden too
  });

  test('Empty report: Add Finding panel is hidden so users cannot create unanchored findings', async ({ page }) => {
    // Adversarial review surfaced the underlying bug: addFinding on a
    // zero-sentence report saved with source_sentence_idx null, leaving the
    // finding invisible to every validated-findings panel (all keyed off
    // selectedSentenceIdx). UI fix: hide the affordance entirely. Logic
    // guard (next test) catches programmatic callers.
    await seedTaxonomy(page);
    await page.evaluate(async () => {
      const SCHEMA_VERSION = 7;
      await Storage.atomicReplace([{
        record_id: 'R_EMPTY', report_text: 'IMPRESSION: see above.',
        sentences: [], sectionBreaks: [], findings: [],
        validated: false, validated_at: null, custom_findings_added: [],
        extraction_model: null, extraction_timestamp: null,
        taxonomyVersion: 'CT Head:0', schema_version: SCHEMA_VERSION,
      }]);
    });
    await page.reload();
    await page.waitForFunction(() => Alpine.store('app').currentView === 'annotate', null, { timeout: 5000 });

    // The "Add Finding" heading and search box must not be visible.
    // Target the h3 specifically — the Annotation Guidelines modal text
    // contains the substring "add findings" so a plain text= locator trips
    // strict mode.
    await expect(page.getByRole('heading', { name: 'Add Finding' })).toBeHidden();
    await expect(page.locator('#finding-search-input')).toBeHidden();
  });

  test('addFinding guard: empty report refuses to save with actionable toast', async ({ page }) => {
    await seedTaxonomy(page);
    await page.evaluate(async () => {
      const SCHEMA_VERSION = 7;
      await Storage.atomicReplace([{
        record_id: 'R_EMPTY', report_text: 'IMPRESSION: see above.',
        sentences: [], sectionBreaks: [], findings: [],
        validated: false, validated_at: null, custom_findings_added: [],
        extraction_model: null, extraction_timestamp: null,
        taxonomyVersion: 'CT Head:0', schema_version: SCHEMA_VERSION,
      }]);
    });
    await page.reload();
    await page.waitForFunction(() => Alpine.store('app').currentView === 'annotate', null, { timeout: 5000 });

    // Call addFinding programmatically — the UI guard already hides the panel,
    // this is the defense-in-depth guard for keyboard shortcuts / future callers.
    await page.evaluate(() => Alpine.store('app').addFinding('cerebral edema', false));
    await expectToast(page, 'no annotatable sentences');

    // No finding should have been written.
    const count = await page.evaluate(() => Alpine.store('app').report.findings.length);
    expect(count).toBe(0);
  });

  test('addFinding guard: non-empty report with no sentence selected refuses to save', async ({ page }) => {
    await seedTaxonomy(page);
    await seedReports(page, ['R001']);

    // Clear any selection that may have happened during init / restore.
    await page.evaluate(() => { Alpine.store('app').selectedSentenceIdx = null; });

    await page.evaluate(() => Alpine.store('app').addFinding('cerebral edema', false));
    await expectToast(page, 'no sentence selected');

    const count = await page.evaluate(() => Alpine.store('app').report.findings.length);
    expect(count).toBe(0);
  });

  test('Recovery: pre-existing null-source_sentence_idx validated findings are surfaced for deletion', async ({ page }) => {
    // Mirrors data corrupted by the old addFinding bug — was written, can't
    // be rendered by any existing panel. The recovery section shows it so
    // the user can delete and re-add against a real sentence.
    await seedTaxonomy(page);
    await seedReports(page, ['R001']);

    await page.evaluate(() => {
      const app = Alpine.store('app');
      const stamp = new Date().toISOString();
      app.report.findings.push(
        { finding_name: 'cerebral edema', status: 'validated', source_text: '', source_sentence_idx: null,
          attributes: { presence: 'present' }, validated_at: stamp, origin: 'human_added' },
        // String-shaped index also counts as unassigned (defends against
        // restored-data malformation via the shared _isSentenceAnchor guard).
        { finding_name: 'midline shift', status: 'validated', source_text: 'x', source_sentence_idx: '2',
          attributes: { presence: 'present' }, validated_at: stamp, origin: 'human_added' },
      );
    });

    // Both surface in the recovery group.
    const unassigned = await page.evaluate(() => Alpine.store('app').unassignedValidatedFindings.length);
    expect(unassigned).toBe(2);

    // Recovery section is visible with its heading.
    await expect(page.locator('text=Unassigned Validated (2)')).toBeVisible();

    // Delete the first one via the store (UI button wires to deleteFinding).
    await page.evaluate(() => {
      const f = Alpine.store('app').unassignedValidatedFindings[0];
      return Alpine.store('app').deleteFinding(f._globalIdx);
    });

    const remaining = await page.evaluate(() => Alpine.store('app').unassignedValidatedFindings.length);
    expect(remaining).toBe(1);
  });

  test('Legend stays pinned at the bottom of the report column while the prose scrolls (floating-workspace redesign)', async ({ page }) => {
    await seedTaxonomy(page);
    // A long report so the prose overflows and actually needs to scroll.
    await page.evaluate(async () => {
      const lines = Array.from({ length: 60 }, (_, i) => `- Finding sentence number ${i + 1} in the report.`).join('\n');
      const text = 'FINDINGS:\nBrain Parenchyma:\n' + lines;
      const findingsText = Sentences.parseFindingsSection(text);
      const { sentences, sectionBreaks } = Sentences.splitIntoSentences(findingsText);
      await Storage.atomicReplace([{
        record_id: 'R001', report_text: text, sentences, sectionBreaks, findings: [],
        validated: false, validated_at: null, custom_findings_added: [],
        extraction_model: null, extraction_timestamp: null,
        taxonomyVersion: 'CT Head:0', schema_version: 7,
      }]);
    });
    await page.reload();
    await page.waitForFunction(() => Alpine.store('app').currentView === 'annotate', { timeout: 10000 });

    const legend = page.locator('text=Validated findings').first();
    const before = await legend.boundingBox();
    await page.locator('.flex-1.overflow-y-auto').first().evaluate(el => { el.scrollTop = el.scrollHeight; });
    await page.waitForTimeout(150);
    const after = await legend.boundingBox();
    expect(after.y).toBe(before.y);
  });
});
