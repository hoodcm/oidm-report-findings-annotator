// App-load schema migration (v1.3.0). Seed IndexedDB with a report shaped
// like an older schema (no schema_version, sentences derived from a stale
// splitter), reload, and assert _runMigrationIfNeeded rebuilt sentences and
// remapped findings via source_text — flagging _needsReview when a finding's
// source_text no longer locates a sentence.

const { test, expect } = require('@playwright/test');
const { gotoApp, resetIndexedDb, seedTaxonomy } = require('./helpers');

test.describe('App-load schema migration', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await resetIndexedDb(page);
    await seedTaxonomy(page);
  });

  test('stale report gets sentences rebuilt; matchable finding remaps; unmatchable one flagged _needsReview', async ({ page }) => {
    // Seed a "stale" report: no schema_version, no sentences. Findings carry
    // source_text — one that matches a sentence the new splitter produces
    // and one that doesn't.
    await page.evaluate(async () => {
      await Storage.importReports([{
        record_id: 'STALE-1',
        report_text:
          'FINDINGS:\nBrain Parenchyma:\n- No acute infarct.\n- No mass effect.\nVentricular System:\n- Ventricles are normal.',
        validated_findings: [
          {
            finding_name: 'acute infarct',
            source_text: 'No acute infarct.',
            source_sentence_idx: 99,  // obviously wrong (stale index)
            // Legacy attribute vocabulary: old severity enum carried
            // physical-size grades — the v5 migration moves 'small' to extent.
            attributes: { presence: 'absent', severity: 'small' },
          },
          {
            finding_name: 'mystery finding',
            source_text: 'This phrase does not appear in the report at all.',
            source_sentence_idx: 99,
            attributes: { presence: 'indeterminate' },
          },
        ],
        llm_extractions: [],
        validated: false,
        // Intentionally NO schema_version → triggers _runMigrationIfNeeded
      }]);
    });

    // Reload the page; init() runs _runMigrationIfNeeded() on load.
    await page.reload();
    await page.waitForFunction(() => Alpine.store('app').currentView === 'annotate', null, { timeout: 5000 });

    const after = await page.evaluate(async () => await Storage.loadReport('STALE-1'));

    // Sentences were rebuilt; the legacy two-array report unified to findings[]
    // at the current version.
    expect(after.sentences.length).toBeGreaterThan(0);
    expect(after.schema_version).toBe(5);
    expect(Array.isArray(after.findings)).toBe(true);
    expect(after.validated_findings).toBeUndefined();
    expect(after.llm_extractions).toBeUndefined();

    // Matchable finding remapped to a valid sentence index.
    const matched = after.findings.find(f => f.finding_name === 'acute infarct');
    expect(matched.status).toBe('validated');
    expect(matched.source_sentence_idx).toBeGreaterThan(0);
    expect(matched.source_sentence_idx).toBeLessThanOrEqual(after.sentences.length);
    expect(matched._needsReview).not.toBe(true);

    // v5 moved the legacy severity grade onto extent.
    expect(matched.attributes.extent).toBe('small');
    expect(matched.attributes.severity).toBeUndefined();

    // Unmatchable finding flagged _needsReview (never deleted).
    const unmatched = after.findings.find(f => f.finding_name === 'mystery finding');
    expect(unmatched._needsReview).toBe(true);
    expect(unmatched.source_sentence_idx).toBe(null);
  });

  test('impression-anchored validated finding demotes on migration; report stays validated', async ({ page }) => {
    // A v4 report whose findings body carries a real finding AND an IMPRESSION
    // section. One validated finding is anchored to a real findings sentence;
    // the other's source_text lives in the impression. The new stripper (v5)
    // removes the impression from the parsed sentences, so on re-parse the
    // impression finding can no longer re-anchor and must demote to
    // source_sentence_idx = null (surfacing in Unassigned Validated), while the
    // findings-anchored one keeps its index and the report stays validated.
    await page.evaluate(async () => {
      await Storage.importReports([{
        record_id: 'IMP-1',
        report_text:
          'FINDINGS:\nBrain Parenchyma:\n- No acute infarct.\nIMPRESSION:\n- Small mass identified, this is a problem.',
        validated: true,
        validated_at: '2026-07-03T00:00:00Z',
        validated_findings: [
          {
            finding_name: 'acute infarct',
            source_text: 'No acute infarct.',
            source_sentence_idx: 1,
            attributes: { presence: 'absent' },
          },
          {
            finding_name: 'mass',
            source_text: 'Small mass identified',
            source_sentence_idx: 2, // pointed into the impression under the old splitter
            attributes: { presence: 'present' },
          },
        ],
        llm_extractions: [],
        schema_version: 4, // stale → triggers migration to 5
      }]);
    });

    await page.reload();
    await page.waitForFunction(() => Alpine.store('app').currentView === 'annotate', null, { timeout: 5000 });

    const after = await page.evaluate(async () => await Storage.loadReport('IMP-1'));

    // The impression section is gone from the parsed sentences.
    expect(after.sentences.join(' ')).not.toMatch(/Small mass/i);

    // Findings-anchored finding kept a valid index.
    const anchored = after.findings.find(f => f.finding_name === 'acute infarct');
    expect(anchored.source_sentence_idx).toBeGreaterThan(0);
    expect(anchored.source_sentence_idx).toBeLessThanOrEqual(after.sentences.length);

    // Impression finding demoted to null (never deleted) and flagged for review.
    const demoted = after.findings.find(f => f.finding_name === 'mass');
    expect(demoted.source_sentence_idx).toBe(null);
    expect(demoted._needsReview).toBe(true);

    // Report stays validated; the demoted finding surfaces in Unassigned Validated.
    expect(after.validated).toBe(true);
    const unassignedNames = await page.evaluate(() =>
      Alpine.store('app').unassignedValidatedFindings.map(f => f.finding_name)
    );
    expect(unassignedNames).toContain('mass');
  });

  test('no-schema_version two-array report normalizes to floor 4 → v5 fires (not stranded)', async ({ page }) => {
    // The registry selector is `migration.to > version`; a missing schema_version
    // must normalize to 4 (legacy floor) or `5 > undefined` is false and the
    // report is stranded two-array. One finding carries a stale source_sentence_idx
    // to also exercise the remap over the unified findings[].
    await page.evaluate(async () => {
      await Storage.importReports([{
        record_id: 'NOVER-1',
        report_text: 'FINDINGS:\nBrain Parenchyma:\n- No acute infarct.\n- No mass effect.',
        validated_findings: [
          { finding_name: 'acute infarct', source_text: 'No acute infarct.', source_sentence_idx: 42, attributes: { presence: 'absent' } },
        ],
        llm_extractions: [
          { finding_name: 'mass effect', source_text: 'No mass effect.', source_sentence_idx: 7, attributes: { presence: 'absent' } },
        ],
        validated: false,
        // NO schema_version
      }]);
    });
    await page.reload();
    await page.waitForFunction(() => Alpine.store('app').currentView === 'annotate', null, { timeout: 5000 });

    const after = await page.evaluate(async () => await Storage.loadReport('NOVER-1'));
    expect(after.schema_version).toBe(5);
    expect(Array.isArray(after.findings)).toBe(true);
    expect(after.validated_findings).toBeUndefined();
    // Both findings unified with their status; stale indices remapped to valid ones.
    const v = after.findings.find(f => f.finding_name === 'acute infarct');
    const p = after.findings.find(f => f.finding_name === 'mass effect');
    expect(v.status).toBe('validated');
    expect(p.status).toBe('pending');
    expect(v.source_sentence_idx).toBeGreaterThan(0);
    expect(v.source_sentence_idx).toBeLessThanOrEqual(after.sentences.length);
    expect(p.source_sentence_idx).toBeGreaterThan(0);
  });

  test('an already-unified findings[] report migrates idempotently (no double-unify)', async ({ page }) => {
    // A findings[]-shaped report with no schema_version (e.g. a restored old
    // session) re-enters the v5 migration; the unify step must pass it through
    // verbatim rather than wrapping it again or dropping findings.
    await page.evaluate(async () => {
      await Storage.importReports([{
        record_id: 'V5-1',
        report_text: 'FINDINGS:\nBrain Parenchyma:\n- No acute infarct.',
        sentences: ['Brain Parenchyma: - No acute infarct.'],
        sectionBreaks: [],
        findings: [
          { finding_name: 'acute infarct', status: 'validated', source_sentence_idx: 1, source_text: 'No acute infarct.', attributes: { presence: 'absent' } },
        ],
        validated: false,
        taxonomyVersion: 'CT Head:0',
        // NO schema_version → normalizes to floor 4, re-enters v5
      }]);
    });
    await page.reload();
    await page.waitForFunction(() => Alpine.store('app').currentView === 'annotate', null, { timeout: 5000 });

    const after = await page.evaluate(async () => await Storage.loadReport('V5-1'));
    expect(after.schema_version).toBe(5);
    expect(after.findings.length).toBe(1);
    expect(after.findings[0].status).toBe('validated');
    expect(after.validated_findings).toBeUndefined();
    expect(after.llm_extractions).toBeUndefined();
  });

  test('v5 converts indeterminate cue-aware; the review flag survives the remap; banner shows', async ({ page }) => {
    // A published-v4 report with two indeterminate findings whose source_text
    // MATCHES a sentence — so the remap runs on both. The distinct
    // _polarityReview marker must survive the remap (which only clears
    // _needsReview), and a dismissible banner must report the conversions.
    await page.evaluate(async () => {
      await Storage.importReports([{
        record_id: 'IND-1',
        report_text: 'FINDINGS:\nBrain Parenchyma:\n- No acute infarct.\n- Possible small pleural effusion.',
        findings: [
          { finding_name: 'acute infarct', status: 'validated', source_sentence_idx: 1, source_text: 'No acute infarct.', attributes: { presence: 'indeterminate' } },
          { finding_name: 'pleural effusion', status: 'validated', source_sentence_idx: 2, source_text: 'Possible small pleural effusion.', attributes: { presence: 'indeterminate' } },
        ],
        validated: false, taxonomyVersion: 'CT Head:0', schema_version: 4,
      }]);
    });
    await page.reload();
    await page.waitForFunction(() => Alpine.store('app').currentView === 'annotate', null, { timeout: 5000 });

    const after = await page.evaluate(async () => await Storage.loadReport('IND-1'));
    const neg = after.findings.find(f => f.finding_name === 'acute infarct');
    const pos = after.findings.find(f => f.finding_name === 'pleural effusion');

    // Cue-aware polarity: 'No acute infarct.' → absent; 'Possible ...' → present.
    expect(neg.attributes.presence).toBe('absent');
    expect(pos.attributes.presence).toBe('present');
    // Both hedged and flagged; the flag SURVIVED the sentence-remap (matched idx).
    expect(neg.confidence.presence).toBe('hedged');
    expect(pos.confidence.presence).toBe('hedged');
    expect(neg._polarityReview).toBe(true);
    expect(pos._polarityReview).toBe(true);
    expect(neg.source_sentence_idx).toBeGreaterThan(0); // remapped, yet still flagged

    // A dismissible migration banner reports the conversions.
    await expect(page.locator('[data-migration-banner]')).toBeVisible();
    await expect(page.locator('[data-migration-banner]')).toContainText('converted from "indeterminate"');
  });
});
