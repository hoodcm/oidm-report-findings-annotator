/**
 * Tests for js/extraction-import.js — column detection, parsing, validation.
 */

// normalizeConfidence reads Schema.isHedgeable('presence'); init Schema from the
// real config (presence IS hedgeable under the workbench polarity+hedge model).
Schema.init(require('../data/attributes.json'));

const ATTR_CONFIG = {
  presence: { type: 'enum', values: ['present', 'absent', 'indeterminate'] },
  laterality: { type: 'enum', values: ['left', 'right', 'bilateral'] },
  temporal_status: { type: 'enum', values: ['unchanged', 'new', 'resolved'] },
  chronicity: { type: 'enum', values: ['acute', 'subacute', 'chronic'] },
  size: { type: 'text', values: [] },
  severity: { type: 'enum', values: ['mild', 'moderate', 'severe'] },
  anatomic_site: { type: 'text', values: [] },
  features: { type: 'array', values: [] },
  tip_location: { type: 'text', values: [] },
  position_status: { type: 'enum', values: ['satisfactory', 'malpositioned'] },
};

describe('CsvImport.Norm — input normalization', () => {
  it('Norm.cell strips a leading UTF-8 BOM', () => {
    assertEqual(CsvImport.Norm.cell('﻿hello'), 'hello');
  });

  it('Norm.cell does NOT strip a BOM in the middle of a cell', () => {
    // Only leading BOM is removed; embedded ones are user-visible data.
    assertEqual(CsvImport.Norm.cell('hello﻿world'), 'hello﻿world');
  });

  it('Norm.cell handles null/undefined gracefully', () => {
    assertEqual(CsvImport.Norm.cell(null), '');
    assertEqual(CsvImport.Norm.cell(undefined), '');
  });

  it('Norm.text strips a Markdown code-fence wrapper around the body', () => {
    const text = '```csv\nrecord_id,name\nr1,thing\n```';
    assertEqual(CsvImport.Norm.text(text), 'record_id,name\nr1,thing');
  });

  it('Norm.text leaves an un-fenced body intact (modulo BOM + trim)', () => {
    assertEqual(CsvImport.Norm.text('record_id,name\nr1,thing\n'), 'record_id,name\nr1,thing');
  });

  it('Norm.colName folds case and separators (space, hyphen, underscore)', () => {
    assertEqual(CsvImport.Norm.colName('Record ID'), 'record_id');
    assertEqual(CsvImport.Norm.colName('record-id'), 'record_id');
    assertEqual(CsvImport.Norm.colName('RECORD_ID'), 'record_id');
  });
});

describe('CsvImport._looksLikeJsonText — format-detection heuristic (parseFile front door)', () => {
  it('detects JSON starting at position zero', () => {
    assert(CsvImport._looksLikeJsonText('[{"record_id":"r1"}]'));
  });

  it('detects JSON with a short prose preamble (no comma before the bracket)', () => {
    assert(CsvImport._looksLikeJsonText('Here is the JSON output:\n\n[{"record_id":"r1"}]'));
  });

  it('does NOT misdetect a reports/taxonomy/extraction CSV (comma-separated header before any bracket)', () => {
    assert(!CsvImport._looksLikeJsonText('record_id,report_text\nr1,"Impression [see report]."'));
  });

  it('returns false when there is no bracket at all', () => {
    assert(!CsvImport._looksLikeJsonText('just plain text, no JSON here'));
  });

  it('detects a fenced code block even when a comma precedes it (the comma-heuristic false-negative case)', () => {
    assert(CsvImport._looksLikeJsonText('Sure, here you go:\n```json\n[{"record_id":"r1"}]\n```'));
  });

  it('detects a conversational preamble that itself starts with a comma ("Sure, here is...")', () => {
    assert(CsvImport._looksLikeJsonText('Sure, here is the JSON output:\n\n[{"record_id":"r1"}]'));
  });

  it('still rejects a CSV whose header has no space after the comma, even with a natural-language sentence nearby', () => {
    assert(!CsvImport._looksLikeJsonText('record_id,finding_name,source_text\nr1,nodule,"a nodule, possibly [artifact]."'));
  });
});

describe('CsvImport.parseExtractionCsv — source_text sentinel values', () => {
  const map = {
    record_id: 'record_id', finding_name: 'finding_name', source_text: 'source_text',
  };

  it('treats source_text = "nan" (case-insensitive) as empty', () => {
    const rows = [{ record_id: 'r1', finding_name: 'thing', source_text: 'nan' }];
    const { findings } = CsvImport.parseExtractionCsv(rows, map);
    assertEqual(findings[0].source_text, '');
  });

  it('treats source_text = "NULL" (case-insensitive) as empty', () => {
    const rows = [{ record_id: 'r1', finding_name: 'thing', source_text: 'NULL' }];
    const { findings } = CsvImport.parseExtractionCsv(rows, map);
    assertEqual(findings[0].source_text, '');
  });
});

describe('CsvImport._parseJson — JSON path returns standard shape', () => {
  it('parses a top-level JSON array into { data, fields, errors }', () => {
    const text = JSON.stringify([
      { record_id: 'r1', finding_name: 'A', source_text: 'x' },
      { record_id: 'r2', finding_name: 'B', source_text: 'y', laterality: 'left' },
    ]);
    const out = CsvImport._parseJson(text);
    assertEqual(out.data.length, 2);
    assertEqual(out.errors.length, 0);
    // Field union across rows.
    assertIncludes(out.fields, 'record_id');
    assertIncludes(out.fields, 'finding_name');
    assertIncludes(out.fields, 'source_text');
    assertIncludes(out.fields, 'laterality');
  });

  it('flags malformed JSON as a fatal error (does not throw)', () => {
    const out = CsvImport._parseJson('{not valid json');
    assertEqual(out.data.length, 0);
    assertEqual(out.errors.length, 1);
    assertEqual(out.errors[0].type, 'fatal');
  });

  // D3 shape 2: a lone finding object (not a top-level array) is tolerated —
  // wrapped into a one-element list — rather than rejected. Superseded the
  // prior strict "non-array JSON is fatal" contract.
  it('wraps a lone top-level finding object into a one-element list', () => {
    const out = CsvImport._parseJson('{"record_id":"r1","finding_name":"a"}');
    assertEqual(out.data.length, 1);
    assertDeepEqual(out.data[0], { record_id: 'r1', finding_name: 'a' });
    assertEqual(out.errors.length, 0);
    assert(out.notes.includes('wrapped your single finding into a list'));
  });
});

