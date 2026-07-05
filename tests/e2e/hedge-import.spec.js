// Confidence (hedge) carry-through across the import → validated pipeline, and
// the guess-map root fix that keeps a `<axis>_confidence` column from being
// auto-mapped onto its canonical attribute.
// Plan: docs/plans/2026-07-01-attribute-hedge-and-flagging-plan.md (Step 7 d/e).

const { test, expect } = require('@playwright/test');
const { gotoApp, resetIndexedDb, seedTaxonomy, seedReports } = require('./helpers');

// Drive the import flow end-to-end against an in-memory payload, mapping the
// columns the test needs (confidence is read from raw row keys, not the map).
async function runImport(page, payload, columnMap) {
  try {
    await page.evaluate(async ({ payload, columnMap }) => {
      const app = Alpine.store('app');
      app.extractionData = payload;
      app.extractionFields = Object.keys(payload[0] || {});
      app.extractionColumnMap = columnMap;
      app.recordIds = ['R001'];
      await app.runExtractionValidation();
      await app.processExtractionImport();
      await app.confirmExtractionImport();
    }, { payload, columnMap });
  } catch (e) {
    // confirmExtractionImport ends with _loadSession(), whose chained
    // history.pushState can detach this evaluate's handle mid-run (a known
    // E2E gotcha in this suite). The report is saved BEFORE that navigation, so the
    // data is already persisted — swallow only the navigation error and let the
    // caller read the result back from Storage.
    if (!/context was destroyed|navigation/i.test(e.message)) throw e;
  }
}

const MAP = {
  record_id: 'record_id', finding_name: 'finding_name', source_text: 'source_text',
  presence: 'presence', chronicity: 'chronicity',
};

