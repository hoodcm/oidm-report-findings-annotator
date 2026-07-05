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
});
