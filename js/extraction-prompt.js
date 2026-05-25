/**
 * Single source of truth for the LLM extraction prompt.
 * Used by pages/llm-extractions.html to render an auto-filled prompt
 * with the user's active taxonomy injected.
 *
 * The prompt is an example, not a production extraction pipeline. The
 * editorial rules below mitigate the most common LLM failure modes
 * observed during real-world annotation review (see 's
 * IMPROVEMENTS.md, Section A) but cannot fully replace post-extraction
 * validation. Items A1, A2, and A22 in particular need programmatic
 * checks the prompt can only ask for.
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
  record_id     string  copy verbatim from the input
  finding_name  string  see TAXONOMY below; if no match, use a concise snake_case clinical name
  presence      one of: "present" | "absent" | "indeterminate"
  source_text   string  the verbatim sentence from the FINDINGS section that supports this finding

OPTIONAL canonical fields (include only when the report supports a value; use only the listed values):
${optionalLines}

You may include any additional fields beyond these. The annotator preserves them as free-text custom attributes.

EXTRACTION RULES.

1. DO NOT INFER WHAT THE TEXT DOES NOT STATE.
   - "Interval" means "since the prior comparison study" and maps to temporal_status="new". It is NOT a chronicity value.
   - Leave chronicity BLANK when the source sentence has no explicit temporal qualifier ("acute", "subacute", "chronic", "remote", "evolving", "interval", "new", "stable", date references). Phrases like "status post", "prior", "history of", "after", "following" establish ordering only; they do NOT pin chronicity. Do not infer "remote" from the mere presence of a device or procedure.
   - For technique-agnostic or cause-agnostic descriptive language ("evacuation", "streak artifact"), map to the broader parent concept. Do not pick a specific cause/technique (craniotomy, metallic_artifact) unless the report names it explicitly or describes a cue that uniquely identifies it.
   - When a FINDINGS sentence describes imaging features without naming a diagnosis (e.g. "confluent hypoattenuation with surrounding edema and mass effect"), emit observation-level concepts (hypoattenuation, edema, mass effect). Do NOT emit diagnostic concepts (infarct, neoplasm, abscess) unless the radiologist explicitly commits to that diagnosis in that sentence.
   - Diagnostic uncertainty is NOT presence uncertainty. "A density that may reflect cerumen versus debris" means the density IS present and the differential is about etiology. Set presence="present" and push the differential into features. Reserve presence="indeterminate" for "I cannot tell if this finding is there at all."
   - Do NOT emit a positive finding from neutral temporal-comparison phrases ("no change", "stable", "similar", "unchanged X caliber") unless the same sentence or the immediately prior sentence explicitly names the underlying finding.
   - Congenital and developmental-variant findings have no slot in the current chronicity vocabulary. Leave chronicity BLANK rather than shoehorning into "chronic".

2. ONE REPORT AT A TIME, VERBATIM SOURCE_TEXT.
   - Do not batch multiple reports into a single call. Process them one at a time so record_id and source_text always correspond.
   - source_text MUST be a verbatim substring of the FINDINGS section of the report named by record_id. No paraphrasing, no canonicalizing wording across reports, no letting findings from one report inherit another report's record_id.
   - For every FINDINGS sentence that contains finding vocabulary (contusion, hematoma, hemorrhage, fracture, infarct, edema, lesion, mass, hypoattenuation, hyperdensity, named anatomical findings), emit at least one finding row. When a sentence describes both a primary lesion AND its secondary effects (surrounding edema, mass effect, sulcal effacement), the PRIMARY LESION is the must-have row. Do not emit only the secondary effects and negations.

3. SLASH AND "AND" ARE CO-OCCURRENCE DELIMITERS, NOT SYNONYM MARKERS.
   - "craniotomy / burr hole" describes two procedures, not one synonym list. Emit each as a separate finding.
   - When a slash separates two anatomic compartments ("gyriform / sulcal hyperdensity"), each compartment is a separate finding (gyriform = cortical; sulcal = subarachnoid). Do NOT bury one compartment in the features of the other.
   - "X and Y extending into Z and W" or "X and Y involving Z" gives BOTH findings the full anatomic extent. Do not split locations between them.
   - "effacement of X with displacement of Y" emits one finding per (action, structure) pair: ventricular_effacement at X, mass_effect or displacement at Y. Do not collapse different verbs about different structures onto one row.

4. ONE PHYSICAL STRUCTURE = ONE ROW.
   - Mixed-age blood products in a single collection ("subdural hematoma with acute and subacute blood products") emit ONE row. Encode the mixed-age either in features ("acute and subacute components") or use chronicity="evolving". Do not split the same hematoma into two rows.
   - When sequential sentences inside a single bullet describe the same finding ("Large multifocal frontal hemorrhage. The largest focus measures 7.2 x 2.8 x 6.7 cm. Additional smaller foci measure up to 2.7 cm."), merge into ONE row. The follow-on sentences are details of the parent, not separate findings.
   - When one measurement applies to multiple co-located findings ("scalp hematoma and soft tissue swelling measuring up to 1.3 cm"), attribute the measurement to the single most-specific finding (typically the named hematoma/collection) and leave size blank on the co-occurring generic finding.

5. ATTRIBUTE RECALL. CAPTURE WHAT THE TEXT SAYS.
   - Plural forms for discrete findings ("collections", "hematomas", "foci", "nodules", "lesions") set multiple=true.
   - Distribution descriptors (scattered, multifocal, focal, diffuse, patchy, confluent) always go into features.
   - Asymmetric bilateral wording ("left greater than right", "greater on the right") must be preserved. At minimum push the asymmetry phrasing into features; if the schema exposes asymmetric values, use them.
   - Causal/explanatory connectors ("compatible with", "consistent with", "in keeping with", "due to", "secondary to", "favored to represent", "likely a manifestation of") signal that an underlying diagnosis is being named. Extract the named diagnosis. If the observation and the diagnosis are different entities (e.g. "ventricular dilation in keeping with volume loss" - ventricles and atrophy are separable), emit BOTH and let the diagnosis row inherit location/laterality/size from the observation clause. If the observation IS the imaging signature of the diagnosis ("confluent hypodensities likely a manifestation of chronic small vessel disease"), emit ONLY the diagnosis to avoid double-counting.
   - Hematoma density encodes chronicity for blood products: hyperdense / high-attenuation -> chronicity="acute"; isodense / mixed-density / iso-to-hypodense -> chronicity="subacute" (or "evolving"); hypodense / low-attenuation / hypoattenuating -> chronicity="chronic". Preserve the verbatim density descriptor in features.

6. FIELD DISCIPLINE.
   - Do NOT apply a taxonomy entry outside its implied clinical context. For example, aneurysm_coil belongs to aneurysm treatment; do not use it for middle meningeal artery embolization for subdural hematoma (which uses particles or liquid embolic). When the report's procedure context does not match the taxonomy entry's context, pick the broader concept or emit unmapped:<concept>.
   - Free text goes ONLY in features or custom fields. The enum fields above accept only the listed values.
   - Device removal, retrieval, withdrawal, explantation, "taken out", "no longer in place": emit finding=<device>, presence="absent", temporal_status="resolved". Reuse the existing device taxonomy entry. Do NOT invent unmapped:<device>_removal concepts.
   - Residual-negation phrases ("Otherwise...", "Else...", "Aside from the above...", "Otherwise unremarkable", "No other significant...") are scope-limited and do not generate categorical absent findings, especially when they would contradict a finding just stated in the same paragraph. Skip them or mark them with a residual-scope feature.
   - Encode laterality only in the laterality field. Strip the side prefix from anatomic_site ("frontal lobe", not "right frontal lobe"). Bilateral findings: laterality="bilateral", anatomic_site side-free ("frontal lobes" not "bilateral frontal lobes").

TAXONOMY (use these finding names when possible):
${taxonomyBlock}

Output only the JSON array. No commentary, no markdown fencing, no extra text.`;
  }
};

window.ExtractionPrompt = ExtractionPrompt;
