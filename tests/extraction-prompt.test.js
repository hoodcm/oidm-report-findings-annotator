/**
 * Tests for js/extraction-prompt.js — the LLM extraction prompt builder.
 *
 * Pins the contract so the Section A rewrite cannot silently regress:
 * required fields, one-report instruction, taxonomy injection, optional
 * fields rendered without presence, and one representative rule per
 * Section A cluster.
 */

const PROMPT_ATTR_CONFIG = {
  presence: { type: 'enum', values: ['present', 'absent', 'indeterminate'] },
  laterality: { type: 'enum', values: ['left', 'right', 'bilateral'] },
  temporal_status: { type: 'enum', values: ['unchanged', 'new', 'resolved'] },
  chronicity: { type: 'enum', values: ['acute', 'subacute', 'chronic'] },
  size: { type: 'text', description: 'Quantitative measurements', values: [] },
  features: { type: 'array', description: 'Descriptive properties', values: [] },
};

describe('ExtractionPrompt.build — required fields contract', () => {
  it('names all four required fields in the REQUIRED section', () => {
    const out = ExtractionPrompt.build({
      taxonomy: [],
      attributeConfig: PROMPT_ATTR_CONFIG,
      examType: 'CT Head',
    });
    assertIncludes(out, 'REQUIRED fields');
    assertIncludes(out, 'record_id');
    assertIncludes(out, 'finding_name');
    assertIncludes(out, 'presence');
    assertIncludes(out, 'source_text');
  });

  it('lists the three allowed presence values', () => {
    const out = ExtractionPrompt.build({
      taxonomy: [],
      attributeConfig: PROMPT_ATTR_CONFIG,
      examType: 'CT Head',
    });
    assertIncludes(out, '"present"');
    assertIncludes(out, '"absent"');
    assertIncludes(out, '"indeterminate"');
  });
});

describe('ExtractionPrompt.build — one-report discipline (A1, A2)', () => {
  it('states the one-report-at-a-time rule', () => {
    const out = ExtractionPrompt.build({
      taxonomy: [],
      attributeConfig: PROMPT_ATTR_CONFIG,
      examType: 'CT Head',
    });
    assertIncludes(out, 'ONE REPORT AT A TIME');
  });

  it('demands verbatim source_text', () => {
    const out = ExtractionPrompt.build({
      taxonomy: [],
      attributeConfig: PROMPT_ATTR_CONFIG,
      examType: 'CT Head',
    });
    assertIncludes(out, 'verbatim substring');
  });
});

describe('ExtractionPrompt.build — taxonomy injection', () => {
  it('renders each taxonomy entry as a dash-prefixed line', () => {
    const out = ExtractionPrompt.build({
      taxonomy: [{ name: 'pleural_effusion' }, { name: 'cardiomegaly' }],
      attributeConfig: PROMPT_ATTR_CONFIG,
      examType: 'CXR',
    });
    assertIncludes(out, '- pleural_effusion');
    assertIncludes(out, '- cardiomegaly');
  });

  it('renders the placeholder when no taxonomy is loaded', () => {
    const out = ExtractionPrompt.build({
      taxonomy: [],
      attributeConfig: PROMPT_ATTR_CONFIG,
      examType: '',
    });
    assertIncludes(out, '{load_a_taxonomy_to_populate_this_list}');
  });
});

describe('ExtractionPrompt.build — optional fields block', () => {
  it('does NOT include presence in the OPTIONAL fields block', () => {
    const out = ExtractionPrompt.build({
      taxonomy: [],
      attributeConfig: PROMPT_ATTR_CONFIG,
      examType: 'CT Head',
    });
    const optionalIdx = out.indexOf('OPTIONAL canonical fields');
    const rulesIdx = out.indexOf('EXTRACTION RULES');
    assert(optionalIdx > -1, 'OPTIONAL canonical fields section should exist');
    assert(rulesIdx > optionalIdx, 'EXTRACTION RULES should appear after OPTIONAL section');
    const optionalBlock = out.slice(optionalIdx, rulesIdx);
    assert(!optionalBlock.includes('presence'),
      'presence is required, must not appear in the OPTIONAL block: ' + optionalBlock);
  });

  it('renders enum values for an enum attribute', () => {
    const out = ExtractionPrompt.build({
      taxonomy: [],
      attributeConfig: PROMPT_ATTR_CONFIG,
      examType: 'CT Head',
    });
    assertIncludes(out, '"left" | "right" | "bilateral"');
  });

  it('renders the description for a text attribute', () => {
    const out = ExtractionPrompt.build({
      taxonomy: [],
      attributeConfig: PROMPT_ATTR_CONFIG,
      examType: 'CT Head',
    });
    assertIncludes(out, 'Quantitative measurements');
  });
});

