/**
 * Taxonomy search and matching.
 * Ported from src/taxonomy.py.
 */

const MODIFIERS = new Set([
  'right', 'left', 'bilateral', 'mild', 'moderate', 'severe',
  'small', 'medium', 'large', 'acute', 'chronic', 'new', 'stable',
  'focal', 'diffuse', 'minimal', 'subtle', 'extensive',
]);

const Taxonomy = {
  /**
   * Filter findings by search query (case-insensitive substring on name + synonyms).
   */
  searchFindings(query, findings) {
    if (!query) return findings;
    const q = query.toLowerCase().replace(/[_ ]/g, ' ');
    return findings.filter(f =>
      f.name.toLowerCase().replace(/[_ ]/g, ' ').includes(q) ||
      f.synonyms.some(syn => syn.toLowerCase().replace(/[_ ]/g, ' ').includes(q))
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
   * Exact or synonym match, no fuzzy. BOTH sides go through normalizeName
   * so the separator style of the taxonomy ("airspace_opacity" vs
   * "airspace opacity") never decides whether a name is "exact" — folding
   * only the input used to push every multi-word identical name down to
   * the fuzzy tier, where it showed up as a confusing "100% fuzzy" match.
   */
  findByExactOrSynonym(findingName, findings) {
    const normalized = this.normalizeName(findingName);

    // Level 1: Direct canonical name match
    for (const f of findings) {
      if (this.normalizeName(f.name) === normalized) return f;
    }

    // Level 2: Synonym match
    for (const f of findings) {
      for (const syn of f.synonyms) {
        if (this.normalizeName(syn) === normalized) return f;
      }
    }

    return null;
  },

  /**
   * Match an extracted finding name to a taxonomy entry.
   * Level 1: Direct name match (separator-folded both sides)
   * Level 2: CSV synonym match
   * Level 3: Fuzzy token-overlap match (Jaccard, threshold 0.5)
   */
  matchFindingToTaxonomy(findingName, findings) {
    const exact = this.findByExactOrSynonym(findingName, findings);
    if (exact) return exact;

    // Level 3: Fuzzy match
    const result = this.fuzzyMatchFinding(findingName, findings, 0.5);
    return result ? result.finding : null;
  },

  /**
   * Token-overlap fuzzy match (Jaccard similarity).
   */
  fuzzyMatchFinding(findingName, findings, threshold = 0.5) {
    // Underscores are separators too — an underscore-styled taxonomy would
    // otherwise compare whole names as single tokens (always 0% or 100%).
    const inputTokens = new Set(
      findingName.toLowerCase().split(/[\s_]+/).filter(t => t && !MODIFIERS.has(t))
    );
    if (inputTokens.size === 0) return null;

    let bestMatch = null;
    let bestScore = 0;

    for (const f of findings) {
      const taxTokens = new Set(
        f.name.toLowerCase().split(/[\s_]+/).filter(t => t && !MODIFIERS.has(t))
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
  }
};

window.Taxonomy = Taxonomy;
