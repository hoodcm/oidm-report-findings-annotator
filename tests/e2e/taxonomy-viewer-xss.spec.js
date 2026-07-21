// Pins the TaxonomyViewer escaping contract: a taxonomy CSV is uploaded by the
// user (often shared by a colleague — no default taxonomy ships with the
// app), so finding names, ids, synonyms, and category labels are untrusted.
// The Taxonomy Viewer must render them as text, not as markup.

const { test, expect } = require('@playwright/test');
const { gotoApp, resetIndexedDb } = require('./helpers');

test.describe('TaxonomyViewer escapes untrusted taxonomy values', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await resetIndexedDb(page);
    // Surface any script execution from the page; the assertions below
    // also check window.__pwn, but reading evaluation errors is a useful belt.
    await page.evaluate(() => { window.__pwn = false; });
  });

  test('malicious taxonomy values render as text, not markup', async ({ page }) => {
    await page.evaluate(async () => {
      const findings = [
        {
          id: '<img src=x onerror="window.__pwn=true">',
          name: '<script>window.__pwn=true</script>cerebral edema',
          synonyms: ['<svg onload="window.__pwn=true">', 'brain swelling'],
          category: '<b>brain</b>',
          parent_id: null,
          finding_type: 'observation',
        },
      ];
      await Storage.saveTaxonomy('CT Head', 'malicious.csv', findings, false);
      Alpine.store('app').taxonomy = findings;
      Alpine.store('app').examType = 'CT Head';
      window.dispatchEvent(new CustomEvent('open-taxonomy'));
    });

    await page.waitForSelector('#taxonomy-tree');
    await page.waitForFunction(() => {
      const tree = document.getElementById('taxonomy-tree');
      return tree && tree.innerHTML.length > 0;
    });

    // No script executed.
    expect(await page.evaluate(() => window.__pwn)).toBe(false);

    // The viewer DOM contains no injected element types — the markup is rendered as text.
    const injectedCounts = await page.evaluate(() => {
      const tree = document.getElementById('taxonomy-tree');
      return {
        script: tree.querySelectorAll('script').length,
        img: tree.querySelectorAll('img').length,
        svg: tree.querySelectorAll('svg').length,
      };
    });
    expect(injectedCounts.script).toBe(0);
    expect(injectedCounts.img).toBe(0);
    expect(injectedCounts.svg).toBe(0);

    // The dangerous strings should be present as text content so the user
    // sees what the taxonomy author wrote — just not interpreted as HTML.
    const treeText = await page.evaluate(() => document.getElementById('taxonomy-tree').textContent);
    expect(treeText).toContain('<script>');
    expect(treeText).toContain('<svg onload');
  });

  test('search query renders as text in the no-match line', async ({ page }) => {
    // Seed a benign taxonomy so we have something for filter() to miss.
    await page.evaluate(async () => {
      const findings = [
        { id: 'F1', name: 'cerebral edema', synonyms: [], category: 'brain', parent_id: null, finding_type: 'observation' },
      ];
      await Storage.saveTaxonomy('CT Head', 'benign.csv', findings, false);
      Alpine.store('app').taxonomy = findings;
      Alpine.store('app').examType = 'CT Head';
      window.dispatchEvent(new CustomEvent('open-taxonomy'));
    });

    await page.waitForSelector('#taxonomy-search');
    const malicious = '<img src=x onerror="window.__pwn=true">';
    await page.locator('#taxonomy-search').fill(malicious);

    await page.waitForFunction(() => {
      const tree = document.getElementById('taxonomy-tree');
      return tree && /No findings match/.test(tree.textContent || '');
    });

    expect(await page.evaluate(() => window.__pwn)).toBe(false);
    const injectedImg = await page.evaluate(() =>
      document.getElementById('taxonomy-tree').querySelectorAll('img').length
    );
    expect(injectedImg).toBe(0);

    const treeText = await page.evaluate(() => document.getElementById('taxonomy-tree').textContent);
    expect(treeText).toContain(malicious);
  });
});
