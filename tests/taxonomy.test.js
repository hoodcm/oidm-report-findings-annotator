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
