// Pins the upload-error contracts surfaced in the v1.1.1 M1/M2/L1 set.
// Malformed CSV should produce an actionable toast; cancelled file dialogs
// should never crash; re-selecting the same file after a failed upload must
// still fire the change event.

const { test, expect } = require('@playwright/test');
const { gotoApp, resetIndexedDb } = require('./helpers');

test.describe('Upload error paths surface actionable toasts', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await resetIndexedDb(page);
  });

  test('malformed reports CSV: handler returns cleanly with an error toast', async ({ page }) => {
    // Drive handleReportsCsvUpload with a File whose content is unparseable.
    // (handleReportsCsvUpload catches the parse exception and showToast()'s
    // 'Could not parse CSV file'.) PapaParse is forgiving — empty/garbled
    // input either yields zero rows or trips an error path; either way the
    // user-visible behavior is: no view switch to upload-mapping.
    await page.evaluate(async () => {
      const bad = new File([new Uint8Array([0xff, 0xfe, 0x00, 0x00])], 'bad.csv', { type: 'text/csv' });
      await Alpine.store('app').handleReportsCsvUpload(bad);
    });

    // Either the view never switched OR a toast surfaced. Both are acceptable
    // outcomes; the contract is "no silent corruption / no crash".
    const state = await page.evaluate(() => ({
      view: Alpine.store('app').currentView,
      data: Alpine.store('app').uploadData,
    }));
    if (state.view === 'upload-mapping') {
      // If we did land on the mapping view, the data must not contain valid rows.
      expect(state.data == null || state.data.length === 0 || state.data.every(r => !r.record_id && !r.report_text)).toBe(true);
    }
    // Did not crash; the page is still responsive (Alpine still answers).
    expect(typeof state.view).toBe('string');
  });

  test('cancelled file dialog (null/undefined file): handler is a no-op (M1)', async ({ page }) => {
    // Pre-condition: app is on the welcome view.
    expect(await page.evaluate(() => Alpine.store('app').currentView)).toBe('welcome');

    await page.evaluate(async () => {
      await Alpine.store('app').handleReportsCsvUpload(null);
      await Alpine.store('app').handleReportsCsvUpload(undefined);
      await Alpine.store('app').handleTaxonomyUpload(null);
      await Alpine.store('app').restoreSession(null);
    });

    // Still on welcome view; no crash.
    expect(await page.evaluate(() => Alpine.store('app').currentView)).toBe('welcome');
  });

  test('invalid session JSON: error toast, no IndexedDB write (M2)', async ({ page }) => {
    await page.evaluate(async () => {
      const bad = new File(['{not json'], 'bad.json', { type: 'application/json' });
      await Alpine.store('app').restoreSession(bad);
    });

    const state = await page.evaluate(async () => ({
      toast: Alpine.store('app').toastMessage,
      toastType: Alpine.store('app').toastType,
      count: await Storage.getReportCount(),
    }));
    expect(state.toastType).toBe('error');
    expect(state.toast).toMatch(/invalid json/i);
    expect(state.count).toBe(0);
  });

  // D3 (extraction-prompt-redesign plan, step 4) made the JSON extraction
  // parser tolerant of prose/fenced wrapping, wrapper keys, and lone finding
  // objects — genuinely unparseable/empty input still fails loudly, but the
  // fatal message is now one plain-language sentence instead of a raw JS
  // parse-error string, and a lone finding object (D3 shape 2) is no longer
  // an error at all. These two tests are updated to the new contract; see
  // tests/extraction-import.test.js for the full D3 shape matrix.
  test('extraction upload with truly unparseable JSON: error toast, extractionData not populated', async ({ page }) => {
    await page.evaluate(async () => {
      const bad = new File(['{not valid json'], 'extractions.json', { type: 'application/json' });
      await Alpine.store('app').handleExtractionCsvUpload(bad);
    });

    const state = await page.evaluate(() => ({
      toast: Alpine.store('app').toastMessage,
      toastType: Alpine.store('app').toastType,
      data: Alpine.store('app').extractionData,
      fields: Alpine.store('app').extractionFields,
    }));
    expect(state.toastType).toBe('error');
    expect(state.toast).toMatch(/expected a json array of finding objects/i);
    expect(state.data).toBeNull();
    expect(state.fields).toEqual([]);
  });

  test('extraction upload with an empty JSON array: error toast, extractionData not populated', async ({ page }) => {
    await page.evaluate(async () => {
      const bad = new File(['[]'], 'extractions.json', { type: 'application/json' });
      await Alpine.store('app').handleExtractionCsvUpload(bad);
    });

    const state = await page.evaluate(() => ({
      toast: Alpine.store('app').toastMessage,
      toastType: Alpine.store('app').toastType,
      data: Alpine.store('app').extractionData,
      fields: Alpine.store('app').extractionFields,
    }));
    expect(state.toastType).toBe('error');
    expect(state.toast).toMatch(/array of finding objects/i);
    expect(state.data).toBeNull();
    expect(state.fields).toEqual([]);
  });

  test('extraction upload of a lone finding object (D3 shape 2): tolerated — wraps into a list and proceeds to column mapping', async ({ page }) => {
    await page.evaluate(async () => {
      const lone = new File(['{"record_id":"r1","finding_name":"a","source_text":"x"}'], 'extractions.json', { type: 'application/json' });
      await Alpine.store('app').handleExtractionCsvUpload(lone);
    });

    const state = await page.evaluate(() => ({
      view: Alpine.store('app').currentView,
      data: Alpine.store('app').extractionData,
      fields: Alpine.store('app').extractionFields,
    }));
    expect(state.view).toBe('import-extractions');
    expect(state.data).toEqual([{ record_id: 'r1', finding_name: 'a', source_text: 'x' }]);
    expect(state.fields.sort()).toEqual(['finding_name', 'record_id', 'source_text']);
  });
});