describe('ExtractionPrompt.build — exam type injection', () => {
  it('lowercases the supplied exam type', () => {
    const out = ExtractionPrompt.build({
      taxonomy: [],
      attributeConfig: PROMPT_ATTR_CONFIG,
      examType: 'CT Head',
    });
    assertIncludes(out, 'each ct head radiology report');
  });

  it('renders <exam type> placeholder when omitted', () => {
    const out = ExtractionPrompt.build({
      taxonomy: [],
      attributeConfig: PROMPT_ATTR_CONFIG,
      examType: '',
    });
    assertIncludes(out, '<exam type>');
  });
});

describe('ExtractionPrompt.build — output format sentinel', () => {
  it('ends with the JSON-array-only instruction', () => {
    const out = ExtractionPrompt.build({
      taxonomy: [{ name: 'pleural_effusion' }],
      attributeConfig: PROMPT_ATTR_CONFIG,
      examType: 'CXR',
    });
    assertIncludes(out, 'Output only the JSON array');
  });
});

describe('ExtractionPrompt.build — Section A cluster smoke tests', () => {
  // One representative substring per cluster. Guards against accidental
  // cluster deletion during future edits.
  const out = ExtractionPrompt.build({
    taxonomy: [],
    attributeConfig: PROMPT_ATTR_CONFIG,
    examType: 'CT Head',
  });

  it('cluster 1 (do not infer): mentions interval -> temporal_status=new (A6)', () => {
    assertIncludes(out, 'Interval');
    assertIncludes(out, 'temporal_status="new"');
  });

  it('cluster 1: mentions diagnostic-uncertainty != presence-uncertainty (A17)', () => {
    assertIncludes(out, 'Diagnostic uncertainty');
  });

  it('cluster 1: mentions congenital has no slot in chronicity (A18)', () => {
    assertIncludes(out, 'Congenital');
  });

  it('cluster 2 (source_text discipline): primary lesion is must-have (A22)', () => {
    assertIncludes(out, 'PRIMARY LESION');
  });

  it('cluster 3 (slash/and): slash as co-occurrence (A3)', () => {
    assertIncludes(out, 'CO-OCCURRENCE');
  });

  it('cluster 3: effacement-of-X-with-displacement-of-Y rule (A5)', () => {
    assertIncludes(out, 'effacement of X with displacement of Y');
  });

  it('cluster 4 (one structure one row): mixed-age blood products (A20)', () => {
    assertIncludes(out, 'Mixed-age blood products');
  });

  it('cluster 4: bullet-sequence merge rule (A23)', () => {
    assertIncludes(out, 'sequential sentences inside a single bullet');
  });

  it('cluster 5 (attribute recall): plurals -> multiple (A7)', () => {
    assertIncludes(out, 'Plural forms');
    assertIncludes(out, 'multiple=true');
  });

  it('cluster 5: causal connectors emit named diagnosis with inheritance (A16)', () => {
    assertIncludes(out, 'compatible with');
    assertIncludes(out, 'inherit location/laterality/size');
  });

  it('cluster 5: density encodes chronicity for blood products (A21)', () => {
    assertIncludes(out, 'Hematoma density encodes chronicity');
    assertIncludes(out, 'hyperdense');
    assertIncludes(out, 'hypodense');
  });

  it('cluster 6 (field discipline): aneurysm_coil context rule (A4)', () => {
    assertIncludes(out, 'aneurysm_coil');
  });

  it('cluster 6: device removal -> presence=absent + temporal_status=resolved (A11)', () => {
    assertIncludes(out, 'Device removal');
    assertIncludes(out, 'presence="absent"');
    assertIncludes(out, 'temporal_status="resolved"');
  });

  it('cluster 6: residual-negation phrases do not generate absent findings (A15)', () => {
    assertIncludes(out, 'Residual-negation');
  });

  it('cluster 6: laterality only in laterality field, side stripped from anatomic_site (A25)', () => {
    assertIncludes(out, 'Encode laterality only in the laterality field');
  });
});
