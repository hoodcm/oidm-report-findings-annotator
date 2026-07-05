/**
 * Tests for js/extraction-prompt.js — the LLM extraction prompt builder.
 *
 * Pins the four-tier contract (task definition -> methodology -> guardrails
 * + worked example -> vocabulary, vocabulary LAST for truncation safety):
 * tier order, the surviving methodology rules, taxonomy grouping +
 * synonyms, corpus-aware ID/sample-ID injection, worked-example presence,
 * and the absence of the deleted head-CT-specific rules.
 */

const PROMPT_ATTR_CONFIG = {
  presence: { type: 'enum', values: ['present', 'absent'] },
  confidence: {
    type: 'map', values: [], value: 'hedged',
    allowed_axes: ['presence', 'laterality', 'chronicity'],
  },
  laterality: { type: 'enum', values: ['left', 'right', 'bilateral'] },
  temporal_status: { type: 'enum', values: ['unchanged', 'new', 'resolved'] },
  chronicity: { type: 'enum', values: ['acute', 'subacute', 'chronic'] },
  size: { type: 'text', description: 'Quantitative measurements', values: [] },
  features: { type: 'array', description: 'Descriptive properties', values: [] },
  aggregate: { type: 'boolean', description: 'Non-discrete collection flag', values: [] },
};

function build(opts) {
  return ExtractionPrompt.build({ taxonomy: [], attributeConfig: PROMPT_ATTR_CONFIG, examType: 'CT Head', ...opts });
}

describe('ExtractionPrompt.build — tier order', () => {
  it('emits TASK before OUTPUT CONTRACT/METHODOLOGY before GUARDRAILS + WORKED EXAMPLE before TAXONOMY', () => {
    const out = build();
    const taskIdx = out.indexOf('TASK.');
    const methodologyIdx = out.indexOf('METHODOLOGY.');
    const guardrailsIdx = out.indexOf('GUARDRAILS + WORKED EXAMPLE.');
    const taxonomyIdx = out.indexOf('TAXONOMY (');
    assert(taskIdx > -1 && methodologyIdx > -1 && guardrailsIdx > -1 && taxonomyIdx > -1, 'all four tier headers present');
    assert(taskIdx < methodologyIdx, 'TASK before METHODOLOGY');
    assert(methodologyIdx < guardrailsIdx, 'METHODOLOGY before GUARDRAILS + WORKED EXAMPLE');
    assert(guardrailsIdx < taxonomyIdx, 'GUARDRAILS + WORKED EXAMPLE before TAXONOMY (vocabulary last)');
  });

  it('the output-format sentinel is the very last line (truncation-safe close)', () => {
    const out = build({ taxonomy: [{ name: 'pleural_effusion', category: 'Pleura', synonyms: [] }] });
    assert(out.trim().endsWith('Output only the JSON array for the reports in this batch. No commentary, no markdown fencing, no extra text.'));
  });
});

describe('ExtractionPrompt.build — required fields contract', () => {
  it('names all four required fields', () => {
    const out = build();
    assertIncludes(out, 'REQUIRED fields');
    assertIncludes(out, 'record_id');
    assertIncludes(out, 'finding_name');
    assertIncludes(out, 'presence');
    assertIncludes(out, 'source_text');
  });

  it('lists the allowed presence values and no legacy indeterminate value', () => {
    const out = build();
    assertIncludes(out, '"present"');
    assertIncludes(out, '"absent"');
    assert(!out.includes('indeterminate'), 'prompt must not teach the retired indeterminate value');
  });

  it('derives the presence line from the passed attributeConfig, not a hardcoded list', () => {
    const out = build({ attributeConfig: { ...PROMPT_ATTR_CONFIG, presence: { type: 'enum', values: ['present', 'absent', 'uncertain'] } } });
    assertIncludes(out, '"uncertain"');
  });

  it('finding_name field points at the unmapped:<term> escape hatch, not a bare "make something up" instruction', () => {
    const out = build();
    assertIncludes(out, 'unmapped:<short_snake_case_name>');
  });
});

describe('ExtractionPrompt.build — CONFIDENCE (hedging) section', () => {
  it('teaches the hedge model with presence included, derived from allowed_axes', () => {
    const out = build();
    assertIncludes(out, 'CONFIDENCE');
    assertIncludes(out, '"presence"');
    assertIncludes(out, 'confidence={"presence":"hedged"}');
  });

  it('does NOT include confidence in the OPTIONAL fields block', () => {
    const out = build();
    const optionalIdx = out.indexOf('OPTIONAL canonical fields');
    const confidenceIdx = out.indexOf('CONFIDENCE');
    const optionalBlock = out.slice(optionalIdx, confidenceIdx);
    assert(!optionalBlock.includes('confidence'), 'confidence is metadata, must not appear in the OPTIONAL block');
  });
});

