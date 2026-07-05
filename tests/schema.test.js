// Schema accessor contract (D1), asserted against the REAL data/attributes.json
// so the accessors stay in lockstep with the shipped config.

const cfg = require('../data/attributes.json');
Schema.init(cfg);

describe('Schema.presenceValues / hedgeable / multiValue', () => {
  it('presenceValues reflects cfg.presence.values', () => {
    assertDeepEqual(Schema.presenceValues(), cfg.presence.values);
  });

  it('presence is a hedgeable axis under the workbench model', () => {
    assertEqual(Schema.presenceHedgeable(), true);
    assertEqual(Schema.isHedgeable('presence'), true);
    assertEqual(Schema.isHedgeable('laterality'), true);
    assertEqual(Schema.isHedgeable('not_an_axis'), false);
  });

  it('temporal_status and chronicity are multi-value; scalar axes are not', () => {
    assertEqual(Schema.isMultiValue('temporal_status'), true);
    assertEqual(Schema.isMultiValue('chronicity'), true);
    assertEqual(Schema.isMultiValue('laterality'), false);
    assertEqual(Schema.isMultiValue('presence'), false);
  });
});

describe('Schema.findingAttributeKeys excludes metadata keys', () => {
  it('excludes presence and confidence; includes real attributes', () => {
    const keys = Schema.findingAttributeKeys();
    assert(!keys.includes('presence'), 'presence must be excluded (own control)');
    assert(!keys.includes('confidence'), 'confidence must be excluded (hedge map)');
    assert(keys.includes('laterality'), 'laterality is annotatable');
    assert(keys.includes('chronicity'), 'chronicity is annotatable');
  });

  it('attributeKeys (raw) still includes the metadata keys', () => {
    const raw = Schema.attributeKeys();
    assert(raw.includes('presence') && raw.includes('confidence'), 'raw keys keep metadata');
  });
});

describe('Schema.presenceOptions spectrum', () => {
  it('renders four options in spectrum order, each with a distinct Tabler icon class', () => {
    const opts = Schema.presenceOptions();
    assertDeepEqual(
      opts.map(o => ({ presence: o.presence, hedged: o.hedged })),
      [
        { presence: 'present', hedged: false },
        { presence: 'present', hedged: true },
        { presence: 'absent', hedged: true },
        { presence: 'absent', hedged: false },
      ]
    );
    // ti-circle-check / ti-circle-dashed-check / ti-circle-dashed / ti-circle-dotted —
    // four distinct glyphs in the vendored font (unlike the old ti-percentage-*
    // family, which collapsed the 100%/0% glyphs to the same shape — confirmed
    // against the actual font file, an upstream Tabler bug).
    assert(opts.every(o => o.icon && o.icon.startsWith('ti-circle-')), 'every option carries a ti-circle-* icon class');
    const uniqueIcons = new Set(opts.map(o => o.icon));
    assertEqual(uniqueIcons.size, 4, 'all four spectrum options render visually distinct icons');
    assertEqual(opts[0].icon, 'ti-circle-check', 'present (100%) is a solid check');
    assertEqual(opts[3].icon, 'ti-circle-dotted', 'absent (0%) is a bare dotted ring');
  });

  it('falls back to plain options when presence is not hedgeable (handles both models)', () => {
    Schema.init({ presence: { type: 'enum', values: ['present', 'absent', 'indeterminate'] }, confidence: { allowed_axes: [] } });
    const opts = Schema.presenceOptions();
    assertEqual(opts.length, 3);
    assertDeepEqual(opts.map(o => o.presence), ['present', 'absent', 'indeterminate']);
    assert(opts.every(o => o.hedged === false), 'plain options are never hedged');
    Schema.init(cfg); // restore
  });
});

describe('Schema.convertIndeterminate (cue-aware legacy conversion)', () => {
  it('leans absent when the source text carries a negation cue', () => {
    for (const t of ['No definite fracture', 'without acute hemorrhage', 'not identified', 'unremarkable', 'negative for infarct', 'unlikely to represent']) {
      assertDeepEqual(Schema.convertIndeterminate(t), { presence: 'absent', hedge: true, review: true });
    }
  });
  it('leans present otherwise (and on empty source text)', () => {
    assertDeepEqual(Schema.convertIndeterminate('Possible pneumonia'), { presence: 'present', hedge: true, review: true });
    assertDeepEqual(Schema.convertIndeterminate(''), { presence: 'present', hedge: true, review: true });
    assertDeepEqual(Schema.convertIndeterminate(undefined), { presence: 'present', hedge: true, review: true });
  });
});

describe('Schema.enumValues feeds the validator cleanly (property)', () => {
  it('every declared enum value passes the validator predicate it will feed', () => {
    // The validator accepts v iff cfg.values.map(lowercase).includes(v.toLowerCase()).
    for (const key of Schema.findingAttributeKeys()) {
      const c = cfg[key];
      if (!c || c.type !== 'enum') continue;
      const allowed = c.values.map(s => s.toLowerCase());
      assertDeepEqual(Schema.enumValues(key), c.values);
      for (const v of c.values) {
        assert(allowed.includes(String(v).toLowerCase()), `enum value ${v} of ${key} must validate`);
      }
    }
  });
});

describe('Schema.migrateLegacyAttributes — old schema names/values (2026-07-05 forensics)', () => {
  // Uses the REAL attributes.json init from the top of this file: aggregate
  // (boolean) and extent (small/medium/large) are declared there.
  it('moves severity small/medium/large to extent, lowercased', () => {
    const attrs = { presence: 'present', severity: 'Large' };
    const notes = Schema.migrateLegacyAttributes(attrs);
    assertEqual(attrs.extent, 'large');
    assertEqual(attrs.severity, undefined);
    assertEqual(notes.length, 1);
  });

  it('renames multiple → aggregate with boolean normalization', () => {
    const attrs = { presence: 'present', multiple: 'True' };
    Schema.migrateLegacyAttributes(attrs);
    assertEqual(attrs.aggregate, 'true');
    assertEqual(attrs.multiple, undefined);
  });

  it('is idempotent and never overwrites an existing value', () => {
    const attrs = { presence: 'present', severity: 'small', extent: 'medium', multiple: 'true', aggregate: 'false' };
    const notes = Schema.migrateLegacyAttributes(attrs);
    assertEqual(notes.length, 0);
    assertEqual(attrs.extent, 'medium');
    assertEqual(attrs.severity, 'small');
    assertEqual(attrs.aggregate, 'false');
  });

  it('does nothing when the active schema lacks the target key', () => {
    const saved = Schema._cfg;
    Schema.init({ presence: { type: 'enum', values: ['present', 'absent'] }, severity: { type: 'enum', values: ['mild'] } });
    const attrs = { severity: 'small', multiple: 'true' };
    const notes = Schema.migrateLegacyAttributes(attrs);
    Schema.init(saved);
    assertEqual(notes.length, 0);
    assertEqual(attrs.severity, 'small');
    assertEqual(attrs.multiple, 'true');
  });
});
