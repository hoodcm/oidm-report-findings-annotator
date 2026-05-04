/**
 * Sentence splitting and header detection.
 * Ported from src/extractor.py and src/config.py.
 */

const HEADER_RE = /^([A-Za-z][\w ,/\-&]+?:\s*)/;
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
    const lines = text.split(/\n/);
    const sentences = [];
    const sectionBreaks = [];
    let pendingContent = '';
    let currentHeader = '';

    const flush = (headerPrefix) => {
      if (!pendingContent) return;
      const subSentences = pendingContent.split(/(?<=\.)\s+(?=(?:-\s+|\d+\.\s+)?[A-Z])/);
      for (const sub of subSentences) {
        const st = sub.trim();
        if (st && st.toLowerCase() !== 'none') {
          const full = headerPrefix ? `${headerPrefix} ${st}` : st;
          sentences.push(full);
        }
      }
      pendingContent = '';
    };

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) { flush(currentHeader); continue; }

      // Header: short text ending with colon at start of line
      const headerMatch = line.match(/^([A-Za-z][\w ,/\-&]+?):\s*(.*)/);

      if (headerMatch && headerMatch[1].trim().length < 60) {
        const headerLabel = headerMatch[1].trim();
        const afterColon = (headerMatch[2] || '').trim();

        if (!afterColon || /^none\.?\s*$/i.test(afterColon)) {
          // Bare header or "Header: none" — section divider; subsequent sentences carry this prefix
          flush(currentHeader);
          sectionBreaks.push({ before: sentences.length, header: headerLabel + ':' });
          currentHeader = headerLabel + ':';
        } else {
          // Content header — prefix onto its sentence and remain in scope for continuation lines
          flush(currentHeader);
          pendingContent = afterColon;
          flush(headerLabel + ':');
          currentHeader = headerLabel + ':';
        }
      } else {
        // Continuation line
        pendingContent += (pendingContent ? ' ' : '') + line;
      }
    }

    flush(currentHeader);
    return { sentences, sectionBreaks };
  },

  /**
   * Check if a sentence is a templated "Header: none" placeholder.
   */
  isTemplatedNone(sentence) {
    return TEMPLATED_NONE_RE.test(sentence);
  },

  /**
   * Normalize text for matching: lowercase, collapse whitespace, trim, strip optional trailing period.
   */
  _normForMatch(s) {
    return (s || '').toString().toLowerCase().replace(/\s+/g, ' ').trim().replace(/\.$/, '');
  },

  /**
   * Match source_text to a sentence in the named report.
   * Returns one of:
   *   { idx: number }                                        — exactly one sentence matches
   *   { error: 'not_in_report', alsoMatchesIn: string[] }    — zero matches; alsoMatchesIn lists other report ids whose text contains source_text
   *   { error: 'ambiguous', matches: number[] }              — two or more sentences match
   * If sourceText is empty, returns { error: 'not_in_report', alsoMatchesIn: [] }.
   */
  matchSourceToSentence(sourceText, sentences, recordId, allReports) {
    const norm = this._normForMatch(sourceText);
    if (!norm) return { error: 'not_in_report', alsoMatchesIn: [] };

    const matches = [];
    for (let i = 0; i < (sentences || []).length; i++) {
      const ns = this._normForMatch(sentences[i]);
      if (ns.includes(norm)) matches.push(i + 1);
    }
    if (matches.length === 1) return { idx: matches[0] };
    if (matches.length >= 2) return { error: 'ambiguous', matches };

    // 0 matches — check other reports if provided
    const alsoMatchesIn = [];
    if (Array.isArray(allReports)) {
      for (const r of allReports) {
        if (!r || r.record_id === recordId) continue;
        for (const sent of (r.sentences || [])) {
          if (this._normForMatch(sent).includes(norm)) {
            alsoMatchesIn.push(r.record_id);
            break;
          }
        }
      }
    }
    return { error: 'not_in_report', alsoMatchesIn };
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
  },

  /**
   * True if sentences[idx] is the first in a run of consecutive sentences
   * sharing the same header prefix. Used by the renderer to display the
   * sub-section header inline once per run.
   */
  isFirstOfHeaderRun(sentences, idx) {
    if (!sentences || idx < 0 || idx >= sentences.length) return false;
    const cur = this.splitSentenceHeader(sentences[idx])[0];
    if (!cur) return false;
    if (idx === 0) return true;
    const prev = this.splitSentenceHeader(sentences[idx - 1])[0];
    return prev !== cur;
  }
};

window.Sentences = Sentences;
