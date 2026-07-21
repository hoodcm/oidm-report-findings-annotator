/**
 * Tests for js/file-classifier.js — the universal drop-zone classifier.
 *
 * The precedence order (idm → session → extraction → taxonomy → reports →
 * unknown) is a contract: the drop zone routes files with no user input, so
 * every signature AND every known collision case is pinned here. Collision
 * cases come straight from the plan's adversarial review — each one is a
 * file that satisfies a looser signature further down the ladder and must
 * still route to the tighter one.
 */

// A report-text cell comfortably above the long-text median threshold (200).
const LONG = 'FINDINGS: The lungs are clear without focal consolidation, effusion or pneumothorax. '
  + 'The cardiomediastinal silhouette is within normal limits for size and contour. '
  + 'The visualized osseous structures show no acute fracture or destructive lesion. '
  + 'Degenerative changes are noted throughout the thoracic spine without acute abnormality.';

const CASES = [
  // --- Tier 1: zip / .idm ---
  {
    name: 'zip magic bytes → idm (byte flag)',
    input: { name: 'bundle.idm', text: '', isZip: true },
    expect: 'idm',
  },
  {
    name: 'zip magic as text prefix → idm',
    input: { name: 'bundle.zip', text: 'PK\x03\x04rest-of-zip' },
    expect: 'idm',
  },

  // --- Tier 2: session JSON ---
  {
    name: 'session JSON {version, reports} → session',
    input: { name: 'session.json', text: JSON.stringify({ version: 2, created_at: 'x', taxonomy: null, reports: [] }) },
    expect: 'session',
  },

  // --- Tier 3: extractions ---
  {
    name: 'bare JSON array of objects → extraction (collision: session vs array)',
    input: { name: 'findings.json', text: JSON.stringify([{ record_id: 'R1', finding_name: 'nodule', source_text: 'a nodule.' }]) },
    expect: 'extraction',
  },

  // --- Tier 3: D3 tolerance shapes (JSON extraction front door) ---
  {
    name: 'D3.1: {"findings": [...]} wrapper (any key name) → extraction, with a note',
    input: { name: 'findings.json', text: JSON.stringify({ findings: [{ record_id: 'R1', finding_name: 'nodule', source_text: 'a nodule.' }] }) },
    expect: 'extraction',
    note: true,
  },
  {
    name: 'D3.2: a lone finding object (not array-wrapped) → extraction, with a note',
    input: { name: 'finding.json', text: JSON.stringify({ record_id: 'R1', finding_name: 'nodule', source_text: 'a nodule.' }) },
    expect: 'extraction',
    note: true,
  },
  {
    name: 'D3.3: prose before/after the JSON body → extraction, with a note',
    input: { name: 'reply.json', text: 'Here is the JSON output:\n\n' + JSON.stringify([{ record_id: 'R1', finding_name: 'nodule', source_text: 'a nodule.' }]) + '\n\nLet me know if you need anything else!' },
    expect: 'extraction',
    note: true,
  },
  {
    name: 'D3.3: fenced code block anywhere in the text → extraction, with a note',
    input: { name: 'reply.json', text: 'Sure, here you go:\n```json\n' + JSON.stringify([{ record_id: 'R1', finding_name: 'nodule', source_text: 'a nodule.' }], null, 2) + '\n```\nHope that helps!' },
    expect: 'extraction',
    note: true,
  },
  {
    name: 'D3.4: a truncated array salvages complete leading objects → extraction, with a note',
    input: {
      name: 'reply.json',
      text: '[' + JSON.stringify({ record_id: 'R1', finding_name: 'nodule', source_text: 'a nodule.' })
        + ',{"record_id":"R2","finding_n',
    },
    expect: 'extraction',
    note: true,
  },
  {
    name: 'D3.5: multiple top-level arrays (one per batch) → extraction, combined with a note',
    input: {
      name: 'reply.json',
      text: JSON.stringify([{ record_id: 'R1', finding_name: 'nodule', source_text: 'a nodule.' }])
        + '\n' + JSON.stringify([{ record_id: 'R2', finding_name: 'mass', source_text: 'a mass.' }]),
    },
    expect: 'extraction',
    note: true,
  },
  {
    name: 'D3.6: curly "smart quotes" in the JSON envelope → extraction, with a note',
    input: { name: 'reply.json', text: '[{“record_id”: “R1”, “finding_name”: “nodule”, “source_text”: “a nodule.”}]' },
    expect: 'extraction',
    note: true,
  },
  {
    name: 'D3.7: garbage JSON (no recognizable structure) → unknown, still fails loudly',
    input: { name: 'reply.json', text: 'This is not JSON at all, sorry about that.' },
    expect: 'unknown',
  },
  {
    name: 'an arbitrary JSON object with no finding-shaped fields → unknown (not swept in by the D3 lone-object tolerance)',
    input: { name: 'other.json', text: JSON.stringify({ foo: 1, bar: 2 }) },
    expect: 'unknown',
  },
  {
    name: 'extraction CSV with an id column → extraction, not reports (collision)',
    input: { name: 'ext.csv', text: 'id,finding_name,source_text\nR1,nodule,"' + LONG + '"' },
    expect: 'extraction',
  },
  {
    name: 'tool-export CSV with taxonomy_id → extraction + tool-export note (collision)',
    input: { name: 'export.csv', text: 'record_id,finding_name,source_text,taxonomy_id\nR1,nodule,a nodule.,TX01' },
    expect: 'extraction',
    note: true,
  },
  {
    name: 'tool-export JSON with taxonomy_id → extraction + tool-export note',
    input: { name: 'export.json', text: JSON.stringify([{ record_id: 'R1', finding_name: 'nodule', source_text: 'a nodule.', taxonomy_id: 'TX01' }]) },
    expect: 'extraction',
    note: true,
  },
  {
    // F4 regression: an extraction CSV using ALIAS column names the importer
    // accepts (name/text, not finding_name/source_text) must still route to the
    // extraction panel — before the classifier shared CsvImport's alias lists
    // it fell through to the reports arm, whose import atomicReplaces (wipes)
    // the corpus.
    name: 'extraction CSV with alias columns (name/text) → extraction, not reports (F4)',
    input: { name: 'ext-alias.csv', text: 'record_id,name,text\nR1,nodule,"' + LONG + '"' },
    expect: 'extraction',
  },
  {
    // Guard the widening didn't over-match: a finding-name alias ALONE (no
    // source-text alias) is not an extraction — this is a reports CSV.
    name: 'CSV with a name column but no source-text column → reports, not extraction (F4 guard)',
    input: { name: 'rep-name.csv', text: 'record_id,name,findings\nR1,nodule,"' + LONG + '"' },
    expect: 'reports',
  },
  {
    // C4 regression: alias matching for ROUTING is exact-only. With a
    // token-boundary pass, patient_name/report_text token-match the generic
    // `name`/`text` aliases and a reports CSV lands in the extraction panel
    // (queued "waiting for reports" instead of imported).
    name: 'reports CSV with patient_name + report_text → reports, not extraction (C4)',
    input: { name: 'pat.csv', text: 'record_id,patient_name,report_text\nR1,Smith,"' + LONG + '"' },
    expect: 'reports',
  },

  // --- Tier 4: taxonomy ---
  {
    name: 'taxonomy CSV with parent_id → taxonomy',
    input: { name: 'tax.csv', text: 'id,name,category,parent_id,synonyms,finding_type\nT1,nodule,lung,,"",observation' },
    expect: 'taxonomy',
  },
  {
    name: 'taxonomy CSV WITHOUT parent_id (flat) → taxonomy (collision: required cols only)',
    input: { name: 'tax-flat.csv', text: 'id,name,category\nT1,nodule,lung' },
    expect: 'taxonomy',
  },

  // --- Tier 5: reports ---
  {
    name: 'reports CSV with record_id + long text → reports',
    input: { name: 'reports.csv', text: 'record_id,report_text\nR1,"' + LONG + '"\nR2,"' + LONG + '"' },
    expect: 'reports',
  },
  {
    name: 'reports CSV whose text column is named findings → reports (collision)',
    input: { name: 'reports.csv', text: 'record_id,findings\nR1,"' + LONG + '"' },
    expect: 'reports',
  },
  {
    name: 'reports CSV with quoted newlines inside cells → reports (real parse, not line-split)',
    input: { name: 'reports.csv', text: 'record_id,report_text\nR1,"' + LONG.replace(/\. /g, '.\n') + '"' },
    expect: 'reports',
  },

  // --- Tier 6: unknown ---
  {
    name: 'plain prose file → unknown',
    input: { name: 'garbage.txt', text: 'hello, this is not any of the recognized shapes.' },
    expect: 'unknown',
  },
  {
    name: 'short CSV with no matching signature → unknown',
    input: { name: 'notes.csv', text: 'a,b\n1,2' },
    expect: 'unknown',
  },
  {
    name: 'malformed JSON → unknown with a readable rationale',
    input: { name: 'broken.json', text: '{"version": 2, "reports": [' },
    expect: 'unknown',
  },
  {
    name: 'JSON object that is not a session → unknown',
    input: { name: 'other.json', text: '{"foo": 1}' },
    expect: 'unknown',
  },
  {
    name: 'empty JSON array → unknown (no entries to recognize)',
    input: { name: 'empty.json', text: '[]' },
    expect: 'unknown',
  },
];

