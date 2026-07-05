/**
 * Schema accessor. Wraps the fetched attributeConfig (data/attributes.json) and
 * owns every vocabulary question — presence values, hedgeable axes, multi-value
 * axes, and which keys are annotatable finding attributes.
 *
 * All presence/hedge UI surfaces derive from here, so the app adapts to
 * attributes.json without code changes: if the schema ever reverts to a
 * three-valued presence, presenceOptions() renders three plain options and
 * presenceHedgeable() goes false — no branch elsewhere needs touching.
 */
const Schema = {
  _cfg: null,

  init(cfg) { this._cfg = cfg || {}; },

  // ['present','absent'] from cfg.presence.values.
  presenceValues() {
    const p = this._cfg && this._cfg.presence;
    return (p && Array.isArray(p.values)) ? p.values : [];
  },

  // Is a given axis hedgeable? (axis ∈ cfg.confidence.allowed_axes)
  isHedgeable(axis) {
    const c = this._cfg && this._cfg.confidence;
    return !!(c && Array.isArray(c.allowed_axes) && c.allowed_axes.includes(axis));
  },

  // Presence-specific convenience.
  presenceHedgeable() { return this.isHedgeable('presence'); },

  // cfg[key].multi_value === true
  isMultiValue(key) {
    const a = this._cfg && this._cfg[key];
    return !!(a && a.multi_value === true);
  },

  // Cycle/dropdown values for an enum/boolean attribute. Enums cycle their
  // declared values; booleans (values: [] in attributes.json) cycle a synthetic
  // ['false','true']; free-text/array attrs don't cycle.
  enumValues(key) {
    const cfg = this._cfg && this._cfg[key];
    if (!cfg) return [];
    if (cfg.type === 'enum') return cfg.values || [];
    if (cfg.type === 'boolean') return ['false', 'true'];
    return [];
  },

  // Convert a legacy `presence: 'indeterminate'` to the polarity+hedge model,
  // cue-aware: a negation cue in the source text leans absent, otherwise present.
  // Always hedged, always review-flagged (polarity was inferred). Shared by the
  // v5 migration and the import-boundary alias so both lean the same way.
  convertIndeterminate(sourceText) {
    const NEG = /\b(no |without |not |unremarkable|negative for|unlikely)/i;
    const polarity = NEG.test(sourceText || '') ? 'absent' : 'present';
    return { presence: polarity, hedge: true, review: true };
  },

  // Legacy-schema tolerance. Prior published schema versions used different
  // attribute names and vocabularies; extraction files and stored annotations
  // produced under them keep arriving. Single source of truth for the
  // old→current mapping — consumed by the import parser, the import
  // validator's custom-column detection, the column-mapping guesser, and the
  // stored-report migration, so every entry point converts the same way.
  //   LEGACY_COLUMN_RENAMES: old column/attribute name → current canonical key
  //   severity small/medium/large: the old severity enum carried physical-size
  //   grades; those values live on the `extent` axis now.
  LEGACY_COLUMN_RENAMES: {
    multiple: 'aggregate',
    anatomical_location: 'anatomic_site',
  },

  // Current canonical key for a legacy column name (normalized), or null.
  legacyColumnTarget(name) {
    return this.LEGACY_COLUMN_RENAMES[name] || null;
  },

  // Migrate one finding's attributes in place from legacy names/vocabularies
  // to the current schema. Only migrates onto keys the ACTIVE config declares
  // (a bundle schema without `extent` keeps severity untouched), never
  // overwrites a value already present, and is idempotent — an already-
  // migrated finding passes through unchanged. Returns plain-language notes,
  // one per change (empty array when nothing changed).
  migrateLegacyAttributes(attrs) {
    const notes = [];
    if (!attrs) return notes;
    for (const [oldKey, newKey] of Object.entries(this.LEGACY_COLUMN_RENAMES)) {
      if (attrs[oldKey] == null || attrs[newKey] != null || !(this._cfg || {})[newKey]) continue;
      let val = attrs[oldKey];
      // A renamed boolean normalizes its value too ("True" → "true").
      if (this._cfg[newKey].type === 'boolean') {
        const low = String(val).trim().toLowerCase();
        if (low === 'true' || low === 'false') val = low;
      }
      attrs[newKey] = val;
      delete attrs[oldKey];
      notes.push(`'${oldKey}' is now called '${newKey}' — value moved over`);
    }
    const sev = attrs.severity;
    const extentValues = (((this._cfg || {}).extent || {}).values || []).map(v => String(v).toLowerCase());
    if (sev != null && !Array.isArray(sev) && attrs.extent == null
        && extentValues.includes(String(sev).toLowerCase())) {
      attrs.extent = String(sev).toLowerCase();
      delete attrs.severity;
      notes.push(`severity '${sev}' describes physical size, which now lives on 'extent' — value moved over`);
    }
    return notes;
  },

  // All top-level config keys — RAW, includes the metadata keys.
  attributeKeys() { return Object.keys(this._cfg || {}); },

  // Annotatable finding attributes only: excludes the two metadata keys —
  // 'presence' (its own dedicated control) and 'confidence' (the hedge-axis map).
  // Single source of truth for "which keys are annotatable attributes"; the
  // exclusion is a STRUCTURAL rule, not a growing per-key denylist.
  findingAttributeKeys() {
    return Object.keys(this._cfg || {}).filter(k => k !== 'presence' && k !== 'confidence');
  },

  // Spectrum options for the presence control. Each: {label, svg, presence,
  // hedged}. `svg` is the inner <path> markup of a Tabler "percentage" icon
  // (https://tabler.io/icons), inlined directly rather than referenced via
  // the `ti-percentage-*` webfont class: the icons-webfont build collapses
  // the filled-disc (100%) and empty-ring (0%) glyphs to the same outline
  // shape (confirmed against the actual font file, versions 3.36.1 and
  // 3.44.0 — an upstream limitation, not a version issue), so the two ends
  // of the spectrum render identically through the webfont. Inlining the
  // source SVG paths renders them with true fidelity. A rough visual
  // approximation of certainty — not a literal probability. Display
  // labels/icons are APP-OWNED defaults keyed by (polarity, hedged) so the
  // workbench-owned attributes.json is not coupled to UI copy. When presence
  // is not hedgeable, returns one plain option per value (the "handle both
  // models" requirement is structural, not a special case).
  presenceOptions() {
    const values = this.presenceValues();
    // Spectrum shape, most- to least-confident: a solid check (definitely
    // there) fades through dashed variants to a bare dotted ring (definitely
    // not there). Tabler webfont classes, not inlined paths — unlike the old
    // percentage-pie family, these four are visually distinct glyphs in the
    // vendored font (no known collision).
    const DISPLAY = {
      'present': { label: 'Present', icon: 'ti-circle-check' },
      'present+hedged': { label: 'Possible', icon: 'ti-circle-dashed-check' },
      'absent+hedged': { label: 'No definite', icon: 'ti-circle-dashed' },
      'absent': { label: 'Absent', icon: 'ti-circle-dotted' },
    };
    const opt = (presence, hedged) => {
      const key = hedged ? `${presence}+hedged` : presence;
      const d = DISPLAY[key] || { icon: '', label: presence };
      return { label: d.label, icon: d.icon, presence, hedged };
    };
    if (!this.presenceHedgeable()) {
      return values.map(v => opt(v, false));
    }
    // Polarity+hedge model, in spectrum order: present → possible →
    // no-definite → absent. Only emit options for declared polarities.
    const out = [];
    if (values.includes('present')) { out.push(opt('present', false), opt('present', true)); }
    if (values.includes('absent')) { out.push(opt('absent', true), opt('absent', false)); }
    return out;
  },
};

window.Schema = Schema;