describe('CsvImport._parseJson — D3 tolerance: wrapper shapes, prose, truncation, batches, smart quotes', () => {
  it('unwraps {"findings": [...]} (and any other single array-valued key)', () => {
    const out1 = CsvImport._parseJson(JSON.stringify({ findings: [{ record_id: 'r1', finding_name: 'a' }] }));
    assertEqual(out1.data.length, 1);
    assert(out1.notes.some(n => /unwrapped.*"findings"/.test(n)));

    const out2 = CsvImport._parseJson(JSON.stringify({ extracted_data: [{ record_id: 'r1', finding_name: 'a' }] }));
    assertEqual(out2.data.length, 1);
    assert(out2.notes.some(n => /unwrapped.*"extracted_data"/.test(n)));
  });

  it('slices out the JSON body from prose before/after it', () => {
    const text = 'Here is the JSON output:\n\n' + JSON.stringify([{ record_id: 'r1', finding_name: 'a' }]) + '\n\nLet me know if you need anything else!';
    const out = CsvImport._parseJson(text);
    assertEqual(out.data.length, 1);
    assert(out.notes.includes('ignored some text around the JSON'));
  });

  it('slices out a fenced code block anywhere in the text (not just file-start/end)', () => {
    const text = 'Sure, here you go:\n```json\n' + JSON.stringify([{ record_id: 'r1', finding_name: 'a' }], null, 2) + '\n```\nHope that helps!';
    const out = CsvImport._parseJson(text);
    assertEqual(out.data.length, 1);
    assert(out.notes.includes('ignored some text around the JSON'));
  });

  it('salvages complete leading objects from a truncated array and names the resume point', () => {
    const text = '[' + JSON.stringify({ record_id: 'r1', finding_name: 'a' })
      + ',' + JSON.stringify({ record_id: 'r2', finding_name: 'b' })
      + ',{"record_id":"r3","finding_n';
    const out = CsvImport._parseJson(text);
    assertEqual(out.data.length, 2);
    assertEqual(out.data[1].record_id, 'r2');
    assertEqual(out.errors.length, 0);
    assert(out.notes.some(n => /cut off/.test(n) && /recovered 2 complete findings/.test(n) && /record r2/.test(n)));
  });

  it('concatenates multiple top-level arrays (one per batch) with a note', () => {
    const text = JSON.stringify([{ record_id: 'r1', finding_name: 'a' }]) + '\n' + JSON.stringify([{ record_id: 'r2', finding_name: 'b' }]);
    const out = CsvImport._parseJson(text);
    assertEqual(out.data.length, 2);
    assert(out.notes.some(n => /found 2 separate batches/.test(n)));
  });

  it('normalizes curly "smart quotes" in the JSON envelope', () => {
    const text = '[{“record_id”: “r1”, “finding_name”: “a”}]';
    const out = CsvImport._parseJson(text);
    assertEqual(out.data.length, 1);
    assertEqual(out.data[0].record_id, 'r1');
    assert(out.notes.some(n => /smart quotes/.test(n)));
  });

  it('a clean, already-valid array produces zero notes (no false-positive repairs)', () => {
    const out = CsvImport._parseJson(JSON.stringify([{ record_id: 'r1', finding_name: 'a' }]));
    assertEqual(out.data.length, 1);
    assertDeepEqual(out.notes, []);
  });

  it('garbage with no bracket structure still fails loudly, unchanged', () => {
    const out = CsvImport._parseJson('This is not JSON at all, sorry.');
    assertEqual(out.data.length, 0);
    assertEqual(out.errors.length, 1);
    assertEqual(out.errors[0].type, 'fatal');
  });

  it('garbage with an unterminated, unparseable object still fails loudly', () => {
    const out = CsvImport._parseJson('{not json {{{ broken');
    assertEqual(out.data.length, 0);
    assertEqual(out.errors.length, 1);
    assertEqual(out.errors[0].type, 'fatal');
  });
});

// Code-review regressions: found by an adversarial review of the JSON-parse
// tolerance rules, confirmed by direct execution, and fixed in the same pass.
describe('CsvImport._parseJson — code-review regressions', () => {
  it('a lone finding object with an array-VALUED ATTRIBUTE (e.g. multi-value chronicity) is not mistaken for a wrapper key', () => {
    const out = CsvImport._parseJson(JSON.stringify({
      record_id: 'r1', finding_name: 'm', presence: 'present', source_text: 'x',
      chronicity: ['acute', 'chronic'],
    }));
    assertEqual(out.data.length, 1);
    assertDeepEqual(out.data[0], {
      record_id: 'r1', finding_name: 'm', presence: 'present', source_text: 'x',
      chronicity: ['acute', 'chronic'],
    });
    assert(out.notes.includes('wrapped your single finding into a list'));
  });

  it('a genuine {"findings": [...]} wrapper (array of OBJECTS) still unwraps correctly', () => {
    const out = CsvImport._parseJson(JSON.stringify({ findings: [{ record_id: 'r1', finding_name: 'a' }] }));
    assertEqual(out.data.length, 1);
    assert(out.notes.some(n => /unwrapped.*"findings"/.test(n)));
  });

  it('a stray unmatched bracket in prose before a complete JSON array no longer swallows the whole payload', () => {
    const text = 'Sure, processing report [1 now.\n\n'
      + JSON.stringify([{ record_id: 'R001', finding_name: 'a', source_text: 'x', presence: 'present' }]);
    const out = CsvImport._parseJson(text);
    assertEqual(out.data.length, 1);
    assertEqual(out.data[0].record_id, 'R001');
    assertEqual(out.errors.length, 0);
  });

  it('_looksLikeJsonText: a single tight comma in a terse preamble ("Sure,here you go") is not mistaken for a CSV header', () => {
    assert(CsvImport._looksLikeJsonText('Sure,here are the findings:\n\n[{"record_id":"r1"}]'));
  });

  it('_looksLikeJsonText: two or more tight commas still correctly rejects a real CSV header', () => {
    assert(!CsvImport._looksLikeJsonText('record_id,report_text\nr1,"Impression [see report]."'));
  });

  it('_looksLikeJsonText: a fenced code block with trailing whitespace after the language tag is still detected', () => {
    assert(CsvImport._looksLikeJsonText('Sure,here you go:\n```json \n[{"a":1}]\n```'));
  });
});

describe('CsvImport.detectColumns — P4: two-pass match (no bare substring)', () => {
  it('exact match takes precedence', () => {
    const { idCol } = CsvImport.detectColumns(['record_id', 'finding_name', 'source_text']);
    assertEqual(idCol, 'record_id');
  });

  it('case-insensitive exact match via Norm.colName', () => {
    const { idCol } = CsvImport.detectColumns(['Record ID', 'finding']);
    assertEqual(idCol, 'Record ID');
  });

  it('does NOT match `id` substring in `side`', () => {
    const { idCol } = CsvImport.detectColumns(['side', 'accession', 'finding_name']);
    assertEqual(idCol, 'accession', 'should not pick `side` for `id` pattern');
  });

  it('does NOT match `id` substring in `evidence`', () => {
    const { idCol } = CsvImport.detectColumns(['evidence', 'record_id', 'name']);
    assertEqual(idCol, 'record_id');
  });

  it('does NOT match `id` substring in `wide` or `midline`', () => {
    const { idCol } = CsvImport.detectColumns(['midline_shift', 'wide_field', 'case_id']);
    assertEqual(idCol, 'case_id', 'should pick `case_id` (token-boundary match)');
  });

  it('returns null when no field matches', () => {
    const { idCol } = CsvImport.detectColumns(['side', 'midline', 'name']);
    assertEqual(idCol, null);
  });

  it('finds textCol via token-boundary match', () => {
    const { textCol } = CsvImport.detectColumns(['record_id', 'rad_deid_report']);
    assertEqual(textCol, 'rad_deid_report');
  });
});

describe('CsvImport.parseExtractionCsv — P2: presence not coerced', () => {
  const baseColumnMap = {
    record_id: 'record_id',
    finding_name: 'finding_name',
    presence: 'presence',
    source_text: 'source_text',
  };

  it('preserves off-vocabulary presence value through parsing', () => {
    const rows = [{ record_id: 'r1', finding_name: 'thing', presence: 'probable', source_text: 'src' }];
    const { findings } = CsvImport.parseExtractionCsv(rows, baseColumnMap);
    assertEqual(findings.length, 1);
    assertEqual(findings[0].attributes.presence, 'probable',
      'raw value should pass through; validator should catch it later');
  });

  it('lowercases presence value', () => {
    const rows = [{ record_id: 'r1', finding_name: 'thing', presence: 'PRESENT', source_text: 'src' }];
    const { findings } = CsvImport.parseExtractionCsv(rows, baseColumnMap);
    assertEqual(findings[0].attributes.presence, 'present');
  });

  it('leaves presence null when the cell is empty so the validator can reject the row', () => {
    const rows = [{ record_id: 'r1', finding_name: 'thing', presence: '', source_text: 'src' }];
    const { findings } = CsvImport.parseExtractionCsv(rows, baseColumnMap);
    assertEqual(findings[0].attributes.presence, null);
  });

  it('leaves presence null when no presence column is mapped so the validator can reject the row', () => {
    const map = { record_id: 'record_id', finding_name: 'finding_name', source_text: 'source_text' };
    const rows = [{ record_id: 'r1', finding_name: 'thing', source_text: 'src' }];
    const { findings } = CsvImport.parseExtractionCsv(rows, map);
    assertEqual(findings[0].attributes.presence, null);
  });
});

