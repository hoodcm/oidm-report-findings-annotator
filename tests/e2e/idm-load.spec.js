/**
 * .idm bundle load — drop sample.idm through the universal drop zone.
 *
 * Contracts under test (plan D2/S5): the bundle's taxonomy becomes
 * searchable with the exam label taken from the manifest (not the
 * filename); the unconsumed payloads (normality_mappings,
 * actionability_rules) land in dataAssets; the bundle's attribute schema
 * governs the session across reloads; and loading over annotated reports
 * takes a backup and asks first.
 */

const { test, expect } = require('@playwright/test');
const path = require('path');
const { gotoApp, resetIndexedDb, seedTaxonomy, seedReports } = require('./helpers');

const SAMPLE_IDM = path.join(__dirname, '..', 'fixtures', 'sample.idm');
const DROP_INPUT = '#universal-drop input[type="file"]';

test.describe('.idm bundle load', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await resetIndexedDb(page);
    await page.reload();
    await gotoApp(page);
  });

  test('fresh profile: taxonomy searchable, exam label from manifest, assets stored', async ({ page }) => {
    await page.setInputFiles(DROP_INPUT, [SAMPLE_IDM]);
    // Gate on the loader's LAST write, not the first: app.taxonomy is set
    // before the attributes/actionability/normality assets are persisted, so
    // a taxonomy-only wait can read the asset store mid-write on a slow
    // runner (CI flake). sample.idm carries 3 assets.
    await page.waitForFunction(async () => (await Storage.listDataAssets()).length >= 3);

    const state = await page.evaluate(async () => {
      const app = Alpine.store('app');
      const assets = await Storage.listDataAssets();
      const tax = await Storage.loadTaxonomy();
      return {
        examType: app.examType,
        count: app.taxonomy.length,
        search: Taxonomy.searchFindings('bronchogram', app.taxonomy).map(f => f.name),
        assetNames: assets.map(a => a.name).sort(),
        attrsAssetVersion: (assets.find(a => a.name === 'attributes') || {}).version,
        loadedAt: tax.loadedAt,
        sourceFilename: tax.sourceFilename,
      };
    });

    // Exam label comes from the manifest, not deriveExamType('sample.idm').
    expect(state.examType).toBe('CXR');
    expect(state.count).toBe(378);
    expect(state.search).toContain('air_bronchogram');
    // Attributes are consumed AND persisted; the two unconsumed payloads are
    // stored, not interpreted.
    expect(state.assetNames).toEqual(['actionability_rules', 'attributes', 'normality_mappings']);
    // Version stamp = exam_type : Date.parse(manifest.generated_at).
    expect(state.attrsAssetVersion).toBe(`CXR:${Date.parse('2026-07-03T00:00:00.000Z')}`);
    expect(state.loadedAt).toBe(Date.parse('2026-07-03T00:00:00.000Z'));
    // sourceFilename stays null so the label can't be re-derived from 'sample.idm'.
    expect(state.sourceFilename).toBe(null);

    // The bundle's schema governs the session across a reload.
    await page.reload();
    await gotoApp(page);
    const after = await page.evaluate(() => ({
      examType: Alpine.store('app').examType,
      attrsFromAsset: !!Alpine.store('app').attributeConfig.presence,
    }));
    expect(after.examType).toBe('CXR');
    expect(after.attrsFromAsset).toBe(true);
  });

  test('routing chip says the file was recognized as a bundle', async ({ page }) => {
    await page.setInputFiles(DROP_INPUT, [SAMPLE_IDM]);
    const chip = page.locator('[data-drop-chip][data-chip-status="routed"]');
    await expect(chip).toBeVisible();
    await expect(chip).toContainText('sample.idm');
    await expect(chip).toContainText(/bundle/i);
  });

  test('annotated reports: bundle load takes a backup and asks before clearing', async ({ page }) => {
    await seedTaxonomy(page);            // CT Head, different from the bundle
    await seedReports(page, ['R001']);
    // Add one validated finding so the annotated guard path fires.
    await page.evaluate(async () => {
      const app = Alpine.store('app');
      app.report.findings.push({
        finding_name: 'acute infarct', status: 'validated', source_sentence_idx: 1,
        source_text: 'No acute infarct.', attributes: { presence: 'absent' },
      });
      await app._saveCurrentReport();
    });
    await page.click('[title="Back to welcome screen"]');

    await page.setInputFiles(DROP_INPUT, [SAMPLE_IDM]);
    // Styled confirm (replaces native confirm) carries the backup reassurance.
    const dialog = page.locator('[data-confirm-dialog]');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('A backup was just taken');
    await page.click('[data-confirm-accept]');
    await page.waitForFunction(() => Alpine.store('app').examType === 'CXR');

    const state = await page.evaluate(async () => ({
      reportCount: await Storage.getReportCount(),
      backups: (await Storage.listBackups()).filter(b => b.report_count > 0).length,
    }));
    expect(state.reportCount).toBe(0);       // confirmed clear ran
    expect(state.backups).toBeGreaterThan(0); // snapshot taken first
  });
});

// Success criterion 2 (plan): the bundle round-trips through a session file —
// drop → session export → restore on a clean profile → taxonomy + assets intact.
test('.idm bundle round-trips through session export → clean-profile restore', async ({ page }) => {
  await gotoApp(page);
  await resetIndexedDb(page);
  await page.reload();
  await gotoApp(page);

  await page.setInputFiles(DROP_INPUT, [SAMPLE_IDM]);
  // Same completion gate as the fresh-profile test: wait for the loader's
  // last asset write, or the session export below can race the in-flight
  // bundle writes and round-trip a partial asset set.
  await page.waitForFunction(async () => (await Storage.listDataAssets()).length >= 3);
  // Load one report so there's a session to speak of.
  await page.evaluate(async () => {
    await Storage.atomicReplace([{
      record_id: 'X1', report_text: 'FINDINGS:\n- Clear lungs.', sentences: ['- Clear lungs.'],
      sectionBreaks: [], findings: [], validated: false, validated_at: null,
      custom_findings_added: [], taxonomyVersion: 'CXR:0', schema_version: 7,
    }]);
  });

  const { captureDownload } = require('./helpers');
  const { text } = await captureDownload(page, () =>
    page.evaluate(() => Alpine.store('app').exportSession()));
  const session = JSON.parse(text);
  expect((session.data_assets || []).map(a => a.name).sort())
    .toEqual(['actionability_rules', 'attributes', 'normality_mappings']);
  expect(session.taxonomy.examType).toBe('CXR');

  // Clean profile, then restore.
  await resetIndexedDb(page);
  await page.reload();
  await gotoApp(page);
  await page.evaluate(async (sessionText) => {
    const file = new File([sessionText], 'session.json', { type: 'application/json' });
    await Alpine.store('app').restoreSession(file);
  }, text);

  const after = await page.evaluate(async () => ({
    examType: Alpine.store('app').examType,
    taxonomyCount: Alpine.store('app').taxonomy.length,
    assets: (await Storage.listDataAssets()).map(a => a.name).filter(n => n !== 'schema_meta').sort(),
    reports: await Storage.getReportCount(),
  }));
  expect(after.examType).toBe('CXR');
  expect(after.taxonomyCount).toBe(378);
  expect(after.assets).toEqual(['actionability_rules', 'attributes', 'normality_mappings']);
  expect(after.reports).toBe(1);
});
