/**
 * Tests for js/extraction-import.js — column detection, parsing, validation.
 */

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

  it('defaults to indeterminate when presence cell is empty', () => {
    const rows = [{ record_id: 'r1', finding_name: 'thing', presence: '', source_text: 'src' }];
    const { findings } = CsvImport.parseExtractionCsv(rows, baseColumnMap);
    assertEqual(findings[0].attributes.presence, 'indeterminate');
  });

  it('defaults to indeterminate when no presence column mapped', () => {
    const map = { record_id: 'record_id', finding_name: 'finding_name', source_text: 'source_text' };
    const rows = [{ record_id: 'r1', finding_name: 'thing', source_text: 'src' }];
    const { findings } = CsvImport.parseExtractionCsv(rows, map);
    assertEqual(findings[0].attributes.presence, 'indeterminate');
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