describe('CsvImport.parseExtractionCsv — attribute sweep', () => {
  it('maps explicit columnMap attribute columns', () => {
    const map = {
      record_id: 'record_id', finding_name: 'finding_name', presence: 'presence',
      source_text: 'source_text', laterality: 'laterality', size: 'size',
    };
    const rows = [{
      record_id: 'r1', finding_name: 'thing', presence: 'present',
      source_text: 'src', laterality: 'left', size: '7 mm',
    }];
    const { findings } = CsvImport.parseExtractionCsv(rows, map);
    assertEqual(findings[0].attributes.laterality, 'left');
    assertEqual(findings[0].attributes.size, '7 mm');
  });

  it('parses features as a comma-separated array', () => {
    const map = {
      record_id: 'record_id', finding_name: 'finding_name', presence: 'presence',
      source_text: 'source_text', features: 'features',
    };
    const rows = [{
      record_id: 'r1', finding_name: 'thing', presence: 'present',
      source_text: 'src', features: 'cavitation, thin-walled, calcified',
    }];
    const { findings } = CsvImport.parseExtractionCsv(rows, map);
    assertDeepEqual(findings[0].attributes.features, ['cavitation', 'thin-walled', 'calcified']);
  });

  it('sweeps unmapped non-reserved columns as custom attributes', () => {
    const map = { record_id: 'record_id', finding_name: 'finding_name', source_text: 'source_text' };
    const rows = [{
      record_id: 'r1', finding_name: 'thing', source_text: 'src',
      my_custom_field: 'custom value',
    }];
    const { findings } = CsvImport.parseExtractionCsv(rows, map);
    assertEqual(findings[0].attributes.my_custom_field, 'custom value');
  });

  it('skips "nan" and "null" string values', () => {
    const map = {
      record_id: 'record_id', finding_name: 'finding_name', source_text: 'source_text',
      size: 'size',
    };
    const rows = [{
      record_id: 'r1', finding_name: 'thing', source_text: 'src', size: 'nan',
    }];
    const { findings } = CsvImport.parseExtractionCsv(rows, map);
    assertEqual(findings[0].attributes.size, undefined);
  });

  it('flags rows missing record_id or finding_name as errors', () => {
    const map = { record_id: 'record_id', finding_name: 'finding_name', source_text: 'source_text' };
    const rows = [
      { record_id: '', finding_name: 'thing', source_text: 'src' },
      { record_id: 'r1', finding_name: '', source_text: 'src' },
    ];
    const { findings, errors } = CsvImport.parseExtractionCsv(rows, map);
    assertEqual(findings.length, 0);
    assertEqual(errors.length, 2);
  });
});

describe('CsvImport.validateExtractionRows — P2: bad presence surfaces', () => {
  const reportsById = {
    r1: { record_id: 'r1', sentences: ['Brain: Some finding here.'] },
  };

  it('flags rows whose presence is not in the allowlist', () => {
    const parsed = [{
      record_id: 'r1', finding_name: 'thing', source_text: 'Some finding here',
      attributes: { presence: 'probable' },
    }];
    const summary = CsvImport.validateExtractionRows(
      parsed, reportsById, ATTR_CONFIG,
      { record_id: 'record_id', finding_name: 'finding_name', source_text: 'source_text', presence: 'presence' },
      ['record_id', 'finding_name', 'source_text', 'presence'],
      Sentences
    );
    assertEqual(summary.counts.badPresence, 1);
    assertEqual(summary.valid.length, 0);
    assertEqual(summary.invalid.length, 1);
  });

  it('accepts canonical presence values', () => {
    const parsed = [{
      record_id: 'r1', finding_name: 'thing', source_text: 'Some finding here',
      attributes: { presence: 'present' },
    }];
    const summary = CsvImport.validateExtractionRows(
      parsed, reportsById, ATTR_CONFIG,
      { record_id: 'record_id', finding_name: 'finding_name', source_text: 'source_text', presence: 'presence' },
      ['record_id', 'finding_name', 'source_text', 'presence'],
      Sentences
    );
    assertEqual(summary.counts.badPresence, 0);
    assertEqual(summary.valid.length, 1);
  });
});

describe('CsvImport.validateExtractionRows — missing presence', () => {
  const reportsById = {
    r1: { record_id: 'r1', sentences: ['Brain: Some finding here.'] },
  };
  const columnMap = { record_id: 'record_id', finding_name: 'finding_name', source_text: 'source_text', presence: 'presence' };
  const fields = ['record_id', 'finding_name', 'source_text', 'presence'];

  it('rejects row where presence is null (cell was empty at parse time)', () => {
    const parsed = [{
      record_id: 'r1', finding_name: 'thing', source_text: 'Some finding here',
      attributes: { presence: null },
    }];
    const summary = CsvImport.validateExtractionRows(parsed, reportsById, ATTR_CONFIG, columnMap, fields, Sentences);
    assertEqual(summary.counts.missingRequired, 1);
    assertEqual(summary.counts.ready, 0);
    assertEqual(summary.invalid.length, 1);
    assertIncludes(summary.invalid[0]._validation_errors[0].msg, 'presence');
  });

  it('rejects row where presence attribute is absent entirely', () => {
    const parsed = [{
      record_id: 'r1', finding_name: 'thing', source_text: 'Some finding here',
      attributes: {},
    }];
    const summary = CsvImport.validateExtractionRows(parsed, reportsById, ATTR_CONFIG, columnMap, fields, Sentences);
    assertEqual(summary.counts.missingRequired, 1);
    assertEqual(summary.counts.ready, 0);
    assertIncludes(summary.invalid[0]._validation_errors[0].msg, 'presence');
  });

  it('accepts row with explicit presence=indeterminate', () => {
    const parsed = [{
      record_id: 'r1', finding_name: 'thing', source_text: 'Some finding here',
      attributes: { presence: 'indeterminate' },
    }];
    const summary = CsvImport.validateExtractionRows(parsed, reportsById, ATTR_CONFIG, columnMap, fields, Sentences);
    assertEqual(summary.counts.missingRequired, 0);
    assertEqual(summary.counts.ready, 1);
    assertEqual(summary.valid.length, 1);
  });
});

