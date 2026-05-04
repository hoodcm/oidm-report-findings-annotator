/**
 * Single source of truth for the LLM extraction prompt.
 * Used by pages/llm-extractions.html to render an auto-filled prompt
 * with the user's active taxonomy injected.
 */
const ExtractionPrompt = {
  /**
   * Build the extraction prompt string.
   *
   * @param {Object}  opts
   * @param {Array}   opts.taxonomy         Active taxonomy findings (array of {name, ...}).
   * @param {Object}  opts.attributeConfig  From data/attributes.json.
   * @param {string}  opts.examType         e.g. "CXR", "CT Head".
   * @returns {string}
   */
  build({ taxonomy, attributeConfig, examType } = {}) {
    const examLabel = examType ? examType.toLowerCase() : '<exam type>';

    const taxonomyBlock = (taxonomy && taxonomy.length)
      ? taxonomy.map(f => `- ${f.name}`).join('\n')
      : '{load_a_taxonomy_to_populate_this_list}';

    const optionalLines = Object.entries(attributeConfig || {})
      .filter(([key]) => key !== 'presence')
      .map(([key, cfg]) => {
        let line = `  ${key.padEnd(16)} `;
        if (cfg.type === 'enum' && cfg.values && cfg.values.length) {
          line += cfg.values.map(v => `"${v}"`).join(' | ');
        } else {
          line += cfg.description || 'string';
        }
        return line;
      })
      .join('\n');

    return `Extract findings from the FINDINGS section of each ${examLabel} radiology report I provide.

Output a JSON array. Each element is one finding object.

REQUIRED fields on every finding object:
  record_id     string — copy verbatim from the input
  finding_name  string — see TAXONOMY below; if no match, use a concise snake_case clinical name
  presence      one of: "present" | "absent" | "indeterminate"
  source_text   string — the verbatim sentence from the FINDINGS section that supports this finding

OPTIONAL canonical fields. Include only when the report supports a value. Use only the listed values:
${optionalLines}

You may include any additional fields beyond these. The annotator preserves them as free-text custom attributes.

How granular to be (one finding per sentence vs grouped, what counts as a finding) is your choice — extract however your project needs.

TAXONOMY (use these finding names when possible):
${taxonomyBlock}

Output only the JSON array — no commentary, no markdown fencing, no extra text.`;
  }
};

window.ExtractionPrompt = ExtractionPrompt;
