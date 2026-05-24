// Keyboard-shortcut regression coverage. Pins the J/K regression from
// commit c06eacd: selectSentence previously auto-focused the search input,
// trapping subsequent J/K keystrokes inside it. Each shortcut is exercised
// across multiple consecutive presses so a focus-trap regression fails fast.

const { test, expect } = require('@playwright/test');
const { gotoApp, resetIndexedDb, seedTaxonomy, seedReports } = require('./helpers');

async function selectedIdx(page) {
  return page.evaluate(() => Alpine.store('app').selectedSentenceIdx);
}

async function currentRecordIdx(page) {
  return page.evaluate(() => Alpine.store('app').currentIdx);
}

test.describe('Keyboard shortcuts survive consecutive presses', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await resetIndexedDb(page);
    await seedTaxonomy(page);
    await seedReports(page);
    await page.waitForFunction(() => Alpine.store('app').currentView === 'annotate');
    // Click into the report area so the document has focus.
    await page.locator('[data-sentence-idx="1"]').first().click();
  });

  test('K advances the sentence index on every press (J/K regression c06eacd)', async ({ page }) => {
    // After clicking sentence 1, selectedSentenceIdx === 1.
    expect(await selectedIdx(page)).toBe(1);

    await page.keyboard.press('k');
    expect(await selectedIdx(page)).toBe(2);

    // CRITICAL: second consecutive press must also advance. The regression
    // would fail here because selectSentence(2) auto-focused the input,
    // making this keystroke go to the input.
    await page.keyboard.press('k');
    expect(await selectedIdx(page)).toBe(3);

    await page.keyboard.press('k');
    expect(await selectedIdx(page)).toBe(4);
  });

  test('J retreats the sentence index on every press', async ({ page }) => {
    // Move to a known later sentence first.
    await page.evaluate(() => Alpine.store('app').selectSentence(4));
    expect(await selectedIdx(page)).toBe(4);

    await page.keyboard.press('j');
    expect(await selectedIdx(page)).toBe(3);
    await page.keyboard.press('j');
    expect(await selectedIdx(page)).toBe(2);
    await page.keyboard.press('j');
    expect(await selectedIdx(page)).toBe(1);
  });

  test('I (next report) advances on consecutive presses', async ({ page }) => {
    expect(await currentRecordIdx(page)).toBe(0);
    await page.keyboard.press('i');
    expect(await currentRecordIdx(page)).toBe(1);
    await page.keyboard.press('i');
    expect(await currentRecordIdx(page)).toBe(2);
  });

  test('U (previous report) retreats on consecutive presses', async ({ page }) => {
    await page.evaluate(() => Alpine.store('app').navigateTo(2));
    expect(await currentRecordIdx(page)).toBe(2);
    await page.keyboard.press('u');
    expect(await currentRecordIdx(page)).toBe(1);
    await page.keyboard.press('u');
    expect(await currentRecordIdx(page)).toBe(0);
  });

  test('F focuses the finding-search input', async ({ page }) => {
    await page.keyboard.press('f');
    await expect(page.locator('#finding-search-input')).toBeFocused();
  });
});
