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
