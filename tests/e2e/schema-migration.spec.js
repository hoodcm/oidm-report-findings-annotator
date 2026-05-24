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
            attributes: { presence: 'absent' },
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

    // Sentences were rebuilt.
    expect(after.sentences.length).toBeGreaterThan(0);
    expect(after.schema_version).toBe(4);

    // Matchable finding remapped to a valid sentence index.
    const matched = after.validated_findings.find(f => f.finding_name === 'acute infarct');
    expect(matched.source_sentence_idx).toBeGreaterThan(0);
    expect(matched.source_sentence_idx).toBeLessThanOrEqual(after.sentences.length);
    expect(matched._needsReview).not.toBe(true);

    // Unmatchable finding flagged _needsReview (never deleted).
    const unmatched = after.validated_findings.find(f => f.finding_name === 'mystery finding');
    expect(unmatched._needsReview).toBe(true);
    expect(unmatched.source_sentence_idx).toBe(null);
  });
});
