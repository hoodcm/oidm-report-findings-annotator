/**
 * Tier 1 contract tests — pure-Node, executable via `node tests/run.js`.
 *
 * Pins the contracts that user data actually rides on across releases:
 * sentence parse/match identity, IndexedDB round-trips through `plain()`,
 * atomic-replace rollback, and the {msg, fix} validator shape. Each contract
 * traces back to either a CHANGELOG fix (v1.1.1 IE-series, v1.3.0 DataCloneError
 * + custom-attribute round-trip + actionable-errors) or the structural
 * guarantee a future regression would silently break.
 *
 * Tests intentionally NOT here (moved to Tier 3 because they live on the
 * Alpine store, not as pure exports): exportAllCsv, exportSession,
 * restoreSession, init-time schema migration. The Plan calls those out.
 *
 * Skipped per user direction during planning: taxonomy fuzzy-match laterality
 * discrimination test (the "left edema" vs "right edema" decision is deferred;
 * see TODO.md for the partial-match search feature idea that surfaced).
 */

// Dual-runtime fixture access: Node uses require, the browser runner loads
// fixtures/reports.js via a <script> tag that sets window.__REPORT_FIXTURES.
const FIXTURES = (typeof require === 'function')
  ? require('./fixtures/reports.js').FIXTURES
  : window.__REPORT_FIXTURES;

const SAMPLE_TAXONOMY = [
  {
    id: 'HID001',
    name: 'cerebral edema',
    synonyms: ['brain swelling'],
    category: 'brain',
    parent_id: null,
    finding_type: 'observation',
  },
];

const ATTR_CONFIG_FOR_VALIDATOR = {
  presence: { type: 'enum', values: ['present', 'absent', 'indeterminate'] },
  laterality: { type: 'enum', values: ['left', 'right', 'bilateral'] },
  severity: { type: 'enum', values: ['mild', 'moderate', 'severe'] },
};

// Wrap a value (and its nested plain-object/array members one level deep) in a
// no-op Proxy. Mirrors how Alpine.js exposes reactive state: a Proxy around the
// root and Proxies around each child object/array. structuredClone() — the
// algorithm IndexedDB uses on writes — rejects Proxies with DataCloneError, so
// the Storage layer's plain() helper must JSON-round-trip before bulkPut.
function proxyWrap(value) {
  if (Array.isArray(value)) {
    return new Proxy(value.map(proxyWrap), {});
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = (v && typeof v === 'object') ? proxyWrap(v) : v;
    }
    return new Proxy(out, {});
  }
  return value;
}

// Two separate clears per suite — Storage shares one Dexie DB across the whole
// run, so each contract test resets to a clean slate first. Errors swallowed
// because the test runner can race ahead of the previous suite's writes.
async function resetStorage() {
  try { await Storage.clearAllReports(); } catch (_) { /* ignore */ }
  try { await Storage.clearTaxonomy(); } catch (_) { /* ignore */ }
}

describe('Contract: sentence parse/match identity (fixtures)', () => {
  for (const fx of FIXTURES) {
    it(`fixture "${fx.id}" splits to expected sentence array`, () => {
      const { sentences } = Sentences.splitIntoSentences(fx.findingsText);
      assertDeepEqual(sentences, fx.expectedSentences,
        `splitter drift on fixture "${fx.id}"`);
    });

    it(`fixture "${fx.id}" — every produced sentence resolves to its own 1-based index`, () => {
      const { sentences } = Sentences.splitIntoSentences(fx.findingsText);
      for (let i = 0; i < sentences.length; i++) {
        const r = Sentences.matchSourceToSentence(sentences[i], sentences, fx.id, []);
        if (r.idx !== i + 1) {
          throw new Error(
            `parse/match identity broken on "${fx.id}" sentence #${i + 1}: ` +
            `matcher returned ${JSON.stringify(r)} for own sentence text`
          );
        }
      }
    });

    it(`fixture "${fx.id}" — declared source_text spans resolve to declared indices`, () => {
      const { sentences } = Sentences.splitIntoSentences(fx.findingsText);
      for (const { sourceText, expectedIdx } of fx.expectedMatches) {
        const r = Sentences.matchSourceToSentence(sourceText, sentences, fx.id, []);
        assertEqual(r.idx, expectedIdx,
          `match drift on "${fx.id}" for source_text "${sourceText}"`);
      }
    });
  }
});

