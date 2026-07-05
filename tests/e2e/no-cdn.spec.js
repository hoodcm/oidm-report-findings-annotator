/**
 * Offline contract — the app makes zero external network requests.
 *
 * Plan D4/S7: Tailwind is precompiled (css/tailwind.css committed) and
 * Dexie/PapaParse/Alpine/Tabler are vendored under vendor/, so the app works
 * on locked-down hospital networks and the Play-CDN runtime-compile race
 * class is gone. Any request leaving localhost — cdn.tailwindcss.com,
 * jsdelivr, fonts, anything — fails this spec.
 */

const { test, expect } = require('@playwright/test');
const { gotoApp, resetIndexedDb, seedTaxonomy, seedReports } = require('./helpers');

test.describe('No external network requests', () => {
  test('index.html + both doc pages load fully offline-equivalent', async ({ page }) => {
    const external = [];
    await page.route('**/*', (route) => {
      const url = route.request().url();
      if (!url.startsWith('http://localhost:8502')) {
        external.push(url);
        return route.abort();
      }
      return route.continue();
    });

    // Main app, through a real annotate session (styles + icons + storage).
    await gotoApp(page);
    await resetIndexedDb(page);
    await seedTaxonomy(page);
    await seedReports(page, ['R001', 'R002']);

    // The precompiled stylesheet actually applied (spot-check the custom
    // palette: bg-gray-50 on <body> is the stone-tinted #fafaf9).
    const bodyBg = await page.evaluate(() =>
      getComputedStyle(document.body).backgroundColor);
    expect(bodyBg).toBe('rgb(250, 250, 249)');
    // Tabler webfont registered from the vendored @font-face.
    const tablerLoaded = await page.evaluate(async () => {
      await document.fonts.ready;
      return [...document.fonts].some(f => /tabler/i.test(f.family) && f.status === 'loaded');
    });
    expect(tablerLoaded).toBe(true);

    // Both static doc pages.
    for (const p of ['/pages/llm-extractions.html', '/pages/reports-format-guide.html']) {
      await page.goto(p);
      await page.waitForLoadState('networkidle');
      const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      expect(bg).toBe('rgb(250, 250, 249)');
    }

    expect(external).toEqual([]);
  });
});