describe('CsvImport.validateExtractionRows — cross-attribution split', () => {
  const reportsById = {
    r1: { record_id: 'r1', sentences: ['Brain: Cardiomegaly.'] },
    r2: { record_id: 'r2', sentences: ['Brain: Pleural effusion.'] },
    r3: { record_id: 'r3', sentences: ['Brain: Cardiomegaly.'] },
  };
  const columnMap = { record_id: 'record_id', finding_name: 'finding_name', source_text: 'source_text', presence: 'presence' };
  const fields = ['record_id', 'finding_name', 'source_text', 'presence'];

  it('empty source_text is caught by missingRequired, no cross-attribution check runs', () => {
    const parsed = [{
      record_id: 'r1', finding_name: 'thing', source_text: '',
      attributes: { presence: 'present' },
    }];
    const summary = CsvImport.validateExtractionRows(parsed, reportsById, ATTR_CONFIG, columnMap, fields, Sentences);
    assertEqual(summary.counts.missingRequired, 1);
    assertEqual(summary.counts.notInReport, 0);
    assertEqual(summary.counts.crossAttributed, 0);
  });

  it('text not found in any loaded report counts as notInReport, not crossAttributed', () => {
    const parsed = [{
      record_id: 'r1', finding_name: 'thing', source_text: 'Hallucinated text',
      attributes: { presence: 'present' },
    }];
    const summary = CsvImport.validateExtractionRows(parsed, reportsById, ATTR_CONFIG, columnMap, fields, Sentences);
    assertEqual(summary.counts.notInReport, 1);
    assertEqual(summary.counts.crossAttributed, 0);
  });

  it('text found only in a different loaded report counts as crossAttributed', () => {
    const parsed = [{
      record_id: 'r1', finding_name: 'effusion', source_text: 'Pleural effusion',
      attributes: { presence: 'present' },
    }];
    const summary = CsvImport.validateExtractionRows(parsed, reportsById, ATTR_CONFIG, columnMap, fields, Sentences);
    assertEqual(summary.counts.crossAttributed, 1);
    assertEqual(summary.counts.notInReport, 0);
    assertIncludes(summary.invalid[0]._validation_errors[0].msg, 'r2');
  });

  it('text found in the named report only passes validation cleanly, no warning', () => {
    const parsed = [{
      record_id: 'r2', finding_name: 'effusion', source_text: 'Pleural effusion',
      attributes: { presence: 'present' },
    }];
    const summary = CsvImport.validateExtractionRows(parsed, reportsById, ATTR_CONFIG, columnMap, fields, Sentences);
    assertEqual(summary.counts.ready, 1);
    assertEqual(summary.counts.ambiguousAcrossReports, 0);
  });

  it('text in named report plus other loaded reports passes but flags ambiguousAcrossReports warning', () => {
    const parsed = [{
      record_id: 'r1', finding_name: 'cardio', source_text: 'Cardiomegaly',
      attributes: { presence: 'present' },
    }];
    const summary = CsvImport.validateExtractionRows(parsed, reportsById, ATTR_CONFIG, columnMap, fields, Sentences);
    assertEqual(summary.counts.ready, 1);
    assertEqual(summary.counts.ambiguousAcrossReports, 1);
    assertEqual(summary.ambiguousAcrossReportsSamples.length, 1);
    assertEqual(summary.ambiguousAcrossReportsSamples[0].record_id, 'r1');
    assertDeepEqual(summary.ambiguousAcrossReportsSamples[0].alsoIn, ['r3']);
  });

  it('two reports with identical text and row attributed to one passes but flags ambiguousAcrossReports', () => {
    const parsed = [{
      record_id: 'r3', finding_name: 'cardio', source_text: 'Cardiomegaly',
      attributes: { presence: 'present' },
    }];
    const summary = CsvImport.validateExtractionRows(parsed, reportsById, ATTR_CONFIG, columnMap, fields, Sentences);
    assertEqual(summary.counts.ready, 1);
    assertEqual(summary.counts.ambiguousAcrossReports, 1);
  });
});

describe('CsvImport.validateExtractionRows — closest-sentence suggestion attachment (D4)', () => {
  const columnMap = { record_id: 'record_id', finding_name: 'finding_name', source_text: 'source_text', presence: 'presence' };
  const fields = ['record_id', 'finding_name', 'source_text', 'presence'];

  it('attaches a suggestion to a notInReport error when a paraphrase clears the fuzzy-match bar', () => {
    const reportsById = { r1: { record_id: 'r1', sentences: ['There is a 2 cm hypoechoic lesion in the spleen.'] } };
    const parsed = [{
      record_id: 'r1', finding_name: 'lesion', source_text: 'There is a 2cm hypoechoic lesion within the spleen.',
      attributes: { presence: 'present' },
    }];
    const summary = CsvImport.validateExtractionRows(parsed, reportsById, ATTR_CONFIG, columnMap, fields, Sentences);
    assertEqual(summary.counts.notInReport, 1);
    const err = summary.invalid[0]._validation_errors[0];
    assert(err.suggestion, 'expected a suggestion on the notInReport error');
    assertEqual(err.suggestion.idx, 1);
    assertEqual(err.suggestion.sentenceText, 'There is a 2 cm hypoechoic lesion in the spleen.');
  });

  it('NEVER attaches a suggestion to a crossAttributed error, even when the named report has its own fuzzy candidate', () => {
    const reportsById = {
      r1: { record_id: 'r1', sentences: ['There is a 2 cm hypoechoic lesion in the spleen.'] },
      r2: { record_id: 'r2', sentences: ['There is a 2cm hypoechoic lesion within the spleen.'] },
    };
    const parsed = [{
      record_id: 'r1', finding_name: 'lesion', source_text: 'There is a 2cm hypoechoic lesion within the spleen.',
      attributes: { presence: 'present' },
    }];
    const summary = CsvImport.validateExtractionRows(parsed, reportsById, ATTR_CONFIG, columnMap, fields, Sentences);
    assertEqual(summary.counts.crossAttributed, 1);
    assertEqual(summary.counts.notInReport, 0);
    const err = summary.invalid[0]._validation_errors[0];
    assertEqual(err.suggestion, undefined, 'a cross-attributed row must never carry a same-report suggestion');
  });

  it('no suggestion when nothing clears the fuzzy-match floor/margin', () => {
    const reportsById = {
      r1: {
        record_id: 'r1',
        sentences: ['Left kidney is normal in size and echogenicity.', 'Right kidney is normal in size and echogenicity.'],
      },
    };
    const parsed = [{
      record_id: 'r1', finding_name: 'kidney', source_text: 'Kidney shows normal size and echogenicity.',
      attributes: { presence: 'present' },
    }];
    const summary = CsvImport.validateExtractionRows(parsed, reportsById, ATTR_CONFIG, columnMap, fields, Sentences);
    assertEqual(summary.counts.notInReport, 1);
    const err = summary.invalid[0]._validation_errors[0];
    assertEqual(err.suggestion, undefined);
  });
});

describe('CsvImport.validateExtractionRows — B1: canonical-alias drift', () => {
  const reportsById = {
    r1: { record_id: 'r1', sentences: ['Brain: Some finding here.'] },
  };

  it('warns when a column looks like canonical laterality but was imported as custom', () => {
    const parsed = [{
      record_id: 'r1', finding_name: 'thing', source_text: 'Some finding here',
      attributes: { presence: 'present', lat_side: 'left' },
    }];
    const summary = CsvImport.validateExtractionRows(
      parsed, reportsById, ATTR_CONFIG,
      { record_id: 'record_id', finding_name: 'finding_name', source_text: 'source_text', presence: 'presence' },
      ['record_id', 'finding_name', 'source_text', 'presence', 'lat_side'],
      Sentences
    );
    const warnings = summary.canonicalAliasWarnings || [];
    const hit = warnings.find(w => w.column === 'lat_side' && w.suggestedKey === 'laterality');
    assert(hit, 'expected lat_side → laterality alias warning');
  });

  it('warns when a column looks like canonical temporal_status', () => {
    const parsed = [{
      record_id: 'r1', finding_name: 'thing', source_text: 'Some finding here',
      attributes: { presence: 'present', temporal: 'new' },
    }];
    const summary = CsvImport.validateExtractionRows(
      parsed, reportsById, ATTR_CONFIG,
      { record_id: 'record_id', finding_name: 'finding_name', source_text: 'source_text', presence: 'presence' },
      ['record_id', 'finding_name', 'source_text', 'presence', 'temporal'],
      Sentences
    );
    const warnings = summary.canonicalAliasWarnings || [];
    const hit = warnings.find(w => w.suggestedKey === 'temporal_status');
    assert(hit, 'expected temporal → temporal_status alias warning');
  });

  it('does NOT warn for truly custom columns with no canonical alias', () => {
    const parsed = [{
      record_id: 'r1', finding_name: 'thing', source_text: 'Some finding here',
      attributes: { presence: 'present', some_other_field: 'value' },
    }];
    const summary = CsvImport.validateExtractionRows(
      parsed, reportsById, ATTR_CONFIG,
      { record_id: 'record_id', finding_name: 'finding_name', source_text: 'source_text', presence: 'presence' },
      ['record_id', 'finding_name', 'source_text', 'presence', 'some_other_field'],
      Sentences
    );
    const warnings = summary.canonicalAliasWarnings || [];
    assertEqual(warnings.length, 0);
  });
});

