// Rolling-backup safety net (A3). A snapshot is taken before every destructive
// replace/clear; only the last 3 are kept; restoring is itself undoable.
// Contracts: Storage.backupNow()/listBackups()/restoreBackup(id); Dexie v3.

const { test, expect } = require('@playwright/test');
const { gotoApp, resetIndexedDb, seedTaxonomy } = require('./helpers');

// Minimal well-formed report body for direct Storage writes.
const mk = (id) =>
  ({ record_id: id, report_text: 'FINDINGS:\n- x.', sentences: ['x.'], sectionBreaks: [],
     validated: false, validated_findings: [], llm_extractions: [], schema_version: 5 });

test.describe('Rolling backups', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await resetIndexedDb(page);
    await seedTaxonomy(page);
  });

  test('a destructive replace snapshots the prior data; restore brings it back', async ({ page }) => {
    const ids = await page.evaluate(async ({ orig, next }) => {
      await Storage.importReports([orig]);        // seed (no snapshot)
      await Storage.atomicReplace([next]);        // snapshots [ORIG], writes [NEW]
      const list = await Storage.listBackups();
      const target = list.find(b => b.report_count > 0);
      await Storage.restoreBackup(target.id);      // brings [ORIG] back
      return (await Storage.listReportIds());
    }, { orig: mk('ORIG'), next: mk('NEW') });

    expect(ids).toContain('ORIG');
    expect(ids).not.toContain('NEW');
  });

  test('backups never exceed 3; the newest snapshot is retained', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const mkR = (id) => ({ record_id: id, report_text: 'x', sentences: [], sectionBreaks: [],
        validated: false, validated_findings: [], llm_extractions: [], schema_version: 5 });
      for (let i = 1; i <= 5; i++) await Storage.atomicReplace([mkR('R' + i)]);
      const list = await Storage.listBackups();          // newest first
      // Restore the most recent snapshot: it captured the pre-R5 state (R4).
      await Storage.restoreBackup(list[0].id);
      return { count: list.length, restored: await Storage.listReportIds() };
    });

    expect(result.count).toBeLessThanOrEqual(3);
    expect(result.restored).toEqual(['R4']);
  });

  // Regression (v1.7.1): the undo snapshot taken by restoreBackup must capture
  // the TRUE pre-restore state — reports WITH their own taxonomy and bundle
  // assets. The old ordering swapped the backup's taxonomy/assets in first and
  // snapshotted afterward, so undoing a restore silently put the pre-restore
  // reports under the restored backup's vocabulary.
  test('undo-of-restore pairs reports with their own taxonomy and assets', async ({ page }) => {
    const result = await page.evaluate(async ({ one, two }) => {
      const T = (name) => [{ id: 'X1', name, synonyms: [], category: 'c', parent_id: null, finding_type: 'observation' }];
      // Era 1: taxonomy T1 + asset A1 govern report ONE.
      await Storage.saveTaxonomy('CT Head', 'era1-taxonomy.csv', T('t1'), false);
      await Storage.saveDataAsset({ name: 'attributes', payload: { marker: 'A1' } });
      await Storage.importReports([one]);
      // Destructive replace: snapshot S1 = { [ONE], era1 taxonomy, A1 }.
      await Storage.atomicReplace([two]);
      // Era 2: taxonomy T2 + asset A2 now govern report TWO.
      await Storage.saveTaxonomy('CXR', 'era2-taxonomy.csv', T('t2'), false);
      await Storage.saveDataAsset({ name: 'attributes', payload: { marker: 'A2' } });

      // Restore S1 (the oldest snapshot). Its undo snapshot must capture the
      // FULL era-2 state, not era-2 reports under era-1 vocabulary.
      const list = await Storage.listBackups();
      await Storage.restoreBackup(list[list.length - 1].id);

      // Undo the restore: newest snapshot back.
      const list2 = await Storage.listBackups();
      await Storage.restoreBackup(list2[0].id);

      const tax = await Storage.loadTaxonomy();
      const attr = await Storage.getDataAsset('attributes');
      return {
        ids: await Storage.listReportIds(),
        taxonomyFile: tax ? tax.sourceFilename : null,
        attrMarker: attr && attr.payload ? attr.payload.marker : null,
      };
    }, { one: mk('ONE'), two: mk('TWO') });

    expect(result.ids).toEqual(['TWO']);
    expect(result.taxonomyFile).toBe('era2-taxonomy.csv');   // era-2 taxonomy rides with era-2 reports
    expect(result.attrMarker).toBe('A2');                    // era-2 bundle asset rides too
  });

  // Regression (v1.7.1): restoring an id that no longer exists (pruned to the
  // newest 3) is a safe no-op — null return, nothing mutated.
  test('restoreBackup of a pruned/unknown id returns null and mutates nothing', async ({ page }) => {
    const result = await page.evaluate(async ({ one }) => {
      await Storage.importReports([one]);
      const before = await Storage.listReportIds();
      const b = await Storage.restoreBackup(999999);
      return { returned: b, ids: await Storage.listReportIds(), before };
    }, { one: mk('ONE') });
    expect(result.returned).toBeNull();
    expect(result.ids).toEqual(result.before);
  });

  test('restoring is itself undoable (restore-into-dirty-state)', async ({ page }) => {
    const mid = await page.evaluate(async ({ one, two }) => {
      await Storage.importReports([one]);   // state [ONE]
      await Storage.atomicReplace([two]);   // snapshot [ONE], state [TWO]
      const list1 = await Storage.listBackups();
      await Storage.restoreBackup(list1[list1.length - 1].id); // restore [ONE]
      return await Storage.listReportIds();
    }, { one: mk('ONE'), two: mk('TWO') });
    expect(mid).toEqual(['ONE']);

    // The restore snapshotted the pre-restore [TWO] state; restoring the newest
    // backup returns to it — the restore was undoable.
    const back = await page.evaluate(async () => {
      const list2 = await Storage.listBackups(); // newest first → [TWO] snapshot
      await Storage.restoreBackup(list2[0].id);
      return await Storage.listReportIds();
    });
    expect(back).toEqual(['TWO']);
  });

  // Regression (v1.7.1): clearAllData lands the user on the welcome screen —
  // the recovery list there must reflect the backups table AS IT IS after the
  // clear (including the just-taken 'before-clear' snapshot), never a stale
  // pre-clear render whose entries may have been pruned.
  test('clear-all refreshes the welcome recovery list to match storage', async ({ page }) => {
    const result = await page.evaluate(async ({ one }) => {
      await Storage.importReports([one]);
      await Alpine.store('app').clearAllData();
      const ui = Alpine.store('app').backups.map(b => b.id);
      const db = (await Storage.listBackups()).map(b => b.id);
      return { ui, db, view: Alpine.store('app').currentView };
    }, { one: mk('ONE') });
    expect(result.view).toBe('welcome');
    expect(result.ui).toEqual(result.db);
    expect(result.ui.length).toBeGreaterThan(0); // the 'before-clear' snapshot is offered
  });

  // Contract: "Delete ALL data" clears the corpus AND the bundle vocabulary,
  // reverts the in-memory schema to the repo default, and lands on welcome.
  test('clear-all wipes reports and bundle assets and reverts to the default schema', async ({ page }) => {
    const result = await page.evaluate(async ({ one }) => {
      await Storage.importReports([one]);
      await Storage.saveDataAsset({ name: 'attributes', payload: { presence: { values: ['present'] } }, version: 'b:1' });
      const app = Alpine.store('app');
      await app.clearAllData();
      return {
        count: await Storage.getReportCount(),
        bundleAttr: await Storage.getDataAsset('attributes'),
        cfgKeys: Object.keys(app.attributeConfig || {}),
        view: app.currentView,
      };
    }, { one: mk('ONE') });
    expect(result.count).toBe(0);
    expect(result.bundleAttr).toBeNull();
    expect(result.cfgKeys.length).toBeGreaterThan(1); // repo default governs
    expect(result.view).toBe('welcome');
  });

  // Contract: restoring a backup taken under a bundle schema re-inits the
  // in-memory schema from the backup's own assets — the restored corpus must
  // be annotated under the vocabulary it was captured with.
  test('restoreFromBackup re-inits the in-memory schema from the backup’s assets', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const eraReport = (id) => ({ record_id: id, report_text: 'FINDINGS:\n- x.', sentences: ['x.'], sectionBreaks: [],
        findings: [], validated: false, validated_at: null, schema_version: 7 });
      const A1 = { presence: { values: ['present', 'absent'] }, severity: { values: ['mild'] } };
      const A2 = { presence: { values: ['present'] } };
      // Era 1: bundle schema A1 governs report ONE.
      await Storage.saveDataAsset({ name: 'attributes', payload: A1, version: 'A1' });
      await Storage.importReports([eraReport('ONE')]);
      // Destructive replace snapshots era 1 (reports + A1 asset).
      await Storage.atomicReplace([eraReport('TWO')]);
      // Era 2: schema A2 governs now (persisted + in memory).
      await Storage.saveDataAsset({ name: 'attributes', payload: A2, version: 'A2' });
      const app = Alpine.store('app');
      app.attributeConfig = A2;
      const list = await Storage.listBackups();
      await app.restoreFromBackup(list[list.length - 1].id); // back to era 1
      const attr = await Storage.getDataAsset('attributes');
      return {
        ids: await Storage.listReportIds(),
        persistedVersion: attr ? attr.version : null,
        memoryKeys: Object.keys(app.attributeConfig || {}).sort(),
      };
    });
    expect(result.ids).toEqual(['ONE']);
    expect(result.persistedVersion).toBe('A1');               // era-1 asset back in storage
    expect(result.memoryKeys).toEqual(['presence', 'severity']); // in-memory schema matches it
  });

  // Regression (v1.7.1): clicking a backup entry that was pruned after the
  // list rendered must fail safe — clear error, list refreshed, data untouched.
  test('restoring a stale backup id from the UI refreshes the list and loses nothing', async ({ page }) => {
    const result = await page.evaluate(async ({ one }) => {
      await Storage.importReports([one]);
      await Storage.atomicReplace([one]); // creates one real snapshot
      const app = Alpine.store('app');
      await app.loadBackups();
      // Simulate the stale-render race: an id that has since been pruned.
      await app.restoreFromBackup(999999);
      return {
        toast: app.toastMessage,
        ids: await Storage.listReportIds(),
        uiIds: app.backups.map(b => b.id),
        dbIds: (await Storage.listBackups()).map(b => b.id),
      };
    }, { one: mk('ONE') });
    expect(result.toast).toMatch(/no longer available/i);
    expect(result.ids).toEqual(['ONE']);           // nothing was mutated
    expect(result.uiIds).toEqual(result.dbIds);    // list re-synced to storage
  });
});
