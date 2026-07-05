// Session export/restore round-trip. Two arms:
//
//  - Happy path: build state in the UI, exportSession(), wipe IndexedDB,
//    restoreSession() the exported file, assert the state matches.
//
//  - Legacy session arm (pins IE3 from v1.1.1): restore a JSON session whose
//    reports lack a `sentences` array. The restore path must rebuild sentences
//    from report_text and remap findings via source_text. The IE3 bug was
//    specifically that restoreSession() didn't re-parse sentences from old
//    session files; the app-load migration is covered separately in
//    schema-migration.spec.js.

const { test, expect } = require('@playwright/test');
const { gotoApp, resetIndexedDb, seedTaxonomy, seedReports, captureDownload } = require('./helpers');

test.describe('Session export → restore round-trip', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await resetIndexedDb(page);
  });

  test('happy path: validated findings + taxonomy survive a full round-trip', async ({ page }) => {
    await seedTaxonomy(page);
    await seedReports(page);
    await page.waitForFunction(() => Alpine.store('app').currentView === 'annotate');

    // Build some state: validate R001 with one finding.
    await page.evaluate(async () => {
      const app = Alpine.store('app');
      app.report.findings.push({ status: 'validated',
        finding_name: 'acute infarct',
        source_sentence_idx: 1,
        source_text: 'No acute infarct.',
        attributes: { presence: 'absent' },
      });
      await app._saveCurrentReport();
      await app.toggleValidation();
    });

    // Export.
    const { text: sessionJson } = await captureDownload(page, () =>
      page.evaluate(() => Alpine.store('app').exportSession())
    );

    // Capture pre-restore state for comparison.
    const before = await page.evaluate(async () => {
      const r = await Storage.exportAllReports();
      r.sort((a, b) => a.record_id.localeCompare(b.record_id));
      return r;
    });

    // Wipe and restore via Alpine.store('app').restoreSession.
    await resetIndexedDb(page);
    await page.evaluate(async (json) => {
      const blob = new Blob([json], { type: 'application/json' });
      const file = new File([blob], 'session.json', { type: 'application/json' });
      await Alpine.store('app').restoreSession(file);
    }, sessionJson);

    const after = await page.evaluate(async () => {
      const r = await Storage.exportAllReports();
      r.sort((a, b) => a.record_id.localeCompare(b.record_id));
      return r;
    });

    expect(after.length).toBe(before.length);
    // Validated finding preserved.
    const r001After = after.find(r => r.record_id === 'R001');
    expect(r001After.validated).toBe(true);
    expect(r001After.findings.length).toBe(1);
    expect(r001After.findings[0].finding_name).toBe('acute infarct');
    expect(r001After.findings[0].attributes.presence).toBe('absent');
  });

  test('IE3 legacy-session arm: restoreSession re-parses sentences from report_text', async ({ page }) => {
    await seedTaxonomy(page);
    // Construct a v1-shape legacy session: no `sentences` array on reports;
    // findings reference text by source_text only. The restore path must
    // rebuild sentences and re-link findings.
    const legacy = {
      version: 1,
      created_at: '2025-01-01T00:00:00Z',
      reports: [
        {
          record_id: 'L001',
          report_text:
            'FINDINGS:\nBrain Parenchyma:\n- No acute infarct.\n- Small acute subdural hemorrhage along the left convexity.\nVentricular System:\n- Ventricles are normal.',
          // No `sentences`, no `sectionBreaks` — that's the legacy shape.
          validated_findings: [
            {
              finding_name: 'subdural hemorrhage',
              source_text: 'Small acute subdural hemorrhage along the left convexity.',
              source_sentence_idx: null,
              attributes: { presence: 'present' },
            },
          ],
          llm_extractions: [],
          validated: false,
        },
      ],
    };

    await page.evaluate(async (sessionJson) => {
      const blob = new Blob([sessionJson], { type: 'application/json' });
      const file = new File([blob], 'legacy.json', { type: 'application/json' });
      await Alpine.store('app').restoreSession(file);
    }, JSON.stringify(legacy));

    const loaded = await page.evaluate(async () => await Storage.loadReport('L001'));

    // Sentences were rebuilt.
    expect(loaded.sentences.length).toBeGreaterThan(0);

    // The finding's source_text was relinked to a real 1-based sentence index.
    // (v1 legacy two-array input above was unified to findings[] by the migration.)
    expect(loaded.findings[0].source_sentence_idx).toBeGreaterThan(0);
    expect(loaded.findings[0]._needsReview).not.toBe(true);
  });
});
