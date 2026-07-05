/**
 * Sentence splitting and header detection.
 * Ported from src/extractor.py and src/config.py.
 */

const HEADER_RE = /^([A-Za-z][\w ,/\-&]+?:\s*)/;
const TEMPLATED_NONE_RE = /^[A-Za-z/\s]+:\s*none\.?\s*$/i;

// Terminating section headers that mark the end of the annotatable findings
// body — everything from here on (impression, conclusion, and the
// recommendations that trail them) is out of scope for grading. Single source
// of truth for the boundary term set. RECOMMENDATION is deliberately excluded:
// it reliably follows an already-cut IMPRESSION and can appear as an
// intra-findings sub-line; SUMMARY/ADDENDUM are excluded because they can
// legitimately carry findings.
// Capitalized stems of the terminating headers — single source of truth; both
// boundary regexes below are built from this one list, so the term set is
// defined once.
const OUT_OF_SCOPE_STEMS = ['Impression', 'Conclusion'];
// A term truncates the body when it is ALL-CAPS anywhere (case-sensitive, so
// only genuine uppercase headings match) …
const OUT_OF_SCOPE_ALLCAPS_RE = new RegExp(
  `\\b(?:${OUT_OF_SCOPE_STEMS.map(s => s.toUpperCase() + 'S?').join('|')})\\b`, 'g');
// … OR when it is a Capitalized heading at the start of a line, colon optional.
// The line-start form must be capitalized: a real section header is never
// written in all-lowercase, and requiring the capital avoids truncating a
// wrapped findings line that merely begins with the ordinary word
// "conclusion"/"impression" (e.g. "…the prior\nconclusion of hemorrhage"). An
// all-lowercase heading is not caught by either rule (accepted — vanishingly
// rare); an ALL-CAPS occurrence anywhere is caught by the rule above.
// Word-boundaried so "IMPRESSIONABLE" and "mild impression" mid-body survive.
const OUT_OF_SCOPE_LINESTART_RE = new RegExp(
  `^[ \\t]*(?:${OUT_OF_SCOPE_STEMS.map(s => s + 's?').join('|')})\\b`, 'gm');