describe('ExtractionPrompt.build — every named attribute exists in attributeConfig', () => {
  it('every OPTIONAL field name the prompt lists is a key of the passed attributeConfig', () => {
    const out = build();
    const optionalIdx = out.indexOf('OPTIONAL canonical fields');
    const nextSectionIdx = out.indexOf('CONFIDENCE');
    const optionalBlock = out.slice(optionalIdx, nextSectionIdx);
    const namedKeys = Object.keys(PROMPT_ATTR_CONFIG).filter(k => k !== 'presence' && k !== 'confidence');
    for (const key of namedKeys) assertIncludes(optionalBlock, key);
  });
});

describe('ExtractionPrompt.build — optional fields block', () => {
  it('does NOT include presence in the OPTIONAL fields block', () => {
    const out = build();
    const optionalIdx = out.indexOf('OPTIONAL canonical fields');
    const confidenceIdx = out.indexOf('CONFIDENCE');
    const optionalBlock = out.slice(optionalIdx, confidenceIdx);
    assert(!optionalBlock.includes('presence'), 'presence is required, must not appear in the OPTIONAL block');
  });

  it('renders enum values for an enum attribute', () => {
    const out = build();
    assertIncludes(out, '"left" | "right" | "bilateral"');
  });

  it('renders the description for a text attribute', () => {
    const out = build();
    assertIncludes(out, 'Quantitative measurements');
  });
});

describe('ExtractionPrompt.build — exam type injection', () => {
  it('lowercases the supplied exam type', () => {
    const out = build();
    assertIncludes(out, 'batch of ct head radiology reports');
  });

  it('renders <exam type> placeholder when omitted', () => {
    const out = build({ examType: '' });
    assertIncludes(out, '<exam type>');
  });
});

describe('ExtractionPrompt.build — taxonomy injection (grouped by category, synonyms)', () => {
  it('renders the placeholder when no taxonomy is loaded', () => {
    const out = build({ taxonomy: [] });
    assertIncludes(out, '{load_a_taxonomy_to_populate_this_list}');
  });

  it('groups findings under their category header', () => {
    const out = build({
      taxonomy: [
        { name: 'pleural_effusion', category: 'Pleura', synonyms: [] },
        { name: 'cardiomegaly', category: 'Cardiac', synonyms: [] },
        { name: 'pneumothorax', category: 'Pleura', synonyms: [] },
      ],
    });
    const taxonomyBlock = out.slice(out.indexOf('TAXONOMY ('));
    const pleuraIdx = taxonomyBlock.indexOf('Pleura:');
    const cardiacIdx = taxonomyBlock.indexOf('Cardiac:');
    const effusionIdx = taxonomyBlock.indexOf('- pleural_effusion');
    const pneumoIdx = taxonomyBlock.indexOf('- pneumothorax');
    assert(pleuraIdx > -1 && cardiacIdx > -1, 'both category headers present');
    assert(pleuraIdx < effusionIdx && pleuraIdx < pneumoIdx, 'both Pleura findings render under the Pleura header');
    assert(pneumoIdx < cardiacIdx, 'both Pleura findings are grouped together, not interleaved with Cardiac');
  });

  it('renders synonyms as "also called: ..."', () => {
    const out = build({ taxonomy: [{ name: 'pleural_effusion', category: 'Pleura', synonyms: ['pleural fluid', 'fluid in the pleural space'] }] });
    assertIncludes(out, 'pleural_effusion (also called: pleural fluid, fluid in the pleural space)');
  });

  it('findings with no category fall back to "Other"', () => {
    const out = build({ taxonomy: [{ name: 'widget', synonyms: [] }] });
    assertIncludes(out, 'Other:');
    assertIncludes(out, '- widget');
  });

  it('states the unmapped:<term> escape hatch once, on the TAXONOMY header', () => {
    const out = build({ taxonomy: [{ name: 'pleural_effusion', category: 'Pleura', synonyms: [] }] });
    assertIncludes(out, 'unmapped:<term>');
  });
});

describe('ExtractionPrompt.build — corpus-aware ID column + sample-ID injection', () => {
  it('names the real ID column and sample IDs when a corpus is loaded', () => {
    const out = build({ corpus: { idColumn: 'accession_number', sampleIds: ['ARN-0001', 'ARN-0002'] } });
    assertIncludes(out, '`accession_number` column');
    assertIncludes(out, 'ARN-0001, ARN-0002');
  });

  it('degrades to generic wording when no corpus is loaded', () => {
    const out = build();
    assertIncludes(out, 'its ID column');
    assert(!out.includes('column looks like'), 'no sample-ID phrase without a corpus');
  });

  it('degrades to generic wording when corpus is loaded but sampleIds is empty', () => {
    const out = build({ corpus: { idColumn: 'accession_number', sampleIds: [] } });
    assertIncludes(out, '`accession_number` column');
    assert(!out.includes('column looks like'), 'no sample-ID phrase with an empty sample list');
  });
});