test.describe('Confidence carries through import → accept → export', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await resetIndexedDb(page);
    await seedTaxonomy(page);
    await seedReports(page, ['R001']);
    await page.waitForFunction(() => Alpine.store('app').currentView === 'annotate');
  });

  test('acceptFinding keeps a hedged pending extraction hedged', async ({ page }) => {
    await page.evaluate(async () => {
      const app = Alpine.store('app');
      app.selectedSentenceIdx = 1;
      app.report.findings.push({
        finding_name: 'acute infarct', status: 'pending', source_sentence_idx: 1, source_text: 'No acute infarct.',
        attributes: { presence: 'present', chronicity: 'acute' },
        confidence: { chronicity: 'hedged' },
      });
      await app._saveCurrentReport();
      await app.acceptFinding(0);
    });
    const vf = await page.evaluate(async () =>
      (await Storage.loadReport('R001')).findings.find(f => /infarct/.test(f.finding_name)));
    expect(vf.confidence.chronicity).toBe('hedged');
  });

  test('re-import fills a not-yet-set hedged axis on an existing validated finding', async ({ page }) => {
    // Pre-validate a finding whose chronicity is empty; re-import supplies it hedged.
    await page.evaluate(async () => {
      const app = Alpine.store('app');
      app.report.findings.push({
        finding_name: 'acute infarct', status: 'validated', taxonomy_id: 'HID005', source_sentence_idx: 1,
        source_text: 'No acute infarct.', origin: 'llm', was_modified: false, is_custom: false,
        attributes: { presence: 'absent' }, // no chronicity yet
      });
      await app._saveCurrentReport();
    });
    await runImport(page, [{
      record_id: 'R001', finding_name: 'acute infarct', source_text: 'No acute infarct.',
      presence: 'absent', chronicity: 'acute', confidence: '{"chronicity":"hedged"}',
    }], MAP);
    await expect(async () => {
      const vf = await page.evaluate(async () =>
        (await Storage.loadReport('R001')).findings.find(f => /infarct/.test(f.finding_name)));
      // chronicity is multi-value (D5) — the parser emits an array even for a
      // single value.
      expect(vf.attributes.chronicity).toEqual(['acute']);
      expect(vf.confidence.chronicity).toBe('hedged');
    }).toPass();
  });

  test('CSV import → accept → CSV export carries confidence end-to-end (Step 8)', async ({ page }) => {
    // Import an unmatched row carrying a hedge → lands as a pending extraction.
    await runImport(page, [{
      record_id: 'R001', finding_name: 'mass effect', source_text: 'No mass effect.',
      presence: 'present', chronicity: 'acute', confidence: '{"chronicity":"hedged"}',
    }], MAP);

    // Wait for the pending extraction to surface on the (reloaded) report.
    await page.waitForFunction(() =>
      Alpine.store('app').report
      && (Alpine.store("app").report.findings || []).some(e => e.status === "pending" && /mass/.test(e.finding_name)),
      { timeout: 10000 });

    // Accept it, then export the training CSV rows.
    await page.evaluate(async () => {
      const app = Alpine.store('app');
      const idx = app.report.findings.findIndex(e => e.status === "pending" && /mass/.test(e.finding_name));
      app.selectedSentenceIdx = app.report.findings[idx].source_sentence_idx || 2;
      await app.acceptFinding(idx);
    });

    await expect(async () => {
      const row = await page.evaluate(async () => {
        const app = Alpine.store('app');
        const rep = await Storage.loadReport('R001');
        return app._buildFindingRows(rep).find(r => /mass/.test(r.finding_name) && r.status === 'validated');
      });
      expect(row).toBeTruthy();
      expect(row.confidence).toBe('{"chronicity":"hedged"}');
    }).toPass();
  });

  test('a presence hedge (presence_confidence=hedged) survives import and reads "possible" (D3)', async ({ page }) => {
    // The workbench polarity+hedge model: a hedged positive imports as present +
    // confidence.presence:'hedged' — no longer stripped at the import boundary.
    await runImport(page, [{
      record_id: 'R001', finding_name: 'acute infarct', source_text: 'No acute infarct.',
      presence: 'present', presence_confidence: 'hedged',
    }], { record_id: 'record_id', finding_name: 'finding_name', source_text: 'source_text', presence: 'presence' });

    await expect(async () => {
      const pend = await page.evaluate(async () =>
        (await Storage.loadReport('R001')).findings.find(f => f.status === 'pending' && /infarct/.test(f.finding_name)));
      expect(pend).toBeTruthy();
      expect(pend.attributes.presence).toBe('present');
      expect(pend.confidence.presence).toBe('hedged');
    }).toPass();
    // Its spectrum cell reads "possible" with the present+hedged icon.
    expect(await page.evaluate(() => {
      const f = (Alpine.store('app').report.findings || []).find(x => x.status === 'pending' && /infarct/.test(x.finding_name));
      return Alpine.store('app').presenceCellDisplay(f);
    })).toBe('possible');
    expect(await page.evaluate(() => {
      const f = (Alpine.store('app').report.findings || []).find(x => x.status === 'pending' && /infarct/.test(x.finding_name));
      return Alpine.store('app').presenceCellIcon(f);
    })).toBe(await page.evaluate(() => Alpine.store('app').presenceOptions().find(o => o.presence === 'present' && o.hedged).icon));
  });

  test('re-import does NOT hedge an axis the annotator already valued (preserve-annotator)', async ({ page }) => {
    await page.evaluate(async () => {
      const app = Alpine.store('app');
      app.report.findings.push({
        finding_name: 'acute infarct', status: 'validated', taxonomy_id: 'HID005', source_sentence_idx: 1,
        source_text: 'No acute infarct.', origin: 'llm', was_modified: false, is_custom: false,
        attributes: { presence: 'absent', chronicity: 'acute' }, // annotator value
      });
      await app._saveCurrentReport();
    });
    // Incoming row rejects the value (chronicity=subacute) but hedges it — must be ignored.
    await runImport(page, [{
      record_id: 'R001', finding_name: 'acute infarct', source_text: 'No acute infarct.',
      presence: 'absent', chronicity: 'subacute', confidence: '{"chronicity":"hedged"}',
    }], MAP);
    await expect(async () => {
      const vf = await page.evaluate(async () =>
        (await Storage.loadReport('R001')).findings.find(f => /infarct/.test(f.finding_name)));
      expect(vf.attributes.chronicity).toBe('acute'); // annotator value survives
      expect(vf.confidence && vf.confidence.chronicity).toBeFalsy(); // and stays un-hedged
    }).toPass();
  });
});

test.describe('Guess-map excludes confidence columns from auto-detection', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await resetIndexedDb(page);
    await seedTaxonomy(page);
    await seedReports(page, ['R001']);
    await page.waitForFunction(() => Alpine.store('app').currentView === 'annotate');
  });

  test('a chronicity_confidence column is not auto-mapped to the chronicity attribute', async ({ page }) => {
    await page.evaluate(async () => {
      const csv = 'record_id,finding_name,presence,source_text,chronicity_confidence\n'
        + 'r1,thing,present,x,hedged\n';
      const file = new File([csv], 'ext.csv', { type: 'text/csv' });
      await Alpine.store('app').handleExtractionCsvUpload(file);
    });
    // map is assigned in a requestAnimationFrame after the view switch.
    await page.waitForFunction(() => Object.keys(Alpine.store('app').extractionColumnMap || {}).length > 0);
    const map = await page.evaluate(() => Alpine.store('app').extractionColumnMap);
    expect(map.record_id).toBe('record_id');   // normal detection still works
    expect(map.chronicity).toBeUndefined();     // NOT stolen by chronicity_confidence
  });
});
