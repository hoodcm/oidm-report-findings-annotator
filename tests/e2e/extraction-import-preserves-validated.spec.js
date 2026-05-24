// Pins IE2 / the v1.3.0 re-import merge contract.
//
// The merge logic in confirmExtractionImport (js/app.js:849) implements the
// following rules — verified against the current source before encoding here:
//
//   1. Re-import preserves existing validated_findings on the report.
//   2. Matched rows (mergeKey = normalized source_text + finding_name) merge
//      into the existing validated finding's attribute set — but only into
//      attributes that are currently empty. Annotator-set values are never
//      overwritten.
//   3. Pending llm_extractions are fully replaced (any prior pending superseded).
//   4. New unmatched rows land in llm_extractions as pending.
//   5. If new pending work exists after the import, a previously-validated
//      report drops out of validated state (validated=false, validated_at=null).

const { test, expect } = require('@playwright/test');
const { gotoApp, resetIndexedDb, seedTaxonomy, seedReports } = require('./helpers');

/**
 * Run the extraction-import flow end-to-end against an in-memory JSON
 * payload. Skips the file picker UI and goes straight through the store
 * methods that the real wizard ultimately calls.
 */
async function runImport(page, payload, recordIds = ['R001']) {
  return page.evaluate(async ({ payload, recordIds }) => {
    const app = Alpine.store('app');
    // Pre-seed Alpine state the wizard would have populated.
    app.extractionData = payload;
    app.extractionFields = Object.keys(payload[0] || {});
    app.extractionColumnMap = {
      record_id: 'record_id',
      finding_name: 'finding_name',
      source_text: 'source_text',
      presence: 'presence',
      laterality: 'laterality',
      severity: 'severity',
    };
    app.recordIds = recordIds;
    await app.runExtractionValidation();
    await app.processExtractionImport();
    await app.confirmExtractionImport();
  }, { payload, recordIds });
}

test.describe('Extraction import preserves validated findings (IE2 / v1.3.0 merge contract)', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await resetIndexedDb(page);
    await seedTaxonomy(page);
    await seedReports(page, ['R001']);
    await page.waitForFunction(() => Alpine.store('app').currentView === 'annotate');

    // Pre-validate R001 with one validated finding that has partial attrs:
    // - presence already set (annotator value → must NOT be overwritten)
    // - laterality empty (must be filled by merge)
    // The source_text matches sentence #1 ("No acute infarct.") in the seed.
    await page.evaluate(async () => {
      const app = Alpine.store('app');
      app.report.validated_findings.push({
        finding_name: 'acute infarct',
        taxonomy_id: 'HID005',
        source_sentence_idx: 1,
        source_text: 'No acute infarct.',
        origin: 'llm',
        was_modified: false,
        is_custom: false,
        attributes: {
          presence: 'absent',  // annotator value — must survive re-import
          // laterality intentionally empty — re-import should fill it
        },
      });
      await app._saveCurrentReport();
      await app.toggleValidation();
    });

    expect(await page.evaluate(() => Alpine.store('app').report.validated)).toBe(true);
  });

  test('matched row merges into empty attributes only; existing values survive', async ({ page }) => {
    // Re-import targets the same (source_text, finding_name) key.
    // The incoming row has presence=present (must NOT overwrite 'absent')
    // and laterality=left (must fill the empty slot).
    await runImport(page, [{
      record_id: 'R001',
      finding_name: 'acute infarct',
      source_text: 'No acute infarct.',
      presence: 'present',     // existing value 'absent' wins
      laterality: 'left',      // existing value is empty → fills
    }]);

    const report = await page.evaluate(async () => await Storage.loadReport('R001'));
    expect(report.validated_findings.length).toBe(1);
    const vf = report.validated_findings[0];
    expect(vf.attributes.presence).toBe('absent');
    expect(vf.attributes.laterality).toBe('left');
    expect(vf.was_modified).toBe(true);
    // The merged row should NOT appear in llm_extractions.
    expect(report.llm_extractions.length).toBe(0);
  });

  test('unmatched new rows land in llm_extractions and unvalidate the report', async ({ page }) => {
    await runImport(page, [{
      record_id: 'R001',
      finding_name: 'mass effect',
      source_text: 'No mass effect.',
      presence: 'absent',
    }]);

    const report = await page.evaluate(async () => await Storage.loadReport('R001'));
    expect(report.validated_findings.length).toBe(1);  // original preserved
    expect(report.llm_extractions.length).toBe(1);     // new row added as pending
    expect(report.llm_extractions[0].finding_name).toBe('mass effect');
    // Report drops out of validated state because new pending work exists.
    expect(report.validated).toBe(false);
    expect(report.validated_at).toBe(null);
  });
});