describe('Contract: Storage.saveTaxonomy accepts Alpine-Proxy-wrapped findings (v1.3.0 DataCloneError pin)', () => {
  it('proxied findings array survives the save+load round-trip', async () => {
    await resetStorage();

    const plainFindings = [
      {
        id: 'HID001',
        name: 'cerebral edema',
        synonyms: ['brain swelling'],
        category: 'brain',
        parent_id: null,
        finding_type: 'observation',
      },
      {
        id: 'HID002',
        name: 'subdural hemorrhage',
        synonyms: ['SDH', 'subdural hematoma'],
        category: 'hemorrhage',
        parent_id: null,
        finding_type: 'observation',
      },
    ];
    const proxiedFindings = proxyWrap(plainFindings);

    await Storage.saveTaxonomy('CT Head', 'ct-head-findings-taxonomy.csv', proxiedFindings, false);

    const loaded = await Storage.loadTaxonomy();
    assertEqual(loaded.examType, 'CT Head');
    assertEqual(loaded.sourceFilename, 'ct-head-findings-taxonomy.csv');
    assertEqual(loaded.isDefault, false);
    assertDeepEqual(loaded.findings, plainFindings,
      'loaded findings should deep-equal the original plain shape');
  });
});

describe('Contract: Storage.saveReport accepts Alpine-Proxy-wrapped input (secondary plain() coverage)', () => {
  it('proxied report survives save+load and deep-equals plain shape', async () => {
    await resetStorage();

    const plainReport = {
      record_id: 'r-proxy-1',
      report_text: 'FINDINGS: Brain: No acute findings.',
      sentences: ['Brain: No acute findings.'],
      validated: false,
      validated_findings: [],
      llm_extractions: [
        {
          finding_name: 'cerebral edema',
          source_text: 'No acute findings',
          attributes: { presence: 'absent' },
        },
      ],
      schema_version: 4,
    };
    const proxied = proxyWrap(plainReport);

    await Storage.saveReport(proxied);
    const loaded = await Storage.loadReport('r-proxy-1');
    assertDeepEqual(loaded, plainReport);
  });

  it('loadReport returns null for unknown record_id', async () => {
    await resetStorage();
    const r = await Storage.loadReport('does-not-exist');
    assertEqual(r, null);
  });
});

describe('Contract: Storage.saveReport / loadReport deep-equality round-trip', () => {
  it('full-shape report with findings + attributes + custom attributes round-trips intact', async () => {
    await resetStorage();

    const report = {
      record_id: 'r-roundtrip-1',
      report_text: 'FINDINGS: Brain: Mass effect present. Lung: clear.',
      sentences: ['Brain: Mass effect present.', 'Lung: clear.'],
      sectionBreaks: [],
      validated: true,
      validated_at: '2026-05-24T10:00:00Z',
      validated_findings: [
        {
          finding_name: 'mass_effect',
          source_text: 'Mass effect present',
          source_sentence_idx: 1,
          attributes: {
            presence: 'present',
            laterality: 'left',
            severity: 'moderate',
            // Custom attributes — the v1.3.0 contract preserves these
            weight: '5kg',
            lesion_count: '3',
          },
        },
      ],
      llm_extractions: [],
      schema_version: 4,
    };

    await Storage.saveReport(report);
    const loaded = await Storage.loadReport('r-roundtrip-1');
    assertDeepEqual(loaded, report);
  });
});

describe('Contract: Storage.atomicReplace rolls back on bulkPut failure', () => {
  it('rejected transaction leaves the prior contents intact', async () => {
    await resetStorage();

    // Seed initial state.
    const before = [
      { record_id: 'orig-1', report_text: 'one' },
      { record_id: 'orig-2', report_text: 'two' },
    ];
    await Storage.atomicReplace(before);

    // Attempt a replacement where one row has an invalid primary key type
    // (Dexie's key path is record_id as a string; passing an object fails
    // the schema constraint and aborts the entire transaction).
    const badBatch = [
      { record_id: 'new-1', report_text: 'a' },
      { record_id: { not: 'a string' }, report_text: 'b' },
    ];

    let threw = false;
    try {
      await Storage.atomicReplace(badBatch);
    } catch (_) {
      threw = true;
    }
    assert(threw, 'atomicReplace should reject when a row has an invalid key');

    // Original two reports must still be present — clear() must have rolled back.
    const ids = await Storage.listReportIds();
    assertDeepEqual(ids.sort(), ['orig-1', 'orig-2']);
    const r1 = await Storage.loadReport('orig-1');
    assertEqual(r1.report_text, 'one');
  });
});

