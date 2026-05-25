// Three small sidebar / center-panel affordances added together:
//
//   1. goToNextUnvalidated distinguishes "no other unvalidated reports"
//      (current is the only one) from "all reports validated" (true success).
//      Previously the loop started at offset=1 and never checked the current
//      report, so a session of one unvalidated report falsely showed
//      "All reports validated!".
//   2. Sidebar shows "X/Y sentences with findings" using distinct
//      source_sentence_idx values from validated_findings (matches the green
//      sentence highlight semantics already used in the body).
//   3. Center panel renders a "No annotatable text found" placeholder when
//      the splitter extracts zero sentences (instead of an empty void), and
//      hides the click-to-edit subtitle + colour legend in that state.

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

  test('Sidebar progress label shows "0/N sentences with findings" before any work', async ({ page }) => {
    await seedTaxonomy(page);
    await seedReports(page, ['R001']);

    const label = page.locator('aside p.text-xs.text-gray-400');
    await expect(label).toContainText(/^0\/\d+ sentences with findings$/);

    // Sanity-check N matches the parsed sentence count.
    const expectedN = await page.evaluate(() => Alpine.store('app').report.sentences.length);
    await expect(label).toContainText(`0/${expectedN} sentences with findings`);
  });

  test('Sidebar progress label increments distinct sentences as findings get validated', async ({ page }) => {
    await seedTaxonomy(page);
    await seedReports(page, ['R001']);

    // Validate two findings on sentence 1 + one finding on sentence 2.
    // Three validated findings, but only two distinct sentence indices → expect "2/N".
    await page.evaluate(() => {
      const app = Alpine.store('app');
      const stamp = new Date().toISOString();
      app.report.validated_findings.push(
        { finding_name: 'edema',   source_text: 'a', source_sentence_idx: 1, attributes: { presence: 'present' }, validated_at: stamp },
        { finding_name: 'sdh',     source_text: 'b', source_sentence_idx: 1, attributes: { presence: 'present' }, validated_at: stamp },
        { finding_name: 'infarct', source_text: 'c', source_sentence_idx: 2, attributes: { presence: 'present' }, validated_at: stamp },
      );
    });

    const expectedN = await page.evaluate(() => Alpine.store('app').report.sentences.length);
    const label = page.locator('aside p.text-xs.text-gray-400');
    await expect(label).toContainText(`2/${expectedN} sentences with findings`);
  });

  test('Sidebar progress label rejects non-integer source_sentence_idx (restored-data shape)', async ({ page }) => {
    // Review-flagged regression: a bare `idx >= 1 && idx <= max` lets a string
    // "1" and a number 1 land in the Set as separate entries, inflating the
    // numerator above the denominator. Number.isInteger() must screen them out.
    await seedTaxonomy(page);
    await seedReports(page, ['R001']);

    await page.evaluate(() => {
      const app = Alpine.store('app');
      const stamp = new Date().toISOString();
      app.report.validated_findings.push(
        { finding_name: 'real',  source_text: 'a', source_sentence_idx: 1,    attributes: { presence: 'present' }, validated_at: stamp },
        { finding_name: 'str',   source_text: 'b', source_sentence_idx: '1',  attributes: { presence: 'present' }, validated_at: stamp },
        { finding_name: 'flt',   source_text: 'c', source_sentence_idx: 1.5,  attributes: { presence: 'present' }, validated_at: stamp },
        { finding_name: 'huge',  source_text: 'd', source_sentence_idx: 999,  attributes: { presence: 'present' }, validated_at: stamp },
        { finding_name: 'zero',  source_text: 'e', source_sentence_idx: 0,    attributes: { presence: 'present' }, validated_at: stamp },
      );
    });

    const N = await page.evaluate(() => Alpine.store('app').report.sentences.length);
    const count = await page.evaluate(() => Alpine.store('app').annotatedSentenceCount());
    // Only the integer-1 finding should count. Numerator never exceeds N.
    expect(count).toBe(1);
    expect(count).toBeLessThanOrEqual(N);
  });

  test('Empty report: center panel shows "No annotatable text found" when splitter yields zero sentences', async ({ page }) => {
    await seedTaxonomy(page);

    // Seed a single report whose sentences array is empty (legitimately —
    // upstream parser found no findings text). Reload so init() picks it up.
    await page.evaluate(async () => {
      const SCHEMA_VERSION = 4;
      await Storage.atomicReplace([{
        record_id: 'R_EMPTY',
        report_text: 'IMPRESSION: see above.',
        sentences: [],
        sectionBreaks: [],
        llm_extractions: [],
        validated_findings: [],
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

    // Progress label correctly reports 0/0.
    await expect(page.locator('aside p.text-xs.text-gray-400')).toContainText('0/0 sentences with findings');
  });

  test('Empty report: Add Finding panel is hidden so users cannot create unanchored findings', async ({ page }) => {
    // Adversarial review surfaced the underlying bug: addFinding on a
    // zero-sentence report saved with source_sentence_idx null, leaving the
    // finding invisible to every validated-findings panel (all keyed off
    // selectedSentenceIdx). UI fix: hide the affordance entirely. Logic
    // guard (next test) catches programmatic callers.
    await seedTaxonomy(page);
    await page.evaluate(async () => {
      const SCHEMA_VERSION = 4;
      await Storage.atomicReplace([{
        record_id: 'R_EMPTY', report_text: 'IMPRESSION: see above.',
        sentences: [], sectionBreaks: [], llm_extractions: [], validated_findings: [],
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
      const SCHEMA_VERSION = 4;
      await Storage.atomicReplace([{
        record_id: 'R_EMPTY', report_text: 'IMPRESSION: see above.',
        sentences: [], sectionBreaks: [], llm_extractions: [], validated_findings: [],
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
    const count = await page.evaluate(() => Alpine.store('app').report.validated_findings.length);
    expect(count).toBe(0);
  });

  test('addFinding guard: non-empty report with no sentence selected refuses to save', async ({ page }) => {
    await seedTaxonomy(page);
    await seedReports(page, ['R001']);

    // Clear any selection that may have happened during init / restore.
    await page.evaluate(() => { Alpine.store('app').selectedSentenceIdx = null; });

    await page.evaluate(() => Alpine.store('app').addFinding('cerebral edema', false));
    await expectToast(page, 'no sentence selected');

    const count = await page.evaluate(() => Alpine.store('app').report.validated_findings.length);
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
      app.report.validated_findings.push(
        { finding_name: 'cerebral edema', source_text: '', source_sentence_idx: null,
          attributes: { presence: 'present' }, validated_at: stamp, origin: 'human_added' },
        // String-shaped index also counts as unassigned (defends against
        // restored-data malformation; consistent with annotatedSentenceCount).
        { finding_name: 'midline shift', source_text: 'x', source_sentence_idx: '2',
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
});
