/**
 * Tests for js/taxonomy.js — search and matching.
 */

const SAMPLE_TAXONOMY = [
  { id: 'HID001', name: 'cerebral edema', synonyms: ['brain swelling', 'cerebral swelling'], category: 'brain', parent_id: null, finding_type: 'observation' },
  { id: 'HID002', name: 'subdural hemorrhage', synonyms: ['subdural hematoma', 'SDH'], category: 'hemorrhage', parent_id: null, finding_type: 'observation' },
  { id: 'HID003', name: 'craniotomy', synonyms: [], category: 'surgical', parent_id: null, finding_type: 'procedure' },
];

describe('Taxonomy.findByName', () => {
  it('finds by exact name (case-insensitive)', () => {
    const f = Taxonomy.findByName('Cerebral Edema', SAMPLE_TAXONOMY);
    assertEqual(f && f.id, 'HID001');
  });

  it('finds by synonym', () => {
    const f = Taxonomy.findByName('SDH', SAMPLE_TAXONOMY);
    assertEqual(f && f.id, 'HID002');
  });

  it('returns null for unknown name', () => {
    const f = Taxonomy.findByName('not in taxonomy', SAMPLE_TAXONOMY);
    assertEqual(f, null);
  });
});

describe('Taxonomy.normalizeName', () => {
  it('lowercases and replaces spaces with underscores', () => {
    assertEqual(Taxonomy.normalizeName('Cerebral Edema'), 'cerebral_edema');
  });

  it('trims whitespace', () => {
    assertEqual(Taxonomy.normalizeName('  spaces  '), 'spaces');
  });
});

describe('Taxonomy.matchFindingToTaxonomy', () => {
  it('matches direct canonical name', () => {
    const m = Taxonomy.matchFindingToTaxonomy('cerebral_edema', SAMPLE_TAXONOMY);
    assertEqual(m && m.id, 'HID001');
  });

  it('matches via spaces→underscore normalization', () => {
    const m = Taxonomy.matchFindingToTaxonomy('Cerebral Edema', SAMPLE_TAXONOMY);
    assertEqual(m && m.id, 'HID001');
  });

  it('matches via synonym', () => {
    const m = Taxonomy.matchFindingToTaxonomy('SDH', SAMPLE_TAXONOMY);
    assertEqual(m && m.id, 'HID002');
  });
});

describe('Taxonomy.searchFindings', () => {
  it('returns all findings for empty query', () => {
    assertEqual(Taxonomy.searchFindings('', SAMPLE_TAXONOMY).length, SAMPLE_TAXONOMY.length);
  });

  it('matches case-insensitive substring on name', () => {
    const r = Taxonomy.searchFindings('Edema', SAMPLE_TAXONOMY);
    assertEqual(r.length, 1);
    assertEqual(r[0].id, 'HID001');
  });

  it('matches substring on synonym', () => {
    const r = Taxonomy.searchFindings('brain swelling', SAMPLE_TAXONOMY);
    assertEqual(r.length, 1);
    assertEqual(r[0].id, 'HID001');
  });
});

describe('Taxonomy.matchFindingToTaxonomy — null on unmatched', () => {
  it('returns null cleanly for a name with no canonical, synonym, or fuzzy match', () => {
    const m = Taxonomy.matchFindingToTaxonomy('not a real radiology term', SAMPLE_TAXONOMY);
    assertEqual(m, null);
  });

  it('returns null when input has only modifier tokens (filtered to empty set)', () => {
    // 'left right' contains only MODIFIERS tokens; fuzzyMatchFinding short-circuits.
    const m = Taxonomy.matchFindingToTaxonomy('left right', SAMPLE_TAXONOMY);
    assertEqual(m, null);
  });
});

