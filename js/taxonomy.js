/**
 * Taxonomy search and matching.
 * Ported from src/taxonomy.py.
 */

const MODIFIERS = new Set([
  'right', 'left', 'bilateral', 'mild', 'moderate', 'severe',
  'small', 'medium', 'large', 'acute', 'chronic', 'new', 'stable',
  'focal', 'diffuse', 'minimal', 'subtle', 'extensive',
]);

// Normality mappings loaded at runtime from data/normality-mappings.json
let _normalityMappings = null;

const Taxonomy = {
  /**
   * Set normality mappings (called from app.js after fetching JSON).
   */
  setNormalityMappings(mappings) {
    _normalityMappings = mappings;
  },
  /**
   * Filter findings by search query (case-insensitive substring on name + synonyms).
   */
  searchFindings(query, findings) {
    if (!query) return findings;
    const q = query.toLowerCase();
    return findings.filter(f =>
      f.name.toLowerCase().includes(q) ||
      f.synonyms.some(syn => syn.toLowerCase().includes(q))
    );
  },

  /**
   * Find a finding by exact name or synonym match (case-insensitive).
   */
  findByName(name, findings) {
    const lower = name.toLowerCase();
    for (const f of findings) {
      if (f.name.toLowerCase() === lower) return f;
      for (const syn of f.synonyms) {
        if (syn.toLowerCase() === lower) return f;
      }
    }
    return null;
  },

  /**
   * Normalize a finding name for matching.
   */
  normalizeName(name) {
    return name.toLowerCase().trim().replace(/ /g, '_');
  },

  /**
   * Match an extracted finding name to a taxonomy entry.
   * Level 1: Direct name match (normalize: lowercase, underscores→spaces)
   * Level 2: CSV synonym match
   * Level 3: Normality mapping match
   * Level 4: Fuzzy token-overlap match (Jaccard, threshold 0.5)
   *
   * For decomposition cases (cardiomediastinal), returns the first match.
   */
  matchFindingToTaxonomy(findingName, findings) {
    const normalized = this.normalizeName(findingName);
    const withSpaces = normalized.replace(/_/g, ' ');

    // Level 1: Direct canonical name match
    for (const f of findings) {
      if (f.name.toLowerCase() === withSpaces) return f;
    }

    // Level 2: Synonym match
    for (const f of findings) {
      for (const syn of f.synonyms) {
        if (syn.toLowerCase() === withSpaces) return f;
      }
    }

    // Level 3: Normality mapping match
    if (_normalityMappings && normalized in _normalityMappings) {
      const mapped = _normalityMappings[normalized];
      // mapped is either a string or an array (decomposition)
      const targetName = Array.isArray(mapped) ? mapped[0] : mapped;
      const targetNorm = targetName.toLowerCase();
      for (const f of findings) {
        if (f.name.toLowerCase() === targetNorm) return f;
      }
    }

    // Level 4: Fuzzy match
    const result = this.fuzzyMatchFinding(findingName, findings, 0.5);
    return result ? result.finding : null;
  },

  /**
   * Token-overlap fuzzy match (Jaccard similarity).
   */
  fuzzyMatchFinding(findingName, findings, threshold = 0.5) {
    const inputTokens = new Set(
      findingName.toLowerCase().split(/\s+/).filter(t => !MODIFIERS.has(t))
    );
    if (inputTokens.size === 0) return null;

    let bestMatch = null;
    let bestScore = 0;

    for (const f of findings) {
      const taxTokens = new Set(
        f.name.toLowerCase().split(/\s+/).filter(t => !MODIFIERS.has(t))
      );
      if (taxTokens.size === 0) continue;

      let intersection = 0;
      for (const t of inputTokens) {
        if (taxTokens.has(t)) intersection++;
      }
      const union = new Set([...inputTokens, ...taxTokens]).size;
      const score = intersection / union;

      if (score > bestScore) {
        bestScore = score;
        bestMatch = f;
      }
    }

    if (bestMatch && bestScore >= threshold) {
      return { finding: bestMatch, score: bestScore };
    }
    return null;
  },

  /**
   * Try normality mapping only (no fuzzy). Returns first matched finding or null.
   */
  matchNormality(normalized, findings) {
    if (!_normalityMappings || !(normalized in _normalityMappings)) return null;
    const mapped = _normalityMappings[normalized];
    const targetName = (Array.isArray(mapped) ? mapped[0] : mapped).toLowerCase();
    for (const f of findings) {
      if (f.name.toLowerCase() === targetName) return f;
    }
    return null;
  }
};

window.Taxonomy = Taxonomy;
