// Session format v2 (C3). Export carries the full taxonomyMeta record so a
// session restores on a clean machine with working search and STABLE
// taxonomyVersion provenance (saveTaxonomyMeta preserves loadedAt). v1 files
// still restore (with a "no taxonomy" warning); a corrupted taxonomy block is
// non-fatal — the reports still restore.

const { test, expect } = require('@playwright/test');
const { gotoApp, resetIndexedDb, captureDownload, expectToast } = require('./helpers');

const TAX = [{ id: 'HID001', name: 'cerebral edema', synonyms: ['brain swelling'], category: 'brain', parent_id: null, finding_type: 'observation' }];

test.describe('Session format v2', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await resetIndexedDb(page);
  });

  test('v2 round-trip preserves taxonomy loadedAt and taxonomyVersion provenance across a clean-machine restore', async ({ page }) => {
    // Machine A: a taxonomy (mints loadedAt=T) + a report stamped examType:T.
    await page.evaluate(async (tax) => {
      await Storage.saveTaxonomy('CT Head', 'ct-head-findings-taxonomy.csv', tax, false);
    }, TAX);
    const T = await page.evaluate(async () => (await Storage.loadTaxonomy()).loadedAt);
    await page.evaluate(async (tv) => {
      await Storage.atomicReplace([{
        record_id: 'R1', report_text: 'FINDINGS:\n- x.', sentences: ['x.'], sectionBreaks: [],
        findings: [], validated: false, validated_at: null, taxonomyVersion: tv, schema_version: 7,
      }]);
    }, `CT Head:${T}`);

    const { text: sessionJson } = await captureDownload(page, () =>
      page.evaluate(() => Alpine.store('app').exportSession()));
    const parsed = JSON.parse(sessionJson);
    expect(parsed.version).toBe(2);
    expect(parsed.taxonomy.loadedAt).toBe(T);

    // Machine B: wipe everything, then restore from the v2 file.
    await resetIndexedDb(page);
    await page.evaluate(async (json) => {
      const f = new File([json], 's.json', { type: 'application/json' });
      await Alpine.store('app').restoreSession(f);
    }, sessionJson);

    const after = await page.evaluate(async () => {
      const t = await Storage.loadTaxonomy();
      const r = await Storage.loadReport('R1');
      return { loadedAt: t.loadedAt, findingCount: t.findings.length, reportTV: r.taxonomyVersion, newStamp: `${t.examType}:${t.loadedAt}` };
    });
    expect(after.loadedAt).toBe(T);              // loadedAt preserved verbatim
    expect(after.findingCount).toBeGreaterThan(0); // search taxonomy present
    expect(after.reportTV).toBe(`CT Head:${T}`);  // restored report keeps its stamp
    expect(after.newStamp).toBe(after.reportTV);  // a report added now stamps the SAME version
  });

  test('a v1 session restores with a "no taxonomy" warning', async ({ page }) => {
    const v1 = JSON.stringify({
      version: 1, created_at: '2025-01-01T00:00:00Z',
      reports: [{ record_id: 'L1', report_text: 'FINDINGS:\n- x.', validated_findings: [], llm_extractions: [], validated: false }],
    });
    await page.evaluate(async (json) => {
      const f = new File([json], 'v1.json', { type: 'application/json' });
      await Alpine.store('app').restoreSession(f);
    }, v1);
    await expectToast(page, 'no taxonomy');
    expect(await page.evaluate(async () => (await Storage.listReportIds()))).toContain('L1');
  });

  // Regression (M3): entries without a valid record_id are filtered out, the
  // valid ones still restore, and the toast names the skip count.
  test('restore filters entries lacking record_id and reports the skip count', async ({ page }) => {
    const mixed = JSON.stringify({
      version: 1, created_at: 'x',
      reports: [
        { record_id: 'GOOD1', report_text: 'FINDINGS:\n- x.', sentences: ['x.'], sectionBreaks: [], findings: [], validated: false, schema_version: 7 },
        { record_id: null, report_text: 'orphan' },      // no id → skipped
        { record_id: 'GOOD2', report_text: 'FINDINGS:\n- y.', sentences: ['y.'], sectionBreaks: [], findings: [], validated: false, schema_version: 7 },
      ],
    });
    await page.evaluate(async (json) => {
      const f = new File([json], 'mixed.json', { type: 'application/json' });
      await Alpine.store('app').restoreSession(f);
    }, mixed);
    await expectToast(page, '1 invalid entries skipped');
    expect(await page.evaluate(async () => await Storage.listReportIds())).toEqual(['GOOD1', 'GOOD2']);
  });

  test('an all-invalid session restores nothing and leaves existing data untouched', async ({ page }) => {
    await page.evaluate(async () => {
      await Storage.importReports([{ record_id: 'KEEP1', report_text: 'FINDINGS:\n- x.', sentences: ['x.'], sectionBreaks: [], findings: [], validated: false, schema_version: 7 }]);
    });
    const bad = JSON.stringify({ version: 1, created_at: 'x', reports: [{ report_text: 'no id' }, null] });
    await page.evaluate(async (json) => {
      const f = new File([json], 'bad.json', { type: 'application/json' });
      await Alpine.store('app').restoreSession(f);
    }, bad);
    await expectToast(page, 'No valid reports');
    expect(await page.evaluate(async () => await Storage.listReportIds())).toEqual(['KEEP1']);
  });

  // Regression (Plan-2): restoring a session that carries NO data_assets must
  // drop a previously-loaded .idm bundle's vocabulary — otherwise the restored
  // corpus is silently governed (and exported) under the wrong enum set.
  test('restoring a plain session after an .idm clears the bundle vocabulary', async ({ page }) => {
    await page.evaluate(async () => {
      // Simulate a loaded bundle: a persisted 'attributes' asset governs.
      await Storage.saveDataAsset({ name: 'attributes', payload: { presence: { values: ['present'] } }, version: 'bundle:1' });
    });
    const plain = JSON.stringify({
      version: 1, created_at: 'x',
      reports: [{ record_id: 'P1', report_text: 'FINDINGS:\n- x.', sentences: ['x.'], sectionBreaks: [], findings: [], validated: false, schema_version: 7 }],
    });
    await page.evaluate(async (json) => {
      const f = new File([json], 'plain.json', { type: 'application/json' });
      await Alpine.store('app').restoreSession(f);
    }, plain);
    const after = await page.evaluate(async () => ({
      bundleAttr: await Storage.getDataAsset('attributes'),
      // The in-memory schema reverted to the repo default (non-null config
      // with more than the bundle's single presence key).
      cfgKeys: Object.keys(Alpine.store('app').attributeConfig || {}),
      ids: await Storage.listReportIds(),
    }));
    expect(after.bundleAttr).toBeNull();
    expect(after.ids).toEqual(['P1']);
    expect(after.cfgKeys.length).toBeGreaterThan(1); // repo default governs again
  });

  // Regression (v1.7.1): the safety snapshot restoreSession takes must capture
  // the TRUE pre-restore state — the old reports WITH the old taxonomy. The
  // old ordering wrote the incoming session's taxonomy/assets first and
  // snapshotted afterward, so undoing a session restore silently put the old
  // reports under the incoming session's vocabulary.
  test('the pre-restore snapshot pairs old reports with the OLD taxonomy', async ({ page }) => {
    // Current state: taxonomy OLD governing report OLD1.
    await page.evaluate(async (tax) => {
      await Storage.saveTaxonomy('CT Head', 'old-taxonomy.csv', tax, false);
      await Storage.importReports([{
        record_id: 'OLD1', report_text: 'FINDINGS:\n- x.', sentences: ['x.'], sectionBreaks: [],
        findings: [], validated: false, validated_at: null, schema_version: 7,
      }]);
    }, TAX);

    // Incoming v2 session: taxonomy NEW + report NEW1.
    const v2 = JSON.stringify({
      version: 2, created_at: 'x',
      taxonomy: { id: 1, examType: 'CXR', sourceFilename: 'new-taxonomy.csv', isDefault: false, findings: TAX, loadedAt: 123 },
      reports: [{ record_id: 'NEW1', report_text: 'FINDINGS:\n- y.', sentences: ['y.'], sectionBreaks: [], findings: [], validated: false, schema_version: 7 }],
    });
    await page.evaluate(async (json) => {
      const f = new File([json], 's.json', { type: 'application/json' });
      await Alpine.store('app').restoreSession(f);
    }, v2);

    const snap = await page.evaluate(async () => {
      const b = await Storage._db.backups.orderBy('id').reverse().first();
      return {
        label: b.label,
        reportIds: (b.reports || []).map(r => r.record_id),
        taxonomyFile: b.taxonomyMeta ? b.taxonomyMeta.sourceFilename : null,
        liveIds: await Storage.listReportIds(),
      };
    });
    expect(snap.liveIds).toEqual(['NEW1']);            // the restore itself worked
    expect(snap.reportIds).toEqual(['OLD1']);          // snapshot holds the old reports...
    expect(snap.taxonomyFile).toBe('old-taxonomy.csv'); // ...under the OLD taxonomy
    expect(snap.label).toBe('before-restore');
  });

  test('a v2 session with a corrupted taxonomy block still restores the reports', async ({ page }) => {
    const v2 = JSON.stringify({
      version: 2, created_at: 'x', taxonomy: 'not-an-object',
      reports: [{ record_id: 'C1', report_text: 'FINDINGS:\n- x.', sentences: ['x.'], sectionBreaks: [], findings: [], validated: false, schema_version: 7 }],
    });
    await page.evaluate(async (json) => {
      const f = new File([json], 'v2.json', { type: 'application/json' });
      await Alpine.store('app').restoreSession(f);
    }, v2);
    expect(await page.evaluate(async () => (await Storage.listReportIds()))).toContain('C1');
  });
});