describe('Taxonomy.fuzzyMatchFinding — Jaccard threshold boundary', () => {
  // Pin that the default threshold is 0.5 inclusive. A future tightening to
  // 0.6 or a loosening to 0.4 would silently shift which extraction rows
  // auto-map onto the taxonomy.
  const tax = [
    { id: 'X1', name: 'subdural hemorrhage', synonyms: [], category: 'h', parent_id: null, finding_type: 'observation' },
  ];

  it('score 0.5 exactly matches (boundary is inclusive)', () => {
    // tokens: input ['subdural'], tax ['subdural', 'hemorrhage'] → 1/2 = 0.5
    const r = Taxonomy.fuzzyMatchFinding('subdural', tax);
    assert(r && r.finding.id === 'X1', 'expected match at the 0.5 boundary');
    assertEqual(r.score, 0.5);
  });

  it('score below threshold returns null', () => {
    // tokens: input ['subdural', 'mass'], tax ['subdural', 'hemorrhage'] → 1/3 ≈ 0.33
    const r = Taxonomy.fuzzyMatchFinding('subdural mass', tax);
    assertEqual(r, null);
  });
});

// Intentionally NOT tested: laterality / MODIFIERS-strip discrimination
// ('left edema' vs 'right edema' vs generic 'edema'). The current behavior
// collapses left/right onto the generic entry via the MODIFIERS strip, and
// the product decision is deferred — see TODO.md ("Partial-match search
// shortcut"). When that decision lands, encode it as a paired
// should-fire / shouldn't-fire test pinning the chosen behavior.

describe('Taxonomy.findByExactOrSynonym — separator-agnostic exact matching', () => {
  // Regression for the "everything is a 100% fuzzy match" confusion: the old
  // exact matcher folded only the INPUT's separators, so an underscore-styled
  // taxonomy ("airspace_opacity") never matched its own name exactly and
  // every multi-word finding fell to the fuzzy tier at 100%.
  const TAX = [
    { id: 'F1', name: 'airspace_opacity', synonyms: ['Air space opacity', 'Infiltrate'] },
    { id: 'F2', name: 'atelectasis', synonyms: [] },
    { id: 'F3', name: 'pleural effusion', synonyms: [] },
  ];

  it('matches an underscore input to an underscore taxonomy name exactly', () => {
    assertEqual((Taxonomy.findByExactOrSynonym('airspace_opacity', TAX) || {}).id, 'F1');
  });

  it('matches across separator styles in both directions', () => {
    assertEqual((Taxonomy.findByExactOrSynonym('airspace opacity', TAX) || {}).id, 'F1');
    assertEqual((Taxonomy.findByExactOrSynonym('pleural_effusion', TAX) || {}).id, 'F3');
  });

  it('matches synonyms with the same folding', () => {
    assertEqual((Taxonomy.findByExactOrSynonym('infiltrate', TAX) || {}).id, 'F1');
    assertEqual((Taxonomy.findByExactOrSynonym('air_space_opacity', TAX) || {}).id, 'F1');
  });

  it('returns null when nothing matches exactly (fuzzy is a separate tier)', () => {
    assertEqual(Taxonomy.findByExactOrSynonym('opacity', TAX), null);
  });

  it('matchFindingToTaxonomy resolves an exact underscore name without fuzzy', () => {
    assertEqual((Taxonomy.matchFindingToTaxonomy('airspace_opacity', TAX) || {}).id, 'F1');
  });
});

describe('Taxonomy.fuzzyMatchFinding — underscore tokenization', () => {
  it('tokenizes underscore names so partial overlap scores fractionally (not 0 or 100%)', () => {
    const TAX = [{ id: 'F1', name: 'calcified_pulmonary_nodule', synonyms: [] }];
    const r = Taxonomy.fuzzyMatchFinding('pulmonary_nodule', TAX, 0.5);
    assert(r && r.finding.id === 'F1', 'partial-overlap name should still match');
    assert(r.score > 0.5 && r.score < 1, `score should be fractional, got ${r && r.score}`);
  });
});
