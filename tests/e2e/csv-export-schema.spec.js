// One-way schema assertion on the training-data CSV export. Pins three
// contracts that have historically been silent failure points:
//   - IE4: UTF-8 BOM prefix (so Windows Excel decodes non-ASCII correctly).
//   - H2:  dynamic attribute columns from `attributeConfig`, not hardcoded.
//   - v1.3.0: custom attributes collapsed into one JSON column.
//
// Treat this as a schema test, not a round-trip — exportAllCsv is a one-way
// training-data export; the import side does not consume it.

const { test, expect } = require('@playwright/test');
const { gotoApp, resetIndexedDb, seedTaxonomy, seedReports, captureDownload } = require('./helpers');

test.describe('Training-data CSV export schema', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await resetIndexedDb(page);
    await seedTaxonomy(page);
    await seedReports(page, ['R001']);
    await page.waitForFunction(() => Alpine.store('app').currentView === 'annotate');
  });

  test('export starts with BOM, contains canonical columns, and serializes custom attrs as JSON', async ({ page }) => {
    // Seed one validated finding (with canonical attrs + custom attrs) and
    // one pending finding so the export has rows from both code paths.
    await page.evaluate(async () => {
      const app = Alpine.store('app');
      app.report.validated_findings.push({
        finding_name: 'acute infarct',
        taxonomy_id: 'HID005',
        source_sentence_idx: 1,
        source_text: 'No acute infarct.',
        origin: 'human_added',
        was_modified: false,
        is_custom: false,
        attributes: {
          presence: 'absent',
          laterality: 'left',
          severity: 'mild',
          // Non-canonical → must land in custom_attributes JSON column.
          weight: '5kg',
          lesion_count: '3',
        },
      });
      app.report.llm_extractions.push({
        finding_name: 'mass effect',
        source_sentence_idx: 2,
        source_text: 'No mass effect.',
        attributes: { presence: 'absent' },
      });
      await app._saveCurrentReport();
    });

    const { bytes, text } = await captureDownload(page, () =>
      page.evaluate(() => Alpine.store('app').exportTrainingData())
    );

    // IE4: UTF-8 BOM.
    expect(bytes[0]).toBe(0xef);
    expect(bytes[1]).toBe(0xbb);
    expect(bytes[2]).toBe(0xbf);

    // Header line contains every canonical column the contract promises.
    const header = text.replace(/^﻿/, '').split('\n')[0];
    for (const col of [
      'record_id', 'finding_name', 'source_text', 'status',
      'matched_sentence_text', 'section', 'taxonomy_version',
      'laterality', 'severity', 'size', 'temporal_status',
      'custom_attributes',
    ]) {
      expect(header).toContain(col);
    }

    // Validated row + pending row both present (statuses differ).
    expect(text).toContain('R001,validated,acute infarct');
    expect(text).toContain('R001,pending,mass effect');

    // Custom-attributes JSON contains both custom keys and their values.
    // PapaParse double-quotes JSON containing commas; weight and count appear inside.
    expect(text).toMatch(/weight/);
    expect(text).toMatch(/5kg/);
    expect(text).toMatch(/lesion_count/);
    expect(text).toMatch(/"3"/);
  });
});