describe('FileClassifier.classify — precedence table (every signature + collision case)', () => {
  for (const c of CASES) {
    it(c.name, () => {
      const r = FileClassifier.classify(c.input);
      assertEqual(r.type, c.expect, `type for ${c.input.name}`);
      assert(typeof r.rationale === 'string' && r.rationale.length > 0, 'rationale is a non-empty string');
      if (c.note) assert(!!r.note, 'expected a tool-export note');
      else assert(!r.note, 'unexpected note on ' + c.input.name);
    });
  }
});

describe('FileClassifier.classify — rationale quality', () => {
  // Rationale copy is radiologist-facing (rendered in the drop-zone chips), so
  // it must be plain language — no raw snake_case column names. These pin the
  // plain-language contract, not exact wording.
  it('reports rationale is plain-language (names no raw column identifier)', () => {
    const r = FileClassifier.classify({ name: 'r.csv', text: 'record_id,report_text\nR1,"' + LONG + '"' });
    assertEqual(r.type, 'reports');
    assert(/report/i.test(r.rationale), 'rationale says it recognized reports');
    assert(!/record_id|report_text|finding_name|source_text/.test(r.rationale),
      'rationale contains no raw snake_case column name');
  });

  it('unknown CSV rationale names the file kinds it looked for, in human terms', () => {
    const r = FileClassifier.classify({ name: 'x.csv', text: 'a,b\n1,2' });
    assertEqual(r.type, 'unknown');
    assert(/findings|reports|extracted/i.test(r.rationale), 'rationale describes the expected file kinds');
    assert(!/finding_name|source_text/.test(r.rationale), 'no raw snake_case column names in the chip');
  });

  it('no tool-export note on a plain extraction CSV', () => {
    const r = FileClassifier.classify({ name: 'e.csv', text: 'record_id,finding_name,source_text\nR1,nodule,text.' });
    assertEqual(r.type, 'extraction');
    assert(!r.note, 'no note without taxonomy_id');
  });
});

describe('FileClassifier.classify — real repo taxonomy.json shape', () => {
  it('data/taxonomy.json (flat JSON array of objects) classifies as extraction per D1 tier 3', () => {
    // The classifier spec routes ANY JSON array of objects to the extraction
    // panel — bare taxonomy JSON is only consumed from inside an .idm bundle.
    const text = JSON.stringify([{ id: 'T1', name: 'nodule', category: 'lung', synonyms: [] }]);
    const r = FileClassifier.classify({ name: 'taxonomy.json', text });
    assertEqual(r.type, 'extraction');
  });
});
