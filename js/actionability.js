/**
 * Actionability tier resolution.
 * Ported from src/actionability.py.
 */

const Actionability = {
  /**
   * Build lookup from taxonomy array: FID → base tier.
   */
  buildLookup(taxonomy) {
    const lookup = {};
    for (const f of taxonomy) {
      if (f.actionability) {
        lookup[f.id] = f.actionability;
      }
    }
    return lookup;
  },

  /**
   * Resolve a finding's actionability tier at runtime.
   * Returns: "critical", "significant", "incidental", "not_actionable",
   *          "conditional", or null.
   */
  resolve(taxonomyId, attributes, lookup, rules) {
    if (!taxonomyId || !(taxonomyId in lookup)) return null;

    const presence = (attributes || {}).presence || '';
    if (presence === 'absent') return 'not_actionable';

    const baseTier = lookup[taxonomyId];
    if (['critical', 'significant', 'incidental'].includes(baseTier)) {
      return baseTier;
    }

    // From here, baseTier === "conditional"
    if ((attributes || {}).temporal_status === 'unchanged') {
      return 'incidental';
    }

    // Evaluate per-finding rules (top-to-bottom, first match wins)
    const findingRules = rules[taxonomyId] || [];
    for (const rule of findingRules) {
      if ('default' in rule) return rule.default;
      const when = rule.when || {};
      if (this._matchConditions(when, attributes || {})) {
        return rule.tier || 'conditional';
      }
    }

    return 'conditional';
  },

  /**
   * Check if all conditions in a 'when' clause match (AND logic).
   */
  _matchConditions(when, attributes) {
    for (const [attrName, allowedValues] of Object.entries(when)) {
      const actual = attributes[attrName];
      if (actual === undefined || actual === null) return false;
      if (Array.isArray(allowedValues)) {
        if (!allowedValues.includes(actual)) return false;
      } else {
        if (actual !== allowedValues) return false;
      }
    }
    return true;
  }
};

window.Actionability = Actionability;