describe('CsvImport.validateExtractionRows — B1: missing canonical columns on tool-export', () => {
  const reportsById = {
    r1: { record_id: 'r1', sentences: ['Brain: Some finding here.'] },
  };

  it('flags missing canonical columns when CSV looks like tool export', () => {
    const parsed = [{
      record_id: 'r1', finding_name: 'thing', source_text: 'Some finding here',
      attributes: { presence: 'present' },
    }];
    const fields = ['record_id', 'finding_name', 'source_text', 'taxonomy_id', 'presence'];
    const summary = CsvImport.validateExtractionRows(
      parsed, reportsById, ATTR_CONFIG,
      { record_id: 'record_id', finding_name: 'finding_name', source_text: 'source_text', presence: 'presence' },
      fields,
      Sentences
    );
    const missing = summary.missingCanonicalColumns || [];
    assertIncludes(missing, 'laterality');
    assertIncludes(missing, 'size');
  });

  it('does NOT flag missing canonical columns when CSV does not look like tool export', () => {
    const parsed = [{
      record_id: 'r1', finding_name: 'thing', source_text: 'Some finding here',
      attributes: { presence: 'present' },
    }];
    const fields = ['record_id', 'finding_name', 'source_text', 'presence'];  // no taxonomy_id
    const summary = CsvImport.validateExtractionRows(
      parsed, reportsById, ATTR_CONFIG,
      { record_id: 'record_id', finding_name: 'finding_name', source_text: 'source_text', presence: 'presence' },
      fields,
      Sentences
    );
    const missing = summary.missingCanonicalColumns || [];
    assertEqual(missing.length, 0);
  });
});

describe('CsvImport.validateExtractionRows — required fields and source_text matching', () => {
  const reportsById = {
    r1: { record_id: 'r1', sentences: ['Brain: Some finding here.'] },
    r2: { record_id: 'r2', sentences: ['Different content entirely.'] },
  };

  it('flags rows whose record_id is not in loaded reports', () => {
    const parsed = [{
      record_id: 'unknown', finding_name: 'thing', source_text: 'Some finding here',
      attributes: { presence: 'present' },
    }];
    const summary = CsvImport.validateExtractionRows(
      parsed, reportsById, ATTR_CONFIG,
      { record_id: 'record_id', finding_name: 'finding_name', source_text: 'source_text', presence: 'presence' },
      ['record_id', 'finding_name', 'source_text', 'presence'],
      Sentences
    );
    assertEqual(summary.counts.unknownRecord, 1);
    assertEqual(summary.valid.length, 0);
  });

  it('flags rows whose source_text does not match any sentence in the named report', () => {
    const parsed = [{
      record_id: 'r1', finding_name: 'thing', source_text: 'Nonexistent quote',
      attributes: { presence: 'present' },
    }];
    const summary = CsvImport.validateExtractionRows(
      parsed, reportsById, ATTR_CONFIG,
      { record_id: 'record_id', finding_name: 'finding_name', source_text: 'source_text', presence: 'presence' },
      ['record_id', 'finding_name', 'source_text', 'presence'],
      Sentences
    );
    assertEqual(summary.counts.notInReport, 1);
  });

  it('resolves source_sentence_idx for valid rows', () => {
    const parsed = [{
      record_id: 'r1', finding_name: 'thing', source_text: 'Some finding here',
      attributes: { presence: 'present' },
    }];
    const summary = CsvImport.validateExtractionRows(
      parsed, reportsById, ATTR_CONFIG,
      { record_id: 'record_id', finding_name: 'finding_name', source_text: 'source_text', presence: 'presence' },
      ['record_id', 'finding_name', 'source_text', 'presence'],
      Sentences
    );
    assertEqual(summary.valid.length, 1);
    assertEqual(summary.valid[0].source_sentence_idx, 1, 'should be 1-based');
  });
});

// ---------------------------------------------------------------------------
// Confidence (hedge) import + normalization + boolean coercion
// Plan: docs/plans/2026-07-01-attribute-hedge-and-flagging-plan.md (Step 7).
// ---------------------------------------------------------------------------

describe('CsvImport.normalizeConfidence — shape/value/invariant enforcement', () => {
  const attrs = { presence: 'present', chronicity: 'acute', laterality: 'left' };

  it('keeps hedged axes that have a backing attribute value', () => {
    const { confidence } = CsvImport.normalizeConfidence(
      { chronicity: 'hedged', laterality: 'hedged' }, attrs);
    assertDeepEqual(confidence, { chronicity: 'hedged', laterality: 'hedged' });
  });

  it('KEEPS a presence hedge when presence has a value (workbench polarity+hedge model)', () => {
    const { confidence } = CsvImport.normalizeConfidence({ presence: 'hedged' }, attrs);
    assertDeepEqual(confidence, { presence: 'hedged' });
  });

  it('drops a presence hedge when presence has no value (the has-value invariant still applies)', () => {
    const { confidence, notes } = CsvImport.normalizeConfidence({ presence: 'hedged' }, { chronicity: 'acute' });
    assertDeepEqual(confidence, {});
    assert(notes.some(n => /no value/i.test(n)), 'note should explain the missing value');
  });

  it('drops a non-"hedged" value with a note', () => {
    const { confidence, notes } = CsvImport.normalizeConfidence({ chronicity: 'probable' }, attrs);
    assertDeepEqual(confidence, {});
    assert(notes.length === 1, 'one note');
  });

  it('drops a hedge whose axis has no attribute value (the confidence invariant)', () => {
    const { confidence, notes } = CsvImport.normalizeConfidence(
      { chronicity: 'hedged' }, { presence: 'present' }); // no chronicity value
    assertDeepEqual(confidence, {});
    assert(notes.some(n => /no value/i.test(n)), 'note should explain the missing value');
  });

  it('degrades a wrong-typed value (array / bare string) to {} with a note', () => {
    const a = CsvImport.normalizeConfidence(['chronicity'], attrs);
    assertDeepEqual(a.confidence, {});
    assert(a.notes.length === 1);
    const s = CsvImport.normalizeConfidence('hedged', attrs);
    assertDeepEqual(s.confidence, {});
    assert(s.notes.length === 1);
  });

  it('legacy indeterminate alias: validator converts it (cue-aware) instead of rejecting', () => {
    const reportsById = { R1: { record_id: 'R1', sentences: ['No definite fracture.'] } };
    const neg = CsvImport.validateExtractionRows(
      [{ record_id: 'R1', finding_name: 'fracture', source_text: 'No definite fracture.', attributes: { presence: 'indeterminate' } }],
      reportsById, ATTR_CONFIG, {}, [], Sentences);
    assertEqual(neg.counts.badPresence, 0);
    assertEqual(neg.counts.presenceConverted, 1);
    assertEqual(neg.valid.length, 1);
    assertEqual(neg.valid[0].attributes.presence, 'absent'); // 'No definite' → absent
    assertEqual(neg.valid[0].confidence.presence, 'hedged');
    assertEqual(neg.valid[0]._polarityReview, true);
    assert(neg.conversionNotes.length === 1, 'one conversion note');
  });

  it('a genuinely unknown presence value is still rejected as badPresence', () => {
    const reportsById = { R1: { record_id: 'R1', sentences: ['No definite fracture.'] } };
    const res = CsvImport.validateExtractionRows(
      [{ record_id: 'R1', finding_name: 'fracture', source_text: 'No definite fracture.', attributes: { presence: 'maybe' } }],
      reportsById, ATTR_CONFIG, {}, [], Sentences);
    assertEqual(res.counts.badPresence, 1);
    assertEqual(res.invalid.length, 1);
  });

  it('multi-value axis: a comma-separated cell parses to an array and validates per element', () => {
    const REAL = require('../data/attributes.json');
    const map = { record_id: 'record_id', finding_name: 'finding_name', source_text: 'source_text', presence: 'presence', temporal_status: 'temporal_status' };
    const { findings } = CsvImport.parseExtractionCsv(
      [{ record_id: 'R1', finding_name: 'x', source_text: 's', presence: 'present', temporal_status: 'new, larger' }],
      map, null, REAL);
    assertDeepEqual(findings[0].attributes.temporal_status, ['new', 'larger']);

    const reportsById = { R1: { record_id: 'R1', sentences: ['s'] } };
    const good = CsvImport.validateExtractionRows(
      [{ record_id: 'R1', finding_name: 'x', source_text: 's', attributes: { presence: 'present', temporal_status: ['new', 'larger'] } }],
      reportsById, REAL, {}, [], Sentences);
    assertEqual(good.counts.badEnum, 0);

    const bad = CsvImport.validateExtractionRows(
      [{ record_id: 'R1', finding_name: 'x', source_text: 's', attributes: { presence: 'present', temporal_status: ['new', 'bogus'] } }],
      reportsById, REAL, {}, [], Sentences);
    assertEqual(bad.counts.badEnum, 1);
    assert(bad.invalid[0]._validation_errors.some(e => /bogus/.test(e.msg)), 'the row error names the offending element');
  });

  it('a null/empty raw yields {} with no note (no confidence provided)', () => {
    assertDeepEqual(CsvImport.normalizeConfidence(null, attrs), { confidence: {}, notes: [] });
    assertDeepEqual(CsvImport.normalizeConfidence({}, attrs), { confidence: {}, notes: [] });
  });
});

