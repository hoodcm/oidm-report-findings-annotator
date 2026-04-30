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
   * Match an extracted finding name to a taxonomy entry.
   * Level 1: Direct name match (normalize: lowercase, underscores→spaces)
   * Level 2: CSV synonym match
   * Level 3: Fuzzy token-overlap match (Jaccard, threshold 0.5)
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

    // Level 3: Fuzzy match
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
  }
};

window.Taxonomy = Taxonomy;
