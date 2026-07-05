/**
 * E2E test helpers. Build app state via the Alpine store + IndexedDB so each
 * spec sets up in a small number of lines and doesn't redrive the multi-step
 * upload wizard unless the upload itself is what's being tested.
 *
 * The pattern is: navigate to the app, wait for Alpine + Storage to be ready,
 * then either drive the UI for a workflow-coverage spec or call store methods
 * via `page.evaluate(...)` for a data-shape spec.
 */

const path = require('path');
const fs = require('fs');

const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const TAXONOMY_CSV_PATH = path.join(FIXTURES_DIR, 'ct-head-taxonomy.csv');
const SAMPLE_REPORTS_CSV_PATH = path.join(FIXTURES_DIR, 'sample-reports.csv');

/** Navigate to the app root and wait until the Alpine store is registered. */
async function gotoApp(page) {
  await page.goto('/');
  await page.waitForFunction(
    () => typeof window.Alpine === 'object' && Alpine.store && Alpine.store('app'),
    { timeout: 10000 }
  );
  // Storage is a window global once js/storage.js runs.
  await page.waitForFunction(() => typeof window.Storage === 'object');
  // init() starts on the loading view; wait for it to resolve to a real view
  // so specs can assert on welcome/annotate immediately.
  await page.waitForFunction(() => Alpine.store('app').currentView !== 'loading', { timeout: 10000 });
}

/** Wipe all Dexie tables. Use between specs that share the dev-server origin.
 *  Backups are cleared last — clearAllReports snapshots before clearing, so the
 *  order matters to leave each spec with an empty backups table. */
async function resetIndexedDb(page) {
  await page.evaluate(async () => {
    await Storage.clearAllReports();
    await Storage.clearTaxonomy();
    await Storage.clearBackups();
    await Storage.clearDataAssets();
  });
}

/** Seed the taxonomy directly via Storage so a spec doesn't have to drive the
 *  upload UI when its real subject is something else. */
async function seedTaxonomy(page, examType = 'CT Head', filename = 'ct-head-findings-taxonomy.csv') {
  await page.evaluate(async ({ examType, filename }) => {
    const findings = [
      { id: 'HID001', name: 'cerebral edema', synonyms: ['brain swelling', 'cerebral swelling'], category: 'brain', parent_id: null, finding_type: 'observation' },
      { id: 'HID002', name: 'subdural hemorrhage', synonyms: ['subdural hematoma', 'SDH'], category: 'hemorrhage', parent_id: null, finding_type: 'observation' },
      { id: 'HID003', name: 'midline shift', synonyms: ['midline_shift'], category: 'mass_effect', parent_id: null, finding_type: 'observation' },
      { id: 'HID004', name: 'mass effect', synonyms: [], category: 'mass_effect', parent_id: null, finding_type: 'observation' },
      { id: 'HID005', name: 'acute infarct', synonyms: ['acute stroke', 'cerebral infarct'], category: 'brain', parent_id: null, finding_type: 'observation' },
      { id: 'HID006', name: 'hydrocephalus', synonyms: ['ventricular enlargement'], category: 'ventricular', parent_id: null, finding_type: 'observation' },
      { id: 'HID007', name: 'craniotomy', synonyms: [], category: 'surgical', parent_id: null, finding_type: 'procedure' },
    ];
    await Storage.saveTaxonomy(examType, filename, findings, false);
    Alpine.store('app').taxonomy = findings;
    Alpine.store('app').examType = examType;
  }, { examType, filename });
}

/**
 * Seed a small set of reports directly to IndexedDB at the current SCHEMA_VERSION,
 * then reload the page so init() runs the real session-load path. This avoids
 * a Playwright "execution context destroyed" issue we observed when calling
 * `_loadSession` from inside the same page.evaluate as the Storage write —
 * the chained history.pushState calls inside navigateTo + selectSentence
 * appear to detach the evaluate's resolution handle even though the page
 * doesn't actually navigate.
 *
 * Reloading is also more realistic: the production load path is init().
 */
async function seedReports(page, recordIds = ['R001', 'R002', 'R003']) {
  await page.evaluate(async (ids) => {
    const TEXTS = {
      R001: 'FINDINGS:\nBrain Parenchyma:\n- No acute infarct.\n- No mass effect.\n- No midline shift.\nVentricular System:\n- Ventricles are normal in size.',
      R002: 'FINDINGS:\nBrain Parenchyma:\n- Small acute subdural hemorrhage along the left convexity.\n- No midline shift.\nVentricular System:\n- Ventricles are normal.',
      R003: 'FINDINGS:\nBrain Parenchyma:\n- No acute infarct.\n- Chronic right basal ganglia infarct.\nVentricular System:\n- Mild hydrocephalus.',
    };
    const SCHEMA_VERSION = 7;
    const reports = ids.map(rid => {
      const text = TEXTS[rid];
      const findingsText = Sentences.parseFindingsSection(text);
      const { sentences, sectionBreaks } = Sentences.splitIntoSentences(findingsText);
      return {
        record_id: rid,
        report_text: text,
        sentences,
        sectionBreaks,
        findings: [],
        validated: false,
        validated_at: null,
        custom_findings_added: [],
        extraction_model: null,
        extraction_timestamp: null,
        taxonomyVersion: 'CT Head:0',
        schema_version: SCHEMA_VERSION,
      };
    });
    await Storage.atomicReplace(reports);
  }, recordIds);

  await page.reload();
  await page.waitForFunction(
    () => typeof window.Alpine === 'object' && Alpine.store && Alpine.store('app'),
    { timeout: 10000 }
  );
  await page.waitForFunction(
    () => Alpine.store('app').currentView === 'annotate',
    { timeout: 5000 }
  );
}

/**
 * Capture a single download triggered by a UI action. Returns the
 * downloaded file's body as a UTF-8 string.
 */
async function captureDownload(page, triggerFn) {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    triggerFn(),
  ]);
  const buf = await readDownload(download);
  return { filename: download.suggestedFilename(), text: buf.toString('utf8'), bytes: buf };
}

async function readDownload(download) {
  // Playwright streams download to a temp path; read it as raw bytes.
  const tmpPath = await download.path();
  return fs.readFileSync(tmpPath);
}

/** Wait for a toast with text matching `substring` (case-insensitive). */
async function expectToast(page, substring) {
  const re = new RegExp(substring, 'i');
  await page.waitForFunction(
    (pattern) => {
      const app = Alpine.store('app');
      if (!app || !app.toastVisible || !app.toastMessage) return false;
      return new RegExp(pattern, 'i').test(app.toastMessage);
    },
    substring.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    { timeout: 5000 }
  );
}

module.exports = {
  FIXTURES_DIR,
  TAXONOMY_CSV_PATH,
  SAMPLE_REPORTS_CSV_PATH,
  gotoApp,
  resetIndexedDb,
  seedTaxonomy,
  seedReports,
  captureDownload,
  expectToast,
};