describe('CsvImport.parseExtractionCsv — confidence column', () => {
  const map = {
    record_id: 'record_id', finding_name: 'finding_name', source_text: 'source_text',
    presence: 'presence', chronicity: 'chronicity',
  };

  it('maps a valid confidence JSON column onto finding.confidence', () => {
    const rows = [{
      record_id: 'r1', finding_name: 'thing', source_text: 'x', presence: 'present',
      chronicity: 'acute', confidence: '{"chronicity":"hedged"}',
    }];
    const { findings, warnings } = CsvImport.parseExtractionCsv(rows, map, null, ATTR_CONFIG);
    assertEqual(findings[0].confidence.chronicity, 'hedged');
    assertEqual(warnings.length, 0);
  });

  it('degrades a malformed (unparseable) confidence cell to no-confidence + a warning', () => {
    const rows = [{
      record_id: 'r1', finding_name: 'thing', source_text: 'x', presence: 'present',
      chronicity: 'acute', confidence: '{not json',
    }];
    const { findings, warnings } = CsvImport.parseExtractionCsv(rows, map, null, ATTR_CONFIG);
    assertEqual(findings[0].confidence, undefined);
    assert(warnings.length === 1, 'one warning');
    assert(/Row 2:/.test(warnings[0]), 'warning carries row context');
  });

  it('drops a hedge whose backing attribute has no value (invariant), with a warning', () => {
    // confidence hedges chronicity, but the row has no chronicity value.
    const rows = [{
      record_id: 'r1', finding_name: 'thing', source_text: 'x', presence: 'present',
      confidence: '{"chronicity":"hedged"}',
    }];
    const { findings, warnings } = CsvImport.parseExtractionCsv(rows, map, null, ATTR_CONFIG);
    assertEqual(findings[0].confidence, undefined);
    assert(warnings.some(w => /no value/i.test(w)));
  });

  it('accepts <axis>_confidence=hedged columns as an alternative to the JSON column', () => {
    const rows = [{
      record_id: 'r1', finding_name: 'thing', source_text: 'x', presence: 'present',
      chronicity: 'acute', chronicity_confidence: 'hedged',
    }];
    const m2 = { ...map }; // chronicity_confidence is NOT mapped (consumed by confidence path)
    const { findings } = CsvImport.parseExtractionCsv(rows, m2, null, ATTR_CONFIG);
    assertEqual(findings[0].confidence.chronicity, 'hedged');
  });

  it('does not sweep the confidence column in as a custom attribute', () => {
    const rows = [{
      record_id: 'r1', finding_name: 'thing', source_text: 'x', presence: 'present',
      chronicity: 'acute', confidence: '{"chronicity":"hedged"}',
    }];
    const { findings } = CsvImport.parseExtractionCsv(rows, map, null, ATTR_CONFIG);
    assertEqual(findings[0].attributes.confidence, undefined);
    assertEqual(findings[0].attributes.chronicity_confidence, undefined);
  });

  // JSON extraction files (the LLM's native output shape) carry confidence as
  // an object, not a JSON-encoded string — parseFile's _parseJson path passes
  // objects through untouched. Regression for the bug where Norm.cell() ran
  // Object#toString() on the value first, producing "[object Object]" and a
  // silently-dropped hedge (js/extraction-import.js, confirmed against a real
  // run before the fix).
  it('accepts a native confidence OBJECT (the JSON extraction-file path) with the hedge intact', () => {
    const rows = [{
      record_id: 'r1', finding_name: 'thing', source_text: 'x', presence: 'present',
      chronicity: 'acute', confidence: { chronicity: 'hedged' },
    }];
    const { findings, warnings } = CsvImport.parseExtractionCsv(rows, map, null, ATTR_CONFIG);
    assertDeepEqual(findings[0].confidence, { chronicity: 'hedged' });
    assertEqual(warnings.length, 0);
  });

  it('still degrades a malformed confidence STRING (the CSV path, unchanged) to no-confidence + a warning', () => {
    const rows = [{
      record_id: 'r1', finding_name: 'thing', source_text: 'x', presence: 'present',
      chronicity: 'acute', confidence: '{not json',
    }];
    const { findings, warnings } = CsvImport.parseExtractionCsv(rows, map, null, ATTR_CONFIG);
    assertEqual(findings[0].confidence, undefined);
    assert(warnings.length === 1, 'one warning');
  });

  it('a native confidence object still enforces the has-value invariant', () => {
    const rows = [{
      record_id: 'r1', finding_name: 'thing', source_text: 'x', presence: 'present',
      confidence: { chronicity: 'hedged' },
    }];
    const { findings, warnings } = CsvImport.parseExtractionCsv(rows, map, null, ATTR_CONFIG);
    assertEqual(findings[0].confidence, undefined);
    assert(warnings.some(w => /no value/i.test(w)));
  });
});

describe('CsvImport.parseExtractionCsv — boolean attribute coercion', () => {
  // The canonical boolean is `aggregate`; its old name `multiple` is a legacy
  // alias converted by Schema.migrateLegacyAttributes (see the legacy schema
  // migration tests below).
  const map = {
    record_id: 'record_id', finding_name: 'finding_name', source_text: 'source_text',
    presence: 'presence', aggregate: 'aggregate',
  };
  const cfg = { ...ATTR_CONFIG, aggregate: { type: 'boolean', values: [] } };

  it('coerces aggregate=TRUE to the lowercase string "true"', () => {
    const rows = [{ record_id: 'r1', finding_name: 't', source_text: 'x', presence: 'present', aggregate: 'TRUE' }];
    const { findings } = CsvImport.parseExtractionCsv(rows, map, null, cfg);
    assertEqual(findings[0].attributes.aggregate, 'true');
  });

  it('drops a non-boolean aggregate value with a plain-language warning', () => {
    const rows = [{ record_id: 'r1', finding_name: 't', source_text: 'x', presence: 'present', aggregate: 'yes' }];
    const { findings, warnings } = CsvImport.parseExtractionCsv(rows, map, null, cfg);
    assertEqual(findings[0].attributes.aggregate, undefined);
    assert(warnings.some(w => /yes/.test(w) && /aggregate/.test(w)));
  });
});