describe('Contract: Storage.importReports / exportAllReports symmetry', () => {
  it('export → import → export returns the same set of reports', async () => {
    await resetStorage();

    const seed = [
      { record_id: 'sym-1', report_text: 'one', validated: false },
      { record_id: 'sym-2', report_text: 'two', validated: true },
    ];
    await Storage.importReports(seed);

    const first = await Storage.exportAllReports();
    // Dexie can return rows in arbitrary order; sort for stable comparison.
    first.sort((a, b) => a.record_id.localeCompare(b.record_id));
    assertDeepEqual(first, seed);

    // Re-import the exported set as a Proxy (Alpine path) — must not throw.
    await Storage.clearAllReports();
    await Storage.importReports(proxyWrap(first));
    const second = await Storage.exportAllReports();
    second.sort((a, b) => a.record_id.localeCompare(b.record_id));
    assertDeepEqual(second, seed);
  });
});

describe('Contract: validateExtractionRows produces {msg, fix} for every error category', () => {
  // One representative failing row per category. Each must produce an error
  // with both `msg` and `fix` set to non-empty strings — the actionable-errors
  // contract from v1.3.0.
  const reportsById = {
    r1: { record_id: 'r1', sentences: ['Brain: A finding is here.', 'Brain: Another sentence here.'] },
    r2: { record_id: 'r2', sentences: ['Brain: Different content entirely.'] },
  };
  const baseColumnMap = {
    record_id: 'record_id',
    finding_name: 'finding_name',
    source_text: 'source_text',
    presence: 'presence',
    laterality: 'laterality',
  };
  const baseFields = ['record_id', 'finding_name', 'source_text', 'presence', 'laterality'];

  function runOne(parsed) {
    return CsvImport.validateExtractionRows(
      parsed, reportsById, ATTR_CONFIG_FOR_VALIDATOR,
      baseColumnMap, baseFields, Sentences
    );
  }

  function assertActionable(errors, label) {
    assert(Array.isArray(errors) && errors.length >= 1,
      `${label}: expected at least one error`);
    for (const e of errors) {
      assert(typeof e.msg === 'string' && e.msg.length > 0,
        `${label}: error.msg must be a non-empty string, got ${JSON.stringify(e)}`);
      assert(typeof e.fix === 'string' && e.fix.length > 0,
        `${label}: error.fix must be a non-empty string, got ${JSON.stringify(e)}`);
    }
  }

  it('missingRequired → actionable {msg, fix}', () => {
    const parsed = [{
      record_id: 'r1', finding_name: '', source_text: '',
      attributes: { presence: 'present' },
    }];
    const s = runOne(parsed);
    assertEqual(s.counts.missingRequired, 1);
    assertActionable(s.invalid[0]._validation_errors, 'missingRequired');
  });

  it('unknownRecord → actionable {msg, fix}', () => {
    const parsed = [{
      record_id: 'r-DOES-NOT-EXIST', finding_name: 'thing',
      source_text: 'A finding is here',
      attributes: { presence: 'present' },
    }];
    const s = runOne(parsed);
    assertEqual(s.counts.unknownRecord, 1);
    assertActionable(s.invalid[0]._validation_errors, 'unknownRecord');
  });

  it('notInReport → actionable {msg, fix}', () => {
    const parsed = [{
      record_id: 'r1', finding_name: 'thing',
      source_text: 'Hallucinated quote not in any sentence',
      attributes: { presence: 'present' },
    }];
    const s = runOne(parsed);
    assertEqual(s.counts.notInReport, 1);
    assertActionable(s.invalid[0]._validation_errors, 'notInReport');
  });

  it('ambiguous → actionable {msg, fix}', () => {
    // Both r1 sentences contain "here" — match should be ambiguous in r1.
    const parsed = [{
      record_id: 'r1', finding_name: 'thing', source_text: 'here',
      attributes: { presence: 'present' },
    }];
    const s = runOne(parsed);
    assertEqual(s.counts.ambiguous, 1);
    assertActionable(s.invalid[0]._validation_errors, 'ambiguous');
  });

  it('badPresence → actionable {msg, fix}', () => {
    const parsed = [{
      record_id: 'r1', finding_name: 'thing', source_text: 'A finding is here',
      attributes: { presence: 'probable' },
    }];
    const s = runOne(parsed);
    assertEqual(s.counts.badPresence, 1);
    assertActionable(s.invalid[0]._validation_errors, 'badPresence');
  });

  it('badEnum (non-presence canonical enum) → actionable {msg, fix}', () => {
    const parsed = [{
      record_id: 'r1', finding_name: 'thing', source_text: 'A finding is here',
      attributes: { presence: 'present', laterality: 'leftish' },
    }];
    const s = runOne(parsed);
    assertEqual(s.counts.badEnum, 1);
    assertActionable(s.invalid[0]._validation_errors, 'badEnum');
  });
});
