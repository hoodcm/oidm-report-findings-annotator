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
      app.report.findings.push({ status: 'validated',
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
      app.report.findings.push({ status: 'pending',
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

  test('unanchored validated finding is excluded from the export; anchored one is retained with report_validated=true', async ({ page }) => {
    // A validated report with one anchored finding and one whose
    // source_sentence_idx is null (e.g. an impression grade demoted by
    // migration). The unanchored one has no ground-truth sentence anchor and
    // must not reach the training-data export; the anchored one must.
    await page.evaluate(async () => {
      const app = Alpine.store('app');
      app.report.findings.push({ status: 'validated',
        finding_name: 'acute infarct',
        taxonomy_id: 'HID005',
        source_sentence_idx: 1,
        source_text: 'No acute infarct.',
        attributes: { presence: 'absent' },
      });
      app.report.findings.push({ status: 'validated',
        finding_name: 'orphan finding',
        source_sentence_idx: null, // demoted / unanchored
        source_text: 'text that lived in the impression',
        attributes: { presence: 'present' },
      });
      app.report.validated = true;
      await app._saveCurrentReport();
    });

    const { text } = await captureDownload(page, () =>
      page.evaluate(() => Alpine.store('app').exportTrainingData())
    );

    // Should-fire / shouldn't-fire pair: anchored retained, unanchored excluded.
    expect(text).toContain('R001,validated,acute infarct');
    expect(text).not.toContain('orphan finding');

    // The retained row still carries report_validated=true.
    const rows = text.replace(/^﻿/, '').split('\n').filter(Boolean);
    const header = rows[0].split(',');
    const rvIdx = header.indexOf('report_validated');
    const dataRow = rows.find(r => r.includes('acute infarct'));
    expect(dataRow.split(',')[rvIdx]).toBe('true');
  });

  test('presence_3class (D7): hedged presence exports "uncertain", definite presence exports the polarity', async ({ page }) => {
    await page.evaluate(async () => {
      const app = Alpine.store('app');
      app.report.findings.push({ status: 'validated',
        finding_name: 'acute infarct', taxonomy_id: 'HID005',
        source_sentence_idx: 1, source_text: 'No acute infarct.',
        attributes: { presence: 'present' },
        confidence: { presence: 'hedged' }, // "possible" — ◐
      });
      app.report.findings.push({ status: 'validated',
        finding_name: 'mass effect',
        source_sentence_idx: 2, source_text: 'No mass effect.',
        attributes: { presence: 'present' }, // "present" — ●, no hedge
      });
      await app._saveCurrentReport();
    });
    const rows = await page.evaluate(() => {
      const app = Alpine.store('app');
      return app._buildFindingRows(app.report);
    });
    const hedged = rows.find(r => r.finding_name === 'acute infarct');
    const definite = rows.find(r => r.finding_name === 'mass effect');
    expect(hedged.presence).toBe('present');
    expect(hedged.presence_3class).toBe('uncertain');
    expect(definite.presence).toBe('present');
    expect(definite.presence_3class).toBe('present');
  });
});