// The prompt's worked example (js/extraction-example.js) IS the importer's
// contract fixture: this test feeds it through the exact same pipeline a
// real JSON extraction file takes (JSON text -> parseExtractionCsv ->
// validateExtractionRows) and asserts deep equality of every imported
// canonical finding, not merely zero errors. A future edit to either the
// prompt's example or the importer that breaks the pairing fails here.
describe('Fixture round-trip: ExtractionExample imports 100% clean with deep-equal findings', () => {
  const REAL_ATTR_CONFIG = require('../data/attributes.json');
  const columnMap = {
    record_id: 'record_id', finding_name: 'finding_name', presence: 'presence', source_text: 'source_text',
    laterality: 'laterality', anatomic_site: 'anatomic_site', aggregate: 'aggregate',
    temporal_status: 'temporal_status', size: 'size', chronicity: 'chronicity', extent: 'extent',
  };

  function runFixture() {
    const findingsSection = Sentences.parseFindingsSection(ExtractionExample.report);
    const { sentences } = Sentences.splitIntoSentences(findingsSection);
    const reportsById = { [ExtractionExample.recordId]: { record_id: ExtractionExample.recordId, sentences } };
    const { data, fields, errors: jsonErrors } = CsvImport._parseJson(JSON.stringify(ExtractionExample.findings));
    const { findings: parsed, errors, warnings } = CsvImport.parseExtractionCsv(
      data, columnMap, new Set([ExtractionExample.recordId]), REAL_ATTR_CONFIG
    );
    const summary = CsvImport.validateExtractionRows(parsed, reportsById, REAL_ATTR_CONFIG, columnMap, fields, Sentences);
    return { jsonErrors, errors, warnings, summary };
  }

  it('parses and validates with zero errors and zero warnings', () => {
    const { jsonErrors, errors, warnings, summary } = runFixture();
    assertEqual(jsonErrors.length, 0);
    assertEqual(errors.length, 0);
    assertEqual(warnings.length, 0);
    assertEqual(summary.invalid.length, 0);
  });

  it('counts.ready === counts.total (100% clean import)', () => {
    const { summary } = runFixture();
    assertEqual(summary.counts.ready, ExtractionExample.findings.length);
    assertEqual(summary.counts.total, ExtractionExample.findings.length);
  });

  it('every imported finding deep-equals the expected canonical shape (hedge, multi-value, aggregate, discrete-split, custom attribute, sentence anchoring)', () => {
    const { summary } = runFixture();
    const actual = summary.valid.map(f => ({
      finding_name: f.finding_name,
      source_sentence_idx: f.source_sentence_idx,
      attributes: f.attributes,
      confidence: f.confidence,
    }));
    const expected = [
      { finding_name: 'rib_fracture', source_sentence_idx: 1,
        attributes: { presence: 'present', laterality: 'left', anatomic_site: '6th rib' } },
      { finding_name: 'rib_fracture', source_sentence_idx: 1,
        attributes: { presence: 'present', laterality: 'right', anatomic_site: '9th rib' } },
      { finding_name: 'pulmonary_nodule', source_sentence_idx: 2,
        attributes: { presence: 'present', aggregate: 'true', temporal_status: ['unchanged'] } },
      { finding_name: 'pulmonary_nodule', source_sentence_idx: 3,
        attributes: { presence: 'present', laterality: 'right', anatomic_site: 'right upper lobe', size: '4 mm', margin: 'spiculated' } },
      { finding_name: 'mediastinal_hemorrhage', source_sentence_idx: 4,
        attributes: { presence: 'present', anatomic_site: 'anterior mediastinum', chronicity: ['acute', 'chronic'], extent: 'small' },
        confidence: { presence: 'hedged' } },
    ];
    assertDeepEqual(actual, expected);
  });

  it('flags "margin" as a custom (non-canonical) attribute', () => {
    const { summary } = runFixture();
    assert([...summary.customAttributes].includes('margin'), 'margin should be detected as custom');
  });
});

describe('CsvImport.validateExtractionRows — confidence columns reserved', () => {
  const reportsById = {
    r1: { record_id: 'r1', sentences: ['Some finding here.'] },
  };
  it('confidence + <axis>_confidence never appear in customAttributes nor the alias suggestions', () => {
    const parsed = [{
      record_id: 'r1', finding_name: 'thing', source_text: 'Some finding here',
      attributes: { presence: 'present', chronicity: 'acute' },
    }];
    const fields = ['record_id', 'finding_name', 'source_text', 'presence', 'chronicity', 'confidence', 'chronicity_confidence'];
    const summary = CsvImport.validateExtractionRows(
      parsed, reportsById, ATTR_CONFIG,
      { record_id: 'record_id', finding_name: 'finding_name', source_text: 'source_text', presence: 'presence', chronicity: 'chronicity' },
      fields, Sentences
    );
    assert(![...summary.customAttributes].includes('confidence'), 'confidence not custom');
    assert(![...summary.customAttributes].includes('chronicity_confidence'), 'chronicity_confidence not custom');
    assert(!summary.canonicalAliasWarnings.some(w => w.column === 'chronicity_confidence'),
      'chronicity_confidence not suggested as the chronicity alias');
  });
});

describe('CsvImport.parseExtractionCsv — legacy schema migration (old workbench exports)', () => {
  // Schema.init at the top of this file loads the REAL attributes.json, which
  // declares aggregate (boolean) and extent (small/medium/large). The
  // migration only fires onto keys the active schema declares.
  const map = { record_id: 'record_id', finding_name: 'finding_name', presence: 'presence', source_text: 'source_text', severity: 'severity' };

  it('moves a small/large severity to extent (old severity enum carried physical size)', () => {
    const rows = [{ record_id: 'r1', finding_name: 'pleural_effusion', presence: 'present', source_text: 'Small left pleural effusion.', severity: 'Small' }];
    const { findings, migrated, migrationNotes } = CsvImport.parseExtractionCsv(rows, map);
    assertEqual(findings[0].attributes.extent, 'small');
    assertEqual(findings[0].attributes.severity, undefined);
    assertEqual(migrated, 1);
    assert(migrationNotes.length >= 1, 'a plain-language note is emitted');
  });

  it('leaves a current severity value (mild/moderate/severe) alone', () => {
    const rows = [{ record_id: 'r1', finding_name: 'edema', presence: 'present', source_text: 'Mild edema.', severity: 'mild' }];
    const { findings, migrated } = CsvImport.parseExtractionCsv(rows, map);
    assertEqual(findings[0].attributes.severity, 'mild');
    assertEqual(findings[0].attributes.extent, undefined);
    assertEqual(migrated, 0);
  });

  it("renames the legacy 'multiple' column to aggregate and normalizes the boolean", () => {
    const rows = [{ record_id: 'r1', finding_name: 'nodule', presence: 'present', source_text: 'Multiple nodules.', multiple: 'True' }];
    const { findings } = CsvImport.parseExtractionCsv(rows, map); // unmapped -> custom sweep -> migration
    assertEqual(findings[0].attributes.aggregate, 'true');
    assertEqual(findings[0].attributes.multiple, undefined);
  });

  it("renames legacy 'anatomical_location' to anatomic_site when unmapped", () => {
    const rows = [{ record_id: 'r1', finding_name: 'nodule', presence: 'present', source_text: 'Nodule.', anatomical_location: 'left upper lobe' }];
    const { findings } = CsvImport.parseExtractionCsv(rows, map);
    assertEqual(findings[0].attributes.anatomic_site, 'left upper lobe');
    assertEqual(findings[0].attributes.anatomical_location, undefined);
  });

  it('never overwrites an existing extent; the conflicting severity stays for the validator to flag', () => {
    const rows = [{ record_id: 'r1', finding_name: 'x', presence: 'present', source_text: 'X.', severity: 'small', extent: 'large' }];
    const { findings, migrated } = CsvImport.parseExtractionCsv(rows, { ...map, extent: 'extent' });
    assertEqual(findings[0].attributes.extent, 'large');
    assertEqual(findings[0].attributes.severity, 'small');
    assertEqual(migrated, 0);
  });

  it('is idempotent: re-importing an already-migrated row changes nothing', () => {
    const rows = [{ record_id: 'r1', finding_name: 'x', presence: 'present', source_text: 'X.', extent: 'small', aggregate: 'true' }];
    const { findings, migrated } = CsvImport.parseExtractionCsv(rows, { ...map, severity: undefined, extent: 'extent', aggregate: 'aggregate' });
    assertEqual(findings[0].attributes.extent, 'small');
    assertEqual(findings[0].attributes.aggregate, 'true');
    assertEqual(migrated, 0);
  });
});

