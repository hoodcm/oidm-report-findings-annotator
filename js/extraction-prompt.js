/**
 * Single source of truth for the LLM extraction prompt.
 * Used by pages/llm-extractions.html to render an auto-filled prompt
 * with the user's active taxonomy (and, when reports are already loaded,
 * a real ID-column name + sample record_ids) injected.
 *
 * Four tiers, emitted in this order (see the design plan for rationale):
 *   1. TASK DEFINITION  — role, scope, input contract
 *   2. METHODOLOGY      — the output contract + ~8-10 extraction rules
 *   3. GUARDRAILS + WORKED EXAMPLE — output format + the shared fixture
 *   4. VOCABULARY       — the full taxonomy, LAST (truncation-safe: if a
 *      long prompt gets cut off in the middle, the contract and worked
 *      example survive; only the vocabulary tail is at risk, and a
 *      dropped taxonomy entry degrades gracefully via unmapped:<term>)
 *
 * The prompt is an example, not a production extraction pipeline: it
 * teaches the app's import contract (so extractions actually import) and
 * common failure-mode avoidance, but cannot replace human review — every
 * imported finding is reviewed in the annotator before it counts.
 */
const ExtractionPrompt = {
  /**
   * Build the extraction prompt string.
   *
   * @param {Object}  opts
   * @param {Array}   opts.taxonomy         Active taxonomy findings (array of {name, category, synonyms, ...}).
   * @param {Object}  opts.attributeConfig  From data/attributes.json.
   * @param {string}  opts.examType         e.g. "CXR", "CT Head".
   * @param {Object}  [opts.corpus]         When reports are already loaded: { idColumn, sampleIds }.
   * @returns {string}
   */
  build({ taxonomy, attributeConfig, examType, corpus } = {}) {
    const examLabel = examType ? examType.toLowerCase() : '<exam type>';
    const cfg = attributeConfig || {};

    const presenceValues = (cfg.presence && cfg.presence.values) || [];
    const presenceLine = presenceValues.map(v => `"${v}"`).join(' | ');
    const confidenceAxes = (cfg.confidence && cfg.confidence.allowed_axes) || [];

    const optionalLines = Object.entries(cfg)
      .filter(([key]) => key !== 'presence' && key !== 'confidence')
      .map(([key, fieldCfg]) => {
        let line = `  ${key.padEnd(16)} `;
        if (fieldCfg.type === 'enum' && fieldCfg.values && fieldCfg.values.length) {
          line += fieldCfg.values.map(v => `"${v}"`).join(' | ');
        } else {
          line += fieldCfg.description || 'string';
        }
        return line;
      })
      .join('\n');

    const idColumn = corpus && corpus.idColumn ? corpus.idColumn : null;
    const sampleIds = (corpus && corpus.sampleIds && corpus.sampleIds.length) ? corpus.sampleIds : null;
    const idColumnPhrase = idColumn ? `its \`${idColumn}\` column` : 'its ID column';
    const sampleIdsPhrase = sampleIds ? ` (in your loaded reports, that column looks like: ${sampleIds.join(', ')})` : '';

    const taxonomyBlock = this._buildTaxonomyBlock(taxonomy);

    return `${this._tier1TaskDefinition(examLabel, idColumnPhrase, sampleIdsPhrase)}

${this._tier2Methodology(presenceLine, confidenceAxes, optionalLines)}

${this._tier3GuardrailsAndExample()}

${taxonomyBlock}

Output only the JSON array for the reports in this batch. No commentary, no markdown fencing, no extra text.`;
  },

  _tier1TaskDefinition(examLabel, idColumnPhrase, sampleIdsPhrase) {
    return `TASK.
You are extracting structured findings from a batch of ${examLabel} radiology reports for research annotation. Every finding you emit will be reviewed by a radiologist before it's used — a strong, honest attempt matters more than perfect accuracy.

SCOPE. Read only the FINDINGS section of each report (ignore IMPRESSION/CONCLUSION — those summarize, they aren't the source data). Extract every reportable observation described there, including devices, post-surgical changes, and comparisons to prior studies stated in that report. An explicitly negated finding still counts ("no pneumothorax" -> presence="absent"); skip only boilerplate that names nothing ("no acute findings").

INPUT. I will attach the reports CSV you're extracting from — the SAME file, in the SAME message, so record_id and source_text always correspond correctly. Copy record_id verbatim from ${idColumnPhrase}${sampleIdsPhrase} — never invent, renumber, or reuse a record_id. If you can't attach a file in this chat, I'll paste reports in labeled batches instead ("Report <record_id>:" before each report's text); the same rules apply either way.`;
  },

  _tier2Methodology(presenceLine, confidenceAxes, optionalLines) {
    return `OUTPUT CONTRACT.
Output a JSON array. Each element is one finding object.

REQUIRED fields on every finding object:
  record_id     string  copy verbatim from the input
  finding_name  string  see TAXONOMY below; if nothing fits, use unmapped:<short_snake_case_name>
  presence      one of: ${presenceLine}
  source_text   string  the verbatim sentence from the FINDINGS section that supports this finding

OPTIONAL canonical fields (include only when the report supports a value; use only the listed values):
${optionalLines}

You may include any additional fields beyond these. The annotator preserves them as free-text custom attributes.

CONFIDENCE (hedging).
  Include a "confidence" object only on axes the report explicitly hedges — one key per hedged axis, value always "hedged". Hedgeable axes: ${confidenceAxes.map(a => `"${a}"`).join(', ')}.
  - "possible X" / "probable X" / "suspected X" / "cannot exclude X" -> presence="present", confidence={"presence":"hedged"}
  - "no definite X" -> presence="absent", confidence={"presence":"hedged"}
  - Omit the confidence field entirely when the report is definite about every axis you set (the common case).

METHODOLOGY.

1. ONE SENTENCE PER FINDING. source_text is a verbatim substring of exactly ONE sentence in the report's FINDINGS section — never a paraphrase, and never text stitched together across sentences. When several sentences together describe one finding, cite the PRIMARY sentence (the one naming the finding itself), not the supporting detail sentences.

2. DON'T INFER WHAT THE TEXT DOESN'T STATE. Leave an optional field blank rather than guessing a value the sentence doesn't support — an empty field is correct more often than a plausible-sounding guess.

3. ENUM DISCIPLINE. For every field with a listed value set above, use only those exact values (case as shown). If the report's wording doesn't map cleanly onto any listed value, leave the field blank rather than inventing a close-sounding value.

4. AGGREGATE VS. DISCRETE ROWS. Emit one row per instance only when each instance has its own distinguishing detail (a site, a laterality, a size, or another individually-named attribute). A plural mention with no per-instance detail — a bare count ("two nodules") or words like "multiple/several/scattered" — is ONE row with aggregate="true" instead; when one member of that group IS individually characterized ("multiple nodules, largest in the RUL"), add a second, discrete row for that member sharing the same finding_name.

5. FREE TEXT LIVES IN FEATURES OR CUSTOM FIELDS ONLY. The enum fields above accept only their listed values — never free text.

6. LATERALITY STAYS IN THE LATERALITY FIELD. Don't repeat "left"/"right"/"bilateral" inside anatomic_site ("frontal lobe", not "right frontal lobe").

7. OUTPUT IN CHUNKS OF ABOUT 5 REPORTS. If the batch is larger than that, extract and output findings for ~5 reports at a time (still one JSON array per message) rather than trying to hold the whole batch in one response — this avoids truncation on long batches.`;
  },

  _tier3GuardrailsAndExample() {
    const ex = ExtractionExample;
    const findingsJson = JSON.stringify(ex.findings, null, 2);
    const notesBlock = ex.notes.map(n => `  - ${n}`).join('\n');
    return `GUARDRAILS + WORKED EXAMPLE.
Output ONLY the bare JSON array described above — no commentary, no markdown code fences, no text before or after it.

Here is one worked example: a short FINDINGS excerpt, the exact JSON it should produce, and notes on why (the finding names below are illustrative of the FORMAT — always prefer the real taxonomy in TAXONOMY below over these names).

Excerpt from a FINDINGS section:
"""
${ex.report.replace(/^FINDINGS:\s*/i, '')}
"""

Expected output for that excerpt:
${findingsJson}

Why:
${notesBlock}

The record_id "${ex.recordId}" above is a placeholder for this example only — never emit it on real data; always copy the real record_id from the attached reports CSV.`;
  },

  // Full taxonomy, grouped by category, synonyms rendered as "also called".
  // Placeholder when no taxonomy is loaded yet.
  _buildTaxonomyBlock(taxonomy) {
    if (!taxonomy || !taxonomy.length) {
      return `TAXONOMY (use these finding names when possible; the unmapped:<term> escape hatch above covers everything else):
{load_a_taxonomy_to_populate_this_list}`;
    }
    const byCategory = new Map();
    for (const f of taxonomy) {
      const cat = f.category || 'Other';
      if (!byCategory.has(cat)) byCategory.set(cat, []);
      byCategory.get(cat).push(f);
    }
    const lines = [];
    for (const [cat, findings] of byCategory) {
      lines.push(`${cat}:`);
      for (const f of findings) {
        const synonyms = (f.synonyms && f.synonyms.length) ? ` (also called: ${f.synonyms.join(', ')})` : '';
        lines.push(`- ${f.name}${synonyms}`);
      }
    }
    return `TAXONOMY (use these finding names when possible; the unmapped:<term> escape hatch above covers everything else):
${lines.join('\n')}`;
  },
};

window.ExtractionPrompt = ExtractionPrompt;