const Sentences = {
  /**
   * Reconstruct the line structure of report text whose newlines were
   * mangled on the way into a CSV cell. Three progressively weaker cues,
   * all safe on already-well-formed text (idempotent):
   *   1. Tabs and runs of 3+ spaces are unambiguous flattened line breaks.
   *   2. A run of 2 spaces is a line break only when the text has no real
   *      newlines at all (a wholly flattened blob) — in a normal multi-line
   *      report a double space is more likely typographic spacing.
   *   3. A header-shaped token ("Pleura:", "Bones, Soft Tissues:") directly
   *      after a sentence end (".") or after a templated empty-section value
   *      ("none") starts its own line, wherever it sits. This recovers
   *      subheaders from single-space collapse and from reports that string
   *      several "Header: content." sections on one physical line — without
   *      it, the ambient header prefixes onto every following sentence and
   *      the real subheaders never render as subheaders.
   */
  _reconstructLines(text) {
    let t = text.replace(/\t+/g, '\n').replace(/ {3,}/g, '\n');
    if (!t.includes('\n')) t = t.replace(/ {2,}/g, '\n');
    return t.replace(/(\.|\bnone\b)[ \t]+(?=[A-Za-z][\w ,/&-]{0,58}:)/g, '$1\n');
  },

  /**
   * Truncate a findings body at the first out-of-scope section boundary
   * (impression / conclusion). Returns the trimmed head; a body that is
   * entirely out of scope (e.g. an impression-only report) returns ''.
   */
  _stripOutOfScope(body) {
    let cut = body.length;
    for (const re of [OUT_OF_SCOPE_ALLCAPS_RE, OUT_OF_SCOPE_LINESTART_RE]) {
      re.lastIndex = 0;
      const m = re.exec(body);
      if (m) cut = Math.min(cut, m.index);
    }
    return body.slice(0, cut).trim();
  },

  /**
   * Extract the FINDINGS section from a report: isolate the findings body
   * (after a FINDINGS header, else the whole text) then strip any trailing
   * out-of-scope section on every branch.
   */
  parseFindingsSection(reportText) {
    // Reconstruct mangled line breaks BEFORE locating section boundaries, so
    // the line-start impression/conclusion truncation sees real line starts
    // even in a report flattened into one CSV cell.
    reportText = this._reconstructLines(reportText || '');
    let body;
    const match = reportText.match(/FINDINGS:?\s+([\s\S]*)/i);
    if (match) {
      body = match[1];
    } else {
      const idx = reportText.toUpperCase().indexOf('FINDINGS');
      if (idx !== -1) {
        body = reportText.slice(idx + 8).trim();
        if (body.startsWith(':')) body = body.slice(1).trim();
      } else {
        body = reportText;
      }
    }
    return this._stripOutOfScope(body);
  },

  /**
   * Split text into sentences for annotation.
   */
  splitIntoSentences(text) {
    // Reports CSVs often arrive with the original line breaks flattened to
    // runs of spaces or a tab, or with several "Header: content." sections
    // strung onto one physical line. Reconstruct the line structure first
    // (see _reconstructLines) — a missed break glues a section header
    // ("Devices/Tubes/Lines:") onto every sentence that follows it and the
    // real subheaders never render. Idempotent when the caller already
    // reconstructed (parseFindingsSection does).
    const lines = this._reconstructLines(text).split(/\n/);
    const sentences = [];
    const sectionBreaks = [];
    let pendingContent = '';
    let currentHeader = '';

    const flush = (headerPrefix) => {
      if (!pendingContent) return;
      const subSentences = pendingContent.split(/(?<=\.)\s+(?=(?:[-*]\s+|\d+\.\s+)?[A-Z])/);
      for (const sub of subSentences) {
        const st = sub.trim();
        if (st) {
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

        if (!afterColon) {
          // Bare header (label alone on its line). Classify by source case:
          // an ALL-CAPS label is a large section divider ("HEAD:",
          // "CERVICAL SPINE:" in a multi-region report); a mixed-case label
          // is a subheader whose content arrives on following lines
          // ("Right:" / "Left:" in temporal-bone reports). Subsequent
          // sentences carry this prefix either way.
          const sub = /[a-z]/.test(headerLabel);
          flush(currentHeader);
          sectionBreaks.push({ before: sentences.length, header: headerLabel + ':', sub });
          currentHeader = headerLabel + ':';
        } else {
          // Content header — prefix onto its sentence and remain in scope for
          // continuation lines. A templated null ("Devices/Tubes/Lines: none")
          // is deliberately an ordinary sentence: it gets the same treatment
          // as "Unremarkable." / "Normal.", keeps sentence numbering aligned
          // with the raw report, and stays quotable by an extractor.
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
   * Stable identity key for finding-level merge across re-imports.
   * Combines normalized source_text with case-folded finding_name so that
   * re-imports with the same extractor span and canonical finding can be
   * merged onto the existing validated finding regardless of whitespace
   * or case drift in either field.
   */
  mergeKey(sourceText, findingName) {
    const s = this._normForMatch(sourceText);
    const n = (findingName || '').toString().toLowerCase().trim();
    return `${s}::${n}`;
  },

  /**
   * Scan other loaded reports for any whose text contains the normalized
   * source_text. Used by matchSourceToSentence on both the success and
   * not-in-report paths so the validator can flag cross-report ambiguity
   * (record_id-mix-up signal) regardless of whether the named report
   * matched.
   */
  _otherReportsContaining(norm, recordId, allReports) {
    if (!Array.isArray(allReports)) return [];
    const hits = [];
    for (const r of allReports) {
      if (!r || r.record_id === recordId) continue;
      for (const sent of (r.sentences || [])) {
        if (this._normForMatch(sent).includes(norm)) {
          hits.push(r.record_id);
          break;
        }
      }
    }
    return hits;
  },

  // Token set for Dice-coefficient scoring: lowercase word tokens, deduped.
  _tokenSet(s) {
    return new Set((s || '').toLowerCase().match(/[a-z0-9]+/g) || []);
  },

  // Token-Dice similarity: 2*|A∩B| / (|A|+|B|), 0 when either set is empty.
  _tokenDice(a, b) {
    const setA = this._tokenSet(a);
    const setB = this._tokenSet(b);
    if (setA.size === 0 || setB.size === 0) return 0;
    let overlap = 0;
    for (const t of setA) if (setB.has(t)) overlap++;
    return (2 * overlap) / (setA.size + setB.size);
  },

  // Minimum absolute similarity and minimum top-1-vs-top-2 margin for a
  // closest-sentence suggestion to fire. The margin guards a templated
  // report's near-identical sibling sentences (e.g. "Left kidney: normal."
  // / "Right kidney: normal.") from producing a confident-looking but
  // wrong suggestion.
  SUGGESTION_FLOOR: 0.6,
  SUGGESTION_MARGIN: 0.15,

  // Best-fuzzy candidate sentence for a source_text that matched nothing
  // exactly. Two passes:
  //   1. Adjacent-pair span: source_text may be a verbatim quote spanning
  //      two consecutive sentences (the extractor's sentence split doesn't
  //      always land where the LLM's quote boundary does). If the
  //      concatenation of sentences[i] + sentences[i+1] contains the quote
  //      verbatim, suggest sentence i+1 (1-indexed) — the one containing
  //      the HEAD (start) of the quote.
  //   2. Token-Dice fuzzy score across all sentences, gated on an absolute
  //      floor AND a top-1-vs-top-2 margin.
  // Returns { idx, score } (1-indexed) or null when nothing clears the bar.
  _suggestClosestSentence(norm, sentences) {
    const list = sentences || [];
    for (let i = 0; i < list.length - 1; i++) {
      const concat = this._normForMatch(`${list[i]} ${list[i + 1]}`);
      if (concat.includes(norm)) return { idx: i + 1, score: 1 };
    }

    let best = { idx: -1, score: -1 };
    let secondScore = -1;
    for (let i = 0; i < list.length; i++) {
      const score = this._tokenDice(norm, list[i]);
      if (score > best.score) {
        secondScore = best.score;
        best = { idx: i + 1, score };
      } else if (score > secondScore) {
        secondScore = score;
      }
    }
    if (best.idx === -1) return null;
    const margin = secondScore < 0 ? best.score : best.score - secondScore;
    if (best.score >= this.SUGGESTION_FLOOR && margin >= this.SUGGESTION_MARGIN) {
      return { idx: best.idx, score: best.score };
    }
    return null;
  },

  // 1-based indices of sentences whose normalized text contains `norm`.
  _sentencesContaining(norm, sentences) {
    const hits = [];
    for (let i = 0; i < (sentences || []).length; i++) {
      if (this._normForMatch(sentences[i]).includes(norm)) hits.push(i + 1);
    }
    return hits;
  },

  // Split a quoted source_text into sentence-ish pieces. An LLM often
  // stitches two report sentences into one quote — typically the FINDINGS
  // line plus its IMPRESSION echo — even when told to quote one sentence.
  _quotePieces(sourceText) {
    return (sourceText || '').split(/(?<=\.)\s+/).map(p => p.trim()).filter(Boolean);
  },

  /**
   * Match source_text to a sentence in the named report.
   *
   * `reportText` (optional) is the report's FULL raw text. It powers two
   * checks the sentence list alone can't make: recognizing a quote taken
   * verbatim from an out-of-scope section (Impression/Conclusion text is
   * stripped from the annotatable sentences), and validating the pieces of
   * a multi-sentence quote whose tail lives out of scope.
   *
   * Returns one of:
   *   { idx: number, alsoMatchesIn: string[] }                — exactly one sentence matches; alsoMatchesIn lists other reports whose text also contains source_text (warning signal for record_id mix-up)
   *   { idx, alsoMatchesIn, spannedPieces: number }            — the quote stitched several report sentences together; every piece is verbatim in the report, anchored to the first piece matching exactly one sentence
   *   { error: 'ambiguous', matches: number[], alsoMatchesIn: string[] } — two or more sentences match in the named report
   *   { error: 'out_of_scope', alsoMatchesIn, suggestion }     — verbatim in reportText but not in any annotatable sentence (an Impression/Conclusion quote)
   *   { error: 'not_in_report', alsoMatchesIn, boilerplate, suggestion } — no verbatim match in the named report; boilerplate=true when the text appears in 3+ other reports (templated wording — a near-variant in the named report is likelier than a record_id mix-up); suggestion is the best-fuzzy candidate sentence — callers suppress it on a suspected mix-up (non-boilerplate cross-attribution) so a wrong record_id can't be papered over
   * If sourceText is empty, returns { error: 'not_in_report', alsoMatchesIn: [], suggestion: null }.
   */
  matchSourceToSentence(sourceText, sentences, recordId, allReports, reportText) {
    const norm = this._normForMatch(sourceText);
    if (!norm) return { error: 'not_in_report', alsoMatchesIn: [], suggestion: null };

    const matches = this._sentencesContaining(norm, sentences);
    const alsoMatchesIn = this._otherReportsContaining(norm, recordId, allReports);
    if (matches.length === 1) return { idx: matches[0], alsoMatchesIn };
    if (matches.length >= 2) return { error: 'ambiguous', matches, alsoMatchesIn };

    const normRaw = reportText ? this._normForMatch(reportText) : null;

    // Multi-sentence quote: every piece must be verbatim in the report (in a
    // sentence, or — when raw text is available — in an out-of-scope
    // section), and at least one piece must pin down exactly one sentence.
    // Pieces under 10 normalized chars (abbreviation shrapnel like "Dr.")
    // disable the pass rather than risk anchoring on a fragment.
    const pieces = this._quotePieces(sourceText);
    if (pieces.length >= 2 && pieces.every(p => this._normForMatch(p).length >= 10)) {
      let anchor = null;
      let allVerbatim = true;
      for (const piece of pieces) {
        const np = this._normForMatch(piece);
        const hits = this._sentencesContaining(np, sentences);
        if (!anchor && hits.length === 1) anchor = hits[0];
        if (hits.length === 0 && !(normRaw && normRaw.includes(np))) { allVerbatim = false; break; }
      }
      if (allVerbatim && anchor) return { idx: anchor, alsoMatchesIn, spannedPieces: pieces.length };
    }

    const suggestion = this._suggestClosestSentence(norm, sentences);

    // Verbatim in the report's raw text but not in any annotatable sentence:
    // the quote comes from an out-of-scope section (Impression/Conclusion).
    if (normRaw && normRaw.includes(norm)) {
      return { error: 'out_of_scope', alsoMatchesIn, suggestion };
    }

    return { error: 'not_in_report', alsoMatchesIn, boilerplate: alsoMatchesIn.length >= 3, suggestion };
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
   * True when a section break is a SUBheader (bold rendering) rather than a
   * large section divider (gray all-caps rendering). Breaks parsed before
   * the `sub` flag existed (already-stored sessions) are classified by the
   * same case cue the parser uses: a label with any lowercase letter is a
   * subheader, an ALL-CAPS label is a section divider.
   */
  isSubBreak(brk) {
    if (!brk) return false;
    return brk.sub !== undefined ? !!brk.sub : /[a-z]/.test(brk.header || '');
  },

  /**
   * Section breaks to render before sentence index `idx` (pass
   * sentences.length for breaks that trail the last sentence). Drops a
   * subheader break whose header the very next sentence already carries as
   * its prefix — the run renderer shows that header inline, so keeping the
   * break would print it twice (e.g. a bare "Right:" line whose content
   * arrives on following lines).
   */
  breaksBefore(report, idx) {
    const breaks = (report && report.sectionBreaks) || [];
    const sentences = (report && report.sentences) || [];
    return breaks.filter(b => b.before === idx &&
      !(this.isSubBreak(b) && (sentences[idx] || '').startsWith(b.header)));
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
