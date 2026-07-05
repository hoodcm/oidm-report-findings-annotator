// Taxonomy-wipe guard (B5). Uploading a new taxonomy when reports are loaded:
//  - zero annotations → keep the reports, no confirm, and restamp their
//    taxonomyVersion to the new taxonomy's examType:loadedAt (correct export
//    provenance for the "uploaded the wrong taxonomy" recovery).
//  - annotations present → snapshot a backup first, then confirm + clear.

const { test, expect } = require('@playwright/test');
const { gotoApp, resetIndexedDb, seedTaxonomy, seedReports } = require('./helpers');

const NEW_TAX_CSV =
  'id,name,category,parent_id,synonyms,finding_type\nX1,disc herniation,disc,,herniated disc,observation\n';

async function uploadTaxonomy(page, filename) {
  await page.evaluate(async ({ csv, filename }) => {
    const file = new File([csv], filename, { type: 'text/csv' });
    await Alpine.store('app').handleTaxonomyUpload(file);
  }, { csv: NEW_TAX_CSV, filename });
}

test.describe('Taxonomy swap guard', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await resetIndexedDb(page);
    await seedTaxonomy(page);                       // CT Head
    await seedReports(page, ['R001', 'R002', 'R003']); // zero findings each
  });

  test('unannotated swap keeps reports and restamps taxonomyVersion to the new taxonomy', async ({ page }) => {
    await uploadTaxonomy(page, 'mr-spine-findings-taxonomy.csv');

    const after = await page.evaluate(async () => (await Storage.listReportIds()).sort());
    expect(after).toEqual(['R001', 'R002', 'R003']); // reports survive

    const stamps = await page.evaluate(async () => {
      const tax = await Storage.loadTaxonomy();
      const reports = await Storage.exportAllReports();
      return { expected: `${tax.examType}:${tax.loadedAt}`, actual: reports.map(r => r.taxonomyVersion) };
    });
    expect(stamps.expected).not.toBe('CT Head:0');            // changed from the seed stamp
    for (const s of stamps.actual) expect(s).toBe(stamps.expected); // uniformly restamped to new tax
  });

  test('annotated swap snapshots a backup, then clears on confirm', async ({ page }) => {
    // Add one validated finding so annotationCount > 0.
    await page.evaluate(async () => {
      const app = Alpine.store('app');
      app.report.findings.push({
        finding_name: 'acute infarct', status: 'validated', source_sentence_idx: 1,
        source_text: 'No acute infarct.', attributes: { presence: 'absent' },
      });
      await app._saveCurrentReport();
    });

    // Fire without awaiting: the annotated path awaits the styled confirm,
    // then calls clearAllData → view swap to 'welcome'.
    await page.evaluate(({ csv, filename }) => {
      const file = new File([csv], filename, { type: 'text/csv' });
      Alpine.store('app').handleTaxonomyUpload(file);
    }, { csv: NEW_TAX_CSV, filename: 'mr-spine-findings-taxonomy.csv' });
    await page.click('[data-confirm-accept]'); // the "switch will clear" confirm
    await page.waitForFunction(() => Alpine.store('app').currentView === 'welcome', null, { timeout: 5000 });

    const ids = await page.evaluate(async () => await Storage.listReportIds());
    expect(ids.length).toBe(0); // annotated path cleared

    const backups = await page.evaluate(async () => await Storage.listBackups());
    expect(backups.some(b => b.report_count > 0)).toBe(true); // snapshot exists
  });
});
