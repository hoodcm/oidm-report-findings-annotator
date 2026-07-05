/**
 * Startup pipeline (plan D3/S6):
 *  - a mid-session reload shows the loading view then annotate — the empty
 *    welcome screen never flashes;
 *  - init on a current corpus reads one meta integer, not the corpus (no
 *    full-table read on the reports store — asserted via patched
 *    IDBObjectStore read methods);
 *  - URLs identify reports by ?record=<record_id>, and legacy ?idx=<pos>
 *    URLs still resolve (S6t contract).
 */

const { test, expect } = require('@playwright/test');
const { gotoApp, resetIndexedDb, seedTaxonomy, seedReports } = require('./helpers');

test.describe('Init pipeline', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await resetIndexedDb(page);
  });

  test('mid-session reload never shows the empty welcome view', async ({ page }) => {
    await seedTaxonomy(page);
    await seedReports(page, ['R001', 'R002']);

    // Record every view the store passes through from the earliest possible
    // moment of the next page load.
    await page.addInitScript(() => {
      window.__viewLog = [];
      const poll = () => {
        try {
          const v = window.Alpine && Alpine.store && Alpine.store('app') && Alpine.store('app').currentView;
          if (v && window.__viewLog[window.__viewLog.length - 1] !== v) window.__viewLog.push(v);
        } catch { /* Alpine not up yet */ }
        if (!window.__viewLog.includes('annotate')) requestAnimationFrame(poll);
      };
      requestAnimationFrame(poll);
    });
    await page.reload();
    await page.waitForFunction(() => Alpine.store('app').currentView === 'annotate');

    const log = await page.evaluate(() => window.__viewLog);
    expect(log).not.toContain('welcome');
    expect(log[log.length - 1]).toBe('annotate');
  });

  test('init on a current 200-report corpus issues no full-table read', async ({ page }) => {
    await seedTaxonomy(page);
    // Seed 200 reports directly (current schema) + the schema_meta record a
    // real import would have written.
    await page.evaluate(async () => {
      const reports = [];
      for (let i = 1; i <= 200; i++) {
        reports.push({
          record_id: `P${String(i).padStart(3, '0')}`,
          report_text: 'FINDINGS:\n- No acute abnormality.',
          sentences: ['- No acute abnormality.'],
          sectionBreaks: [],
          findings: [],
          validated: i % 3 === 0,
          validated_at: i % 3 === 0 ? new Date(2026, 0, i % 28 + 1).toISOString() : null,
          custom_findings_added: [],
          extraction_model: null,
          extraction_timestamp: null,
          taxonomyVersion: 'CT Head:0',
          schema_version: 5,
        });
      }
      await Storage.atomicReplace(reports);
      await Storage.saveDataAsset({ name: 'schema_meta', payload: { dataSchemaVersion: 5 } });
    });

    // Count full-table reads (getAll / openCursor on the reports store) from
    // page start. Index reads (validated_at), count(), and keyed get() are
    // allowed; a corpus scan is not.
    await page.addInitScript(() => {
      window.__fullReads = 0;
      const g = IDBObjectStore.prototype.getAll;
      IDBObjectStore.prototype.getAll = function (...a) {
        if (this.name === 'reports') window.__fullReads++;
        return g.apply(this, a);
      };
      const c = IDBObjectStore.prototype.openCursor;
      IDBObjectStore.prototype.openCursor = function (...a) {
        if (this.name === 'reports') window.__fullReads++;
        return c.apply(this, a);
      };
    });
    await page.reload();
    await page.waitForFunction(() => Alpine.store('app').currentView === 'annotate');

    const state = await page.evaluate(() => ({
      fullReads: window.__fullReads,
      total: Alpine.store('app').totalCount,
      validated: Alpine.store('app').validatedCount,
    }));
    expect(state.total).toBe(200);
    expect(state.validated).toBe(66);
    expect(state.fullReads).toBe(0);
  });

  test('URLs use ?record=; navigation pushes record-keyed entries', async ({ page }) => {
    await seedTaxonomy(page);
    await seedReports(page, ['R001', 'R002', 'R003']);

    // Initial load replaced state with the record-keyed URL.
    expect(page.url()).toContain('record=R001');

    await page.evaluate(() => Alpine.store('app').navigateNext());
    await page.waitForFunction(() => Alpine.store('app').currentIdx === 1);
    expect(page.url()).toContain('record=R002');
  });

  test('?record=<id> resolves the report; legacy ?idx=<pos> still works', async ({ page }) => {
    await seedTaxonomy(page);
    await seedReports(page, ['R001', 'R002', 'R003']);

    await page.goto('/?record=R003');
    await page.waitForFunction(() => Alpine.store('app').currentView === 'annotate');
    expect(await page.evaluate(() => Alpine.store('app').report.record_id)).toBe('R003');

    await page.goto('/?idx=1');
    await page.waitForFunction(() => Alpine.store('app').currentView === 'annotate');
    expect(await page.evaluate(() => Alpine.store('app').report.record_id)).toBe('R002');
    // The legacy URL is upgraded in place to the record-keyed form.
    expect(page.url()).toContain('record=R002');
  });
});
