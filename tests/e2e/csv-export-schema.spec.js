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

  // The section column must carry the enclosing LARGE section (subheader
  // breaks are skipped — the subheader travels as the sentence's own prefix),
  // and matched_sentence_text must be the sentence WITHOUT that prefix.
  // Value-level assertions — header presence alone proved too weak.
  test('section column walks past subheaders to the enclosing large section; matched_sentence_text strips the subheader prefix', async ({ page }) => {
    const rows = await page.evaluate(() => {
      const app = Alpine.store('app');
      const report = {
        record_id: 'SECT1',
        report_text: 'x',
        taxonomyVersion: 'CT Head:0',
        sentences: [
          'No acute infarct.',                    // idx 1 — under HEAD:
          'Devices: Lines and tubes in place.',   // idx 2 — HEAD: > Devices: subheader
          'Alignment is normal.',                 // idx 3 — under CERVICAL SPINE:
        ],
        sectionBreaks: [
          { before: 0, header: 'HEAD:', sub: false },
          { before: 1, header: 'Devices:', sub: true },
          { before: 2, header: 'CERVICAL SPINE:', sub: false },
        ],
        validated: false,
        findings: [
          { status: 'pending', finding_name: 'f-head', source_sentence_idx: 1, attributes: { presence: 'absent' } },
          { status: 'pending', finding_name: 'f-sub', source_sentence_idx: 2, attributes: { presence: 'present' } },
          { status: 'pending', finding_name: 'f-spine', source_sentence_idx: 3, attributes: { presence: 'absent' } },
        ],
      };
      return app._buildFindingRows(report);
    });

    const byName = Object.fromEntries(rows.map(r => [r.finding_name, r]));
    expect(byName['f-head'].section).toBe('HEAD:');
    // The subheader break is skipped: the enclosing large section is HEAD:,
    // and the sentence's own "Devices:" prefix is stripped from the text.
    expect(byName['f-sub'].section).toBe('HEAD:');
    expect(byName['f-sub'].matched_sentence_text).toBe('Lines and tubes in place.');
    expect(byName['f-spine'].section).toBe('CERVICAL SPINE:');
    expect(byName['f-head'].matched_sentence_text).toBe('No acute infarct.');
  });

  // Passthrough columns export the finding's stored values verbatim.
  test('origin / was_modified / is_custom / taxonomy_version export verbatim', async ({ page }) => {
    const row = await page.evaluate(() => {
      const app = Alpine.store('app');
      const report = {
        record_id: 'PT1', report_text: 'x', taxonomyVersion: 'CT Head:12345',
        sentences: ['One.'], sectionBreaks: [], validated: false,
        findings: [{
          status: 'validated', finding_name: 'f1', source_sentence_idx: 1,
          origin: 'llm_extraction', was_modified: true, is_custom: true,
          attributes: { presence: 'present' },
        }],
      };
      return app._buildFindingRows(report)[0];
    });
    expect(row.origin).toBe('llm_extraction');
    expect(row.was_modified).toBe(true);
    expect(row.is_custom).toBe(true);
    expect(row.taxonomy_version).toBe('CT Head:12345');
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
