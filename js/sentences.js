/**
 * Sentence splitting and header detection.
 * Ported from src/extractor.py and src/config.py.
 */

const HEADER_RE = /^([A-Z][A-Za-z]+(?:[/\s]+[A-Z][A-Za-z]+)*:\s*)/;
const SUBSECTION_RE = /([A-Z][A-Za-z]+(?:[/\s]+[A-Z][A-Za-z]+)*:)/;
const TEMPLATED_NONE_RE = /^[A-Za-z/\s]+:\s*none\.?\s*$/i;

const Sentences = {
  /**
   * Extract the FINDINGS section from a report.
   */
  parseFindingsSection(reportText) {
    const match = reportText.match(/FINDINGS:?\s+([\s\S]*?)(?=IMPRESSION|$)/i);
    if (match) return match[1].trim();
    const upper = reportText.toUpperCase();
    const idx = upper.indexOf('FINDINGS');
    if (idx !== -1) {
      let rest = reportText.slice(idx + 8).trim();
      if (rest.startsWith(':')) rest = rest.slice(1).trim();
      return rest;
    }
    return reportText;
  },

  /**
   * Split text into sentences for annotation.
   */
  splitIntoSentences(text) {
    const parts = text.split(SUBSECTION_RE);
    const sentences = [];
    let currentHeader = '';

    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;

      if (new RegExp(SUBSECTION_RE.source + '$').test(trimmed)) {
        currentHeader = trimmed;
      } else {
        const content = currentHeader ? `${currentHeader} ${trimmed}`.trim() : trimmed;
        // Split on ". " followed by capital letter
        const subSentences = content.split(/(?<=\.)\s+(?=[A-Z])/);
        for (const s of subSentences) {
          const st = s.trim();
          if (st && st.toLowerCase() !== 'none') {
            sentences.push(st);
          }
        }
        currentHeader = '';
      }
    }
    return sentences;
  },

  /**
   * Check if a sentence is a templated "Header: none" placeholder.
   */
  isTemplatedNone(sentence) {
    return TEMPLATED_NONE_RE.test(sentence);
  },

  /**
   * Match source_text to a report sentence.
   * Returns 1-based index or null.
   * Ported from src/routes/extraction_upload.py::_match_source_sentence().
   */
  matchSourceToSentence(sourceText, sentences) {
    if (!sourceText || !sourceText.trim()) return null;

    const normalizedSource = sourceText.toLowerCase().trim();
    let bestIdx = null;
    let bestOverlap = 0;

    for (let i = 0; i < sentences.length; i++) {
      const normalizedSentence = sentences[i].toLowerCase().trim();
      let overlap = 0;

      if (normalizedSentence.includes(normalizedSource)) {
        overlap = normalizedSource.length;
      } else if (normalizedSource.includes(normalizedSentence)) {
        overlap = normalizedSentence.length;
      } else {
        continue;
      }

      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestIdx = i + 1; // 1-based
      }
    }

    return bestIdx;
  },

  /**
   * Split "Header: content" into [header, content].
   * Returns ["", sentence] if no header.
   */
  splitSentenceHeader(sentence) {
    const m = sentence.match(HEADER_RE);
    if (m) {
      const prefix = m[1].trimEnd();
      const content = sentence.slice(m[0].length).trim();
      return [prefix, content];
    }
    return ['', sentence];
  }
};

window.Sentences = Sentences;