describe('ExtractionPrompt.build — worked example (shared fixture)', () => {
  it('embeds the fixture report excerpt, its exact JSON, and its commentary notes', () => {
    const out = build();
    assertIncludes(out, ExtractionExample.report.replace(/^FINDINGS:\s*/i, ''));
    assertIncludes(out, JSON.stringify(ExtractionExample.findings, null, 2));
    for (const note of ExtractionExample.notes) assertIncludes(out, note);
  });

  it('names the example record_id and warns never to emit it on real data', () => {
    const out = build();
    assertIncludes(out, ExtractionExample.recordId);
    assertIncludes(out, 'never emit it on real data');
  });

  it('states the bare-JSON-array guardrail before the example', () => {
    const out = build();
    const guardrailIdx = out.indexOf('Output ONLY the bare JSON array');
    const exampleIdx = out.indexOf('Excerpt from a FINDINGS section');
    assert(guardrailIdx > -1 && exampleIdx > -1 && guardrailIdx < exampleIdx);
  });
});

describe('ExtractionPrompt.build — surviving methodology rules (one phrase each)', () => {
  const out = build();

  it('one-sentence-per-finding rule replaces the old one-report-at-a-time rule', () => {
    assertIncludes(out, 'ONE SENTENCE PER FINDING');
    assertIncludes(out, 'verbatim substring of exactly ONE sentence');
  });

  it('don\'t-infer rule is a single condensed line', () => {
    assertIncludes(out, "DON'T INFER WHAT THE TEXT DOESN'T STATE");
  });

  it('enum discipline rule', () => {
    assertIncludes(out, 'ENUM DISCIPLINE');
  });

  it('aggregate vs. discrete rows rule, with the characterized-index-member extension', () => {
    assertIncludes(out, 'AGGREGATE VS. DISCRETE ROWS');
    assertIncludes(out, 'aggregate="true"');
    assertIncludes(out, 'distinguishing detail');
  });

  it('free-text-in-features-only rule', () => {
    assertIncludes(out, 'FREE TEXT LIVES IN FEATURES OR CUSTOM FIELDS ONLY');
  });

  it('laterality-stays-in-laterality-field rule', () => {
    assertIncludes(out, 'LATERALITY STAYS IN THE LATERALITY FIELD');
  });

  it('batch-output-in-chunks rule (new: preempts truncation)', () => {
    assertIncludes(out, 'OUTPUT IN CHUNKS OF ABOUT 5 REPORTS');
  });
});

describe('ExtractionPrompt.build — deleted head-CT-specific rules are gone', () => {
  const out = build({
    taxonomy: [{ name: 'craniotomy', category: 'Procedure', synonyms: [] }],
  });

  it('no slash-semantics rule', () => {
    assert(!out.includes('CO-OCCURRENCE'), 'slash/and co-occurrence rule must be deleted');
    assert(!out.includes('effacement of X with displacement of Y'), 'effacement/displacement rule must be deleted');
  });

  it('no hematoma-density-to-chronicity mapping', () => {
    assert(!out.includes('Hematoma density encodes chronicity'), 'hematoma density rule must be deleted');
    assert(!/hyperdense|hypodense/.test(out), 'density vocabulary must be deleted');
  });

  it('no craniotomy/burr-hole splitting rule (taxonomy entries may still legitimately be named "craniotomy")', () => {
    assert(!out.includes('craniotomy / burr hole'), 'craniotomy/burr-hole splitting rule must be deleted');
    assert(!out.includes('burr hole'), 'burr hole phrase must be deleted');
  });

  it('no device-removal choreography rule', () => {
    assert(!out.includes('Device removal, retrieval, withdrawal'), 'device-removal rule must be deleted');
  });

  it('no old one-report-at-a-time rule text', () => {
    assert(!out.includes('ONE REPORT AT A TIME'), 'one-report-at-a-time rule must be deleted (replaced by the batch contract)');
    assert(!out.includes('Do not batch multiple reports into a single call'), 'old batching prohibition must be deleted');
  });

  it('no diagnostic-vs-observation nuance beyond the one condensed don\'t-infer line', () => {
    assert(!out.includes('Diagnostic uncertainty'), 'diagnostic-uncertainty cluster must be deleted');
    assert(!out.includes('Congenital and developmental-variant'), 'congenital-chronicity cluster must be deleted');
  });

  it('no aneurysm_coil field-discipline example', () => {
    assert(!out.includes('aneurysm_coil'), 'aneurysm_coil context rule must be deleted');
  });

  it('no residual-negation phrase rule', () => {
    assert(!out.includes('Residual-negation'), 'residual-negation rule must be deleted');
  });

  it('no paired-bilateral-substrates rule', () => {
    assert(!out.includes('Paired-bilateral substrates'), 'paired-bilateral rule must be deleted');
  });

  it('no causal-connector diagnosis-inheritance rule', () => {
    assert(!out.includes('compatible with'), 'causal-connector rule must be deleted');
    assert(!out.includes('inherit location/laterality/size'), 'causal-connector inheritance rule must be deleted');
  });
});