describe('CsvImport.parseExtractionCsv — dropped-row accounting', () => {
  const map = { record_id: 'record_id', finding_name: 'finding_name', presence: 'presence', source_text: 'source_text' };

  it('returns one dropped entry per unknown record_id, carrying the row identity', () => {
    const rows = [
      { record_id: 'r1', finding_name: 'a', presence: 'present', source_text: 'S1.' },
      { record_id: 'r9', finding_name: 'b', presence: 'present', source_text: 'S2.' },
    ];
    const { findings, dropped } = CsvImport.parseExtractionCsv(rows, map, new Set(['r1']));
    assertEqual(findings.length, 1);
    assertEqual(dropped.length, 1);
    assertEqual(dropped[0].record_id, 'r9');
    assertEqual(dropped[0].source_text, 'S2.');
    assert(dropped[0]._drop_reason.includes('not among'), 'reason names the unknown-id cause');
  });

  it('returns a dropped entry for a row missing finding_name', () => {
    const rows = [{ record_id: 'r1', finding_name: '', presence: 'present', source_text: 'S1.' }];
    const { dropped } = CsvImport.parseExtractionCsv(rows, map, new Set(['r1']));
    assertEqual(dropped.length, 1);
    assert(dropped[0]._drop_reason.includes('missing'));
  });
});

describe('CsvImport.validateExtractionRows — out-of-scope / boilerplate / multi-sentence buckets', () => {
  const columnMap = { record_id: 'record_id', finding_name: 'finding_name', source_text: 'source_text', presence: 'presence' };
  const fields = ['record_id', 'finding_name', 'source_text', 'presence'];
  const reportsById = {
    r1: {
      record_id: 'r1',
      report_text: 'FINDINGS Lungs: No evidence of pneumonia. IMPRESSION No acute cardiopulmonary process.',
      sentences: ['Lungs: No evidence of pneumonia.'],
    },
  };

  it('classifies a verbatim IMPRESSION quote as outOfScope with an honest message', () => {
    const parsed = [{ record_id: 'r1', finding_name: 'x', source_text: 'No acute cardiopulmonary process.', attributes: { presence: 'absent' } }];
    const summary = CsvImport.validateExtractionRows(parsed, reportsById, ATTR_CONFIG, columnMap, fields, Sentences);
    assertEqual(summary.counts.outOfScope, 1);
    assertEqual(summary.counts.notInReport, 0);
    assert(summary.invalid[0]._validation_errors[0].msg.includes('outside the FINDINGS section'));
  });

  it('a stitched findings+impression quote imports, anchored and review-flagged (multiSentence)', () => {
    const parsed = [{ record_id: 'r1', finding_name: 'x', source_text: 'No evidence of pneumonia. No acute cardiopulmonary process.', attributes: { presence: 'absent' } }];
    const summary = CsvImport.validateExtractionRows(parsed, reportsById, ATTR_CONFIG, columnMap, fields, Sentences);
    assertEqual(summary.counts.multiSentence, 1);
    assertEqual(summary.valid.length, 1);
    assertEqual(summary.valid[0].source_sentence_idx, 1);
    assertEqual(summary.valid[0]._needsReview, true);
  });

  // The named report words the templated line slightly differently, so the
  // quote is NOT a substring of its sentence but scores well fuzzily.
  const R1_VARIANT = {
    record_id: 'r1',
    report_text: 'FINDINGS Pleura: No pleural effusion or definite pneumothorax.',
    sentences: ['Pleura: No pleural effusion or definite pneumothorax.'],
  };
  const TEMPLATED_QUOTE = 'No pleural effusion or pneumothorax.';

  it('boilerplate wording (3+ other reports) keeps the closest-sentence suggestion', () => {
    const reports = {
      r1: R1_VARIANT,
      r2: { record_id: 'r2', report_text: '', sentences: [TEMPLATED_QUOTE] },
      r3: { record_id: 'r3', report_text: '', sentences: [TEMPLATED_QUOTE] },
      r4: { record_id: 'r4', report_text: '', sentences: [TEMPLATED_QUOTE] },
    };
    const parsed = [{ record_id: 'r1', finding_name: 'pneumothorax', source_text: TEMPLATED_QUOTE, attributes: { presence: 'absent' } }];
    const summary = CsvImport.validateExtractionRows(parsed, reports, ATTR_CONFIG, columnMap, fields, Sentences);
    assertEqual(summary.counts.boilerplate, 1);
    assertEqual(summary.counts.crossAttributed, 0);
    const err = summary.invalid[0]._validation_errors[0];
    assert(err.suggestion, 'boilerplate rows keep the one-click suggestion');
    assert(err.msg.includes('templated wording'));
  });

  it('a true mix-up signal (1 other report) still suppresses the suggestion', () => {
    const reports = {
      r1: R1_VARIANT,
      r2: { record_id: 'r2', report_text: '', sentences: [TEMPLATED_QUOTE] },
    };
    const parsed = [{ record_id: 'r1', finding_name: 'pneumothorax', source_text: TEMPLATED_QUOTE, attributes: { presence: 'absent' } }];
    const summary = CsvImport.validateExtractionRows(parsed, reports, ATTR_CONFIG, columnMap, fields, Sentences);
    assertEqual(summary.counts.crossAttributed, 1);
    assertEqual(summary.counts.boilerplate, 0);
    assert(!summary.invalid[0]._validation_errors[0].suggestion, 'mix-up rows never get a same-report suggestion');
  });

  it("never suggests 'tip_location' for a custom column named 'multiple' (substring false-positive regression)", () => {
    // aggregate is NOT in this attributeConfig, so the column stays custom —
    // the alias pass must not fall back to 'tip' ⊂ 'multiple'.
    const parsed = [{ record_id: 'r1', finding_name: 'x', source_text: 'No evidence of pneumonia.', attributes: { presence: 'absent' } }];
    const summary = CsvImport.validateExtractionRows(parsed, reportsById, ATTR_CONFIG, columnMap, [...fields, 'multiple'], Sentences);
    const w = (summary.canonicalAliasWarnings || []).find(x => x.column === 'multiple');
    assert(!w, `expected no alias warning for 'multiple', got ${w && w.suggestedKey}`);
  });

  it("treats 'multiple' as canonical-in-disguise (not custom) when the schema declares aggregate", () => {
    const cfg = { ...ATTR_CONFIG, aggregate: { type: 'boolean', values: [] } };
    const parsed = [{ record_id: 'r1', finding_name: 'x', source_text: 'No evidence of pneumonia.', attributes: { presence: 'absent' } }];
    const summary = CsvImport.validateExtractionRows(parsed, reportsById, cfg, columnMap, [...fields, 'multiple'], Sentences);
    assert(![...summary.customAttributes].includes('multiple'), 'legacy rename is not a custom column');
  });
});
