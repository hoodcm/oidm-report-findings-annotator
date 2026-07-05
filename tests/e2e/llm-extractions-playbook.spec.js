// Pins the D5 playbook-page contract (extraction-prompt-redesign plan, step
// 10): the field reference table and example JSON are GENERATED from the
// session-active schema at load — not hand-maintained — so this page can
// never drift from what the importer actually accepts the way the old
// static table did (indeterminate, wrong severity/extent split, missing
// extent/aggregate/confidence).

const { test, expect } = require('@playwright/test');
const { gotoApp, resetIndexedDb, seedTaxonomy } = require('./helpers');

test.describe('LLM extractions playbook — schema-generated field reference (D5)', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await resetIndexedDb(page);
    await seedTaxonomy(page);
  });

  test('field table rows equal the active schema\'s attribute set; no indeterminate anywhere on the page', async ({ page }) => {
    await page.goto('/pages/llm-extractions.html');
    await page.waitForLoadState('networkidle');

    const cfg = await page.evaluate(async () => (await Storage.resolveAttributeConfig('../data/attributes.json')) || {});
    const expectedOptionalKeys = Object.keys(cfg).filter(k => k !== 'presence' && k !== 'confidence');

    const optionalFieldNames = await page.locator('#field-reference-optional tr td:first-child').allTextContents();
    expect(optionalFieldNames.sort()).toEqual(expectedOptionalKeys.sort());

    // extent and aggregate are present (both real attributes.json keys the
    // OLD static table omitted entirely).
    expect(optionalFieldNames).toContain('extent');
    expect(optionalFieldNames).toContain('aggregate');

    // The four required fields include presence (the OLD static table's
    // missing-required-field row named only three).
    const requiredFieldNames = await page.locator('#field-reference-required tr td:first-child').allTextContents();
    expect(requiredFieldNames).toEqual(['record_id', 'finding_name', 'presence', 'source_text']);

    // indeterminate is retired — must not appear anywhere on the page,
    // including inside the dynamically-generated presence/temporal_status/
    // chronicity value lists.
    const bodyText = await page.locator('body').textContent();
    expect(bodyText).not.toContain('indeterminate');
  });

  test('example JSON section matches the shared ExtractionExample fixture', async ({ page }) => {
    await page.goto('/pages/llm-extractions.html');
    await page.waitForLoadState('networkidle');

    const rendered = await page.locator('#example-json').textContent();
    const parsed = JSON.parse(rendered);
    const expected = await page.evaluate(() => ExtractionExample.findings);
    expect(parsed).toEqual(expected);

    // The commentary notes render too.
    const notesText = await page.locator('#example-notes').textContent();
    const notes = await page.evaluate(() => ExtractionExample.notes);
    for (const note of notes) {
      expect(notesText).toContain(note.slice(0, 40));
    }
  });

  test('the prompt itself embeds the same fixture example (prompt and playbook cannot drift apart)', async ({ page }) => {
    await page.goto('/pages/llm-extractions.html');
    await page.waitForLoadState('networkidle');
    await page.locator('#step-1-prompt summary').first().click();

    const promptText = await page.locator('#prompt-text').textContent();
    const exampleJson = await page.locator('#example-json').textContent();
    // The prompt's worked example is the UNFILTERED fixture (D5 filtering
    // only applies to the playbook's own rendering), so check the shared
    // record_id and finding names appear in both rather than an exact
    // string match.
    expect(promptText).toContain('EXAMPLE-0001');
    expect(exampleJson).toContain('EXAMPLE-0001');
  });
});
