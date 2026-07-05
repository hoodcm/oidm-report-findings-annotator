// Pins the v1.3.0 toggleValidation gate: a report cannot be marked validated
// while any of its validated_findings lacks a `presence` value. Before this
// change, partial-state findings shipped silently into the validated set.

const { test, expect } = require('@playwright/test');
const { gotoApp, resetIndexedDb, seedTaxonomy, seedReports } = require('./helpers');

test.describe('toggleValidation enforces presence on every finding', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await resetIndexedDb(page);
    await seedTaxonomy(page);
    await seedReports(page, ['R001']);
    await page.waitForFunction(() => Alpine.store('app').currentView === 'annotate');
  });

  test('blocks validation when a validated finding has no presence value', async ({ page }) => {
    // Inject a validated finding directly with missing presence. We bypass
    // the UI add flow because acceptFinding/addFinding both seed presence
    // by default — this test pins the gate, not the seeding path.
    await page.evaluate(async () => {
      const app = Alpine.store('app');
      app.report.findings.push({ status: 'validated',
        finding_name: 'acute infarct',
        source_sentence_idx: 1,
        source_text: 'No acute infarct.',
        attributes: {}, // intentionally no presence
      });
      await app._saveCurrentReport();
    });

    await page.evaluate(() => Alpine.store('app').toggleValidation());

    // Report must not be validated; toast must surface a presence error.
    expect(await page.evaluate(() => Alpine.store('app').report.validated)).toBe(false);
    const toast = await page.evaluate(() => ({
      msg: Alpine.store('app').toastMessage,
      type: Alpine.store('app').toastType,
    }));
    expect(toast.type).toBe('error');
    expect(toast.msg).toMatch(/presence/i);
  });

  test('allows validation when every finding has a presence value', async ({ page }) => {
    await page.evaluate(async () => {
      const app = Alpine.store('app');
      app.report.findings.push({ status: 'validated',
        finding_name: 'acute infarct',
        source_sentence_idx: 1,
        source_text: 'No acute infarct.',
        attributes: { presence: 'absent' },
      });
      await app._saveCurrentReport();
    });

    await page.evaluate(() => Alpine.store('app').toggleValidation());
    expect(await page.evaluate(() => Alpine.store('app').report.validated)).toBe(true);
  });
});

test.describe('incompleteAttrKeys predicate + validate-time block on empty attribute values', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await resetIndexedDb(page);
    await seedTaxonomy(page);
    await seedReports(page, ['R001']);
    await page.waitForFunction(() => Alpine.store('app').currentView === 'annotate');
  });

  test('incompleteAttrKeys flags empty/whitespace/[] values and clears real ones (predicate contract)', async ({ page }) => {
    const result = await page.evaluate(() => {
      const p = f => Alpine.store('app').incompleteAttrKeys(f);
      return {
        emptyString: p({ attributes: { presence: 'present', size: '' } }),
        whitespace: p({ attributes: { presence: 'present', size: '   ' } }),
        nullVal: p({ attributes: { presence: 'present', extent: null } }),
        emptyArray: p({ attributes: { presence: 'present', features: [] } }),
        realValue: p({ attributes: { presence: 'present', extent: 'small' } }),
        arrayWithItems: p({ attributes: { presence: 'present', features: ['spiculated'] } }),
        presenceOnly: p({ attributes: { presence: 'present' } }),
        booleanFalse: p({ attributes: { presence: 'present', aggregate: 'false' } }),
      };
    });
    // Should-fire: empty in every shape.
    expect(result.emptyString).toEqual(['size']);
    expect(result.whitespace).toEqual(['size']);
    expect(result.nullVal).toEqual(['extent']);
    expect(result.emptyArray).toEqual(['features']);
    // Shouldn't-fire: any real value, incl. a stringified boolean 'false'.
    expect(result.realValue).toEqual([]);
    expect(result.arrayWithItems).toEqual([]);
    expect(result.presenceOnly).toEqual([]);
    expect(result.booleanFalse).toEqual([]);
  });

  test('an anchored finding with an empty attribute blocks Validate with a plain message', async ({ page }) => {
    await page.evaluate(async () => {
      const app = Alpine.store('app');
      app.report.findings.push({ status: 'validated',
        finding_name: 'acute infarct',
        source_sentence_idx: 1,
        source_text: 'No acute infarct.',
        attributes: { presence: 'present', size: '' }, // added size, no value chosen (the reported bug)
      });
      await app._saveCurrentReport();
    });

    await page.evaluate(() => Alpine.store('app').toggleValidation());

    expect(await page.evaluate(() => Alpine.store('app').report.validated)).toBe(false);
    const toast = await page.evaluate(() => ({
      msg: Alpine.store('app').toastMessage,
      type: Alpine.store('app').toastType,
    }));
    expect(toast.type).toBe('error');
    expect(toast.msg).toMatch(/no value chosen/i);
  });

  test('filling the empty attribute lets validation succeed', async ({ page }) => {
    await page.evaluate(async () => {
      const app = Alpine.store('app');
      app.report.findings.push({ status: 'validated',
        finding_name: 'acute infarct',
        source_sentence_idx: 1,
        source_text: 'No acute infarct.',
        attributes: { presence: 'present', size: '3.2 cm' },
      });
      await app._saveCurrentReport();
    });

    await page.evaluate(() => Alpine.store('app').toggleValidation());
    expect(await page.evaluate(() => Alpine.store('app').report.validated)).toBe(true);
  });

  test('an UNANCHORED finding with an empty attribute does NOT block (no recovery dead-end)', async ({ page }) => {
    await page.evaluate(async () => {
      const app = Alpine.store('app');
      // Anchored finding is complete; the incomplete one is unanchored (null idx),
      // so it lives in Unassigned Validated where there is no attribute editor.
      app.report.findings.push({ status: 'validated',
        finding_name: 'acute infarct',
        source_sentence_idx: 1,
        source_text: 'No acute infarct.',
        attributes: { presence: 'present' },
      });
      app.report.findings.push({ status: 'validated',
        finding_name: 'orphan finding',
        source_sentence_idx: null,
        source_text: 'text that lived in the impression',
        attributes: { presence: 'present', size: '' }, // empty, but unanchored
      });
      await app._saveCurrentReport();
    });

    await page.evaluate(() => Alpine.store('app').toggleValidation());
    expect(await page.evaluate(() => Alpine.store('app').report.validated)).toBe(true);
  });
});
