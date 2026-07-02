/**
 * CSV upload and import logic using PapaParse.
 */

/**
 * Input normalization helpers. These run before validation so users
 * are not punished for cosmetic input variations (whitespace, BOM,
 * Markdown fencing, case in column names, case in enum values).
 *
 * What we DO normalize: trim whitespace; strip UTF-8 BOM; strip
 * Markdown code-fence wrappers around the file body; case-fold for
 * enum and column-name comparisons.
 *
 * What we do NOT normalize: vocabulary translation (e.g. "lt" -> "left"),
 * unit conversion, abbreviation expansion. Those remain user-facing
 * validation errors with actionable fix messages.
 */
const Norm = {
  // Trim whitespace and strip a UTF-8 BOM if present at the start of a cell.
  cell(s) { return (s ?? '').toString().replace(/^﻿/, '').trim(); },
  // Same as cell but also strips a leading/trailing Markdown code fence,
  // for the case where an LLM wrapped its CSV output in ```csv ... ```
  text(s) {
    const stripped = (s ?? '').toString().replace(/^﻿/, '');
    return stripped.replace(/^```[\w]*\r?\n/, '').replace(/\r?\n```\s*$/, '').trim();
  },
  // Lowercase + collapse whitespace, used for case-insensitive enum membership.
  enumValue(s) { return Norm.cell(s).toLowerCase(); },
  // Normalize a column name (case, separators) so that "Record ID", "record_id",
  // and "record-id" all match the same target.
  colName(s) { return Norm.cell(s).toLowerCase().replace(/[\s\-]+/g, '_'); },
};

const CsvImport = {
  Norm,

  /**
   * Read file text with encoding fallback chain: UTF-8 → Latin-1 → Windows-1252.
   * Detects encoding failure by presence of U+FFFD replacement characters.
   */
  _readFileWithEncoding(file) {
    const encodings = ['UTF-8', 'ISO-8859-1', 'windows-1252'];
    return new Promise((resolve, reject) => {
      let attempt = 0;
      const tryNext = () => {
        if (attempt >= encodings.length) {
          reject(new Error('Could not decode CSV with any supported encoding'));
          return;
        }
        const encoding = encodings[attempt];
        const reader = new FileReader();
        reader.onload = () => {
          const text = reader.result;
          // UTF-8 failures produce U+FFFD; if found and more encodings to try, retry
          if (attempt === 0 && text.includes('\uFFFD') && encodings.length > 1) {
            attempt++;
            tryNext();
          } else {
            resolve(text);
          }
        };
        reader.onerror = () => {
          attempt++;
          tryNext();
        };
        reader.readAsText(file, encoding);
      };
      tryNext();
    });
  },

  /**
   * Parse an extraction file (JSON or CSV) and return { data, fields, errors }.
   * Format is auto-detected from extension first, then content shape.
   * CSV path tries multiple encodings via fallback chain.
   */
  async parseFile(file) {
    const raw = await this._readFileWithEncoding(file);
    const text = Norm.text(raw);

    const looksLikeJson = file.name.toLowerCase().endsWith('.json')
      || /^\s*[\[{]/.test(text);

    if (looksLikeJson) {
      return this._parseJson(text);
    }

    return new Promise((resolve, reject) => {
      Papa.parse(text, {
        header: true,
        skipEmptyLines: true,
        complete(results) {
          resolve({
            data: results.data,
            fields: results.meta.fields || [],
            errors: results.errors,
          });
        },
        error(err) {
          reject(err);
        },
      });
    });
  },

  /**
   * Parse JSON extraction output. Expects a top-level array of finding
   * objects. Returns the same { data, fields, errors } shape as the CSV
   * path so downstream code is format-agnostic.
   */
  _parseJson(text) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      return { data: [], fields: [], errors: [{ message: `JSON parse failed: ${e.message}`, type: 'fatal' }] };
    }
    if (!Array.isArray(parsed)) {
      return { data: [], fields: [], errors: [{ message: 'Expected a JSON array of finding objects.', type: 'fatal' }] };
    }
    const fieldSet = new Set();
    for (const obj of parsed) {
      if (obj && typeof obj === 'object') {
        for (const k of Object.keys(obj)) fieldSet.add(k);
      }
    }
    return { data: parsed, fields: [...fieldSet], errors: [] };
  },

  /**
   * Auto-detect column mappings from field names. Comparison uses
   * normalized column names (case-folded, separator-folded) so that
   * "Record ID", "record_id", and "record-id" all match the same target.
   * The returned column name is the original field name as it appears
   * in the CSV header (so callers can index rows with it).
   */
  detectColumns(fields) {
    const idPatterns = ['record_id', 'id', 'report_id', 'case_id', 'accession'];
    const textPatterns = ['rad_deid_report', 'report_text', 'report', 'text', 'findings'];

    // Two-pass match: exact first, then token-boundary. Avoids bare substring
    // false positives like `id` matching `side`, `wide`, `evidence`, `midline`.
    const findField = (patterns) => {
      for (const pattern of patterns) {
        const match = fields.find(f => Norm.colName(f) === pattern);
        if (match) return match;
      }
      for (const pattern of patterns) {
        const match = fields.find(f => Norm.colName(f).split('_').includes(pattern));
        if (match) return match;
      }
      return null;
    };

    return { idCol: findField(idPatterns), textCol: findField(textPatterns) };
  },

  /**
   * Validate mapped data for issues.
   * Returns { valid: bool, errors: string[], warnings: string[] }.
   */
  validateMapping(data, idCol, textCol) {
    const errors = [];
    const warnings = [];
    if (!idCol || !textCol) {
      errors.push('Both ID column and text column must be selected');
      return { valid: false, errors, warnings };
    }
    const ids = new Set();
    let emptyIds = 0;
    let emptyTexts = 0;

    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const id = Norm.cell(row[idCol]);
      const text = Norm.cell(row[textCol]);

      if (!id) { emptyIds++; continue; }
      if (!text) { emptyTexts++; continue; }

      if (ids.has(id)) {
        errors.push(`Duplicate ID "${id}" at row ${i + 2}`);
      }
      ids.add(id);
    }

    if (emptyIds > 0) warnings.push(`${emptyIds} rows with empty IDs (will be skipped)`);
    if (emptyTexts > 0) warnings.push(`${emptyTexts} rows with empty text (will be skipped)`);
    if (ids.size === 0) errors.push('No valid rows found');

    return { valid: errors.length === 0, errors, warnings };
  },

  /**
   * Parse extraction CSV for import.
   * @param {Array} data - Parsed CSV rows
   * @param {Object} columnMap - Column name mapping
   * @param {Set} [validRecordIds] - Optional set of valid record IDs for validation
   * Returns { findings: [{record_id, finding_name, source_text, attributes}], errors }.
   */
  parseExtractionCsv(data, columnMap, validRecordIds, attributeConfig = {}) {
    const findings = [];
    const errors = [];
    // Non-fatal notes (malformed/dropped confidence entries, boolean
    // coercions). Same "Row N: <plain message>" shape as errors, but these do
    // NOT reject the row. Plain-language for the radiologist audience.
    const warnings = [];

    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const recordId = Norm.cell(row[columnMap.record_id]);
      const findingName = Norm.cell(row[columnMap.finding_name]);

      if (!recordId || !findingName) {
        errors.push(`Row ${i + 2}: missing record_id or finding_name`);
        continue;
      }

      if (validRecordIds && !validRecordIds.has(recordId)) {
        errors.push(`Row ${i + 2}: unknown record_id '${recordId}'`);
        continue;
      }

      const attrs = {};
      if (columnMap.presence) {
        const p = Norm.enumValue(row[columnMap.presence]);
        // Preserve the raw (lowercased) value so the validator can flag
        // off-vocabulary values. Leave null when the cell is empty so the
        // validator can reject the row as missing-required-field; presence
        // is part of the contract, not auto-filled.
        attrs.presence = p || null;
      } else {
        attrs.presence = null;
      }

      // Map any other column the user provided into attributes.
      // Reserved keys (record_id, finding_name, presence, source_text, sentence_idx)
      // are skipped — they're consumed elsewhere or intentionally ignored.
      // Everything else is preserved: canonical attributes (laterality, severity,
      // etc.) get assigned via their columnMap mapping, custom columns the user
      // didn't map explicitly fall through to the all-columns sweep below.
      let sourceText = '';
      const RESERVED = new Set(['record_id', 'finding_name', 'presence', 'sentence_idx', 'source_text']);
      const consumedColumns = new Set([
        columnMap.record_id, columnMap.finding_name,
        columnMap.presence, columnMap.source_text, columnMap.sentence_idx,
      ].filter(Boolean));

      for (const [attrName, colName] of Object.entries(columnMap)) {
        if (RESERVED.has(attrName)) continue;
        if (!colName) continue;
        consumedColumns.add(colName);
        const raw = row[colName];
        if (raw == null) continue;
        const val = Norm.cell(raw);
        if (!val || val.toLowerCase() === 'nan' || val.toLowerCase() === 'null') continue;
        if (attrName === 'features') {
          attrs[attrName] = val.split(',').map(v => v.trim()).filter(Boolean);
        } else {
          attrs[attrName] = val;
        }
      }

      // Sweep any column the user provided but didn't explicitly map. These
      // are auto-detected custom attributes: preserved as-is, free text. The
      // column name (after light normalization) becomes the attribute key.
      for (const [colName, raw] of Object.entries(row)) {
        if (consumedColumns.has(colName)) continue;
        if (raw == null) continue;
        const val = Norm.cell(raw);
        if (!val || val.toLowerCase() === 'nan' || val.toLowerCase() === 'null') continue;
        const key = Norm.colName(colName);
        if (RESERVED.has(key)) continue;
        // Confidence columns (the `confidence` JSON map and any `<axis>_confidence`
        // column) are consumed by the confidence path below, never swept in as
        // custom attributes.
        if (key === 'confidence' || /_confidence$/.test(key)) continue;
        // Don't overwrite a canonical attribute the user already mapped.
        if (attrs[key] != null) continue;
        attrs[key] = val;
      }

      if (columnMap.source_text && row[columnMap.source_text] != null) {
        sourceText = Norm.cell(row[columnMap.source_text]);
        if (sourceText.toLowerCase() === 'nan' || sourceText.toLowerCase() === 'null') sourceText = '';
      }

      // Boolean-attribute coercion (currently only `multiple`): true/false →
      // the lowercase strings; any other value is NOT stored as free text —
      // it's dropped with a non-fatal note, so a malformed boolean never
      // reaches the canonical CSV column. (Mirrors the enum-validation
      // discipline in validateExtractionRows.)
      for (const key of Object.keys(attrs)) {
        if (attributeConfig[key] && attributeConfig[key].type === 'boolean') {
          const raw = String(attrs[key]).trim().toLowerCase();
          if (raw === 'true' || raw === 'false') {
            attrs[key] = raw;
          } else {
            warnings.push(`Row ${i + 2}: '${attrs[key]}' isn't a yes/no value for '${key}' — left blank`);
            delete attrs[key];
          }
        }
      }

      // Confidence: assemble a raw map from an optional `confidence` JSON column
      // and/or any `<axis>_confidence` columns, then normalize against this
      // row's attributes (a user-uploaded system boundary — shape isn't assumed).
      let rawConfidence = {};
      for (const [colName, cellVal] of Object.entries(row)) {
        const norm = Norm.colName(colName);
        if (norm === 'confidence') {
          const s = Norm.cell(cellVal);
          if (!s || s === '{}' || s.toLowerCase() === 'nan' || s.toLowerCase() === 'null') continue;
          let parsed;
          try {
            parsed = JSON.parse(s);
          } catch {
            warnings.push(`Row ${i + 2}: skipped the hedge information for this row because it couldn't be read`);
            continue;
          }
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            Object.assign(rawConfidence, parsed);
          } else {
            warnings.push(`Row ${i + 2}: skipped the hedge information for this row because it wasn't in the expected form`);
          }
        } else if (/_confidence$/.test(norm)) {
          const axis = norm.replace(/_confidence$/, '');
          const v = Norm.cell(cellVal);
          if (v && v.toLowerCase() !== 'nan' && v.toLowerCase() !== 'null') rawConfidence[axis] = v;
        }
      }
      const { confidence, notes } = this.normalizeConfidence(rawConfidence, attrs);
      for (const n of notes) warnings.push(`Row ${i + 2}: ${n}`);

      // sentence_idx is intentionally ignored: the annotator computes
      // sentence assignment deterministically from source_text.
      const sentenceIdx = null;

      const finding = {
        record_id: recordId,
        finding_name: findingName,
        source_text: sourceText,
        source_sentence_idx: sentenceIdx,
        attributes: attrs,
      };
      // Omit confidence entirely when empty (canonical shape).
      if (Object.keys(confidence).length) finding.confidence = confidence;
      findings.push(finding);
    }

    return { findings, errors, warnings };
  },

  /**
   * Normalize a raw confidence map against a finding's assembled attributes.
   * Keeps only entries whose key !== 'presence', whose value normalizes to the
   * string 'hedged', AND whose axis has a present, non-empty attribute value
   * (the confidence invariant). Everything else is dropped with a plain-language
   * note; a wholly wrong-typed value (array/string/number) → {} + one note.
   * Never throws — the CSV is a user-uploaded boundary.
   *
   * @returns {{ confidence: Object, notes: string[] }} notes are message
   *   fragments (no "Row N:" prefix — the caller adds row context).
   */
  normalizeConfidence(raw, attributes) {
    const confidence = {};
    const notes = [];
    const attrs = attributes || {};
    const hasValue = (k) => {
      const v = attrs[k];
      return v != null && v !== '' && !(Array.isArray(v) && v.length === 0);
    };
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      if (raw !== null && raw !== undefined && raw !== '') {
        notes.push(`the hedge information for this row wasn't in the expected form, so it was skipped`);
      }
      return { confidence, notes };
    }
    for (const [k, v] of Object.entries(raw)) {
      const val = String(v == null ? '' : v).trim().toLowerCase();
      if (k === 'presence') {
        notes.push(`ignored a hedge on 'presence' (presence can't be hedged here)`);
        continue;
      }
      if (val !== 'hedged') {
        notes.push(`ignored a '${v}' confidence on '${k}' (only 'hedged' is recognized)`);
        continue;
      }
      if (!hasValue(k)) {
        notes.push(`ignored a hedge on '${k}' because that attribute has no value`);
        continue;
      }
      confidence[k] = 'hedged';
    }
    return { confidence, notes };
  },

  /**
   * Aggressively validate already-parsed extraction rows. Runs BEFORE
   * import is committed so the user sees every problem up front and
   * never starts labeling on bad data.
   *
   * Each row is checked for:
   *   - required fields (record_id, finding_name, source_text)
   *   - record_id known in the loaded report set
   *   - source_text matches exactly one sentence in that report
   *     (uses Sentences.matchSourceToSentence — same matcher as runtime)
   *   - canonical attributes pass enum validation (case-insensitive)
   *
   * Custom attribute columns (any column not reserved and not in
   * attributeConfig) pass through without validation as free text.
   *
   * Returns:
   *   {
   *     valid:   [...findings ready to import],
   *     invalid: [...findings with _validation_errors attached],
   *     counts:  { total, ready, missingRequired, unknownRecord,
   *                notInReport, ambiguous, badPresence, badEnum },
   *     customAttributes: Set<string>  // column names that aren't canonical
   *   }
   *
   * The Sentences module is passed in (rather than imported) to avoid a
   * circular reference; the caller wires it from the global Sentences.
   */
  validateExtractionRows(parsedFindings, reportsById, attributeConfig, columnMap, fields, Sentences) {
    const valid = [];
    const invalid = [];
    const counts = {
      total: parsedFindings.length,
      ready: 0,
      missingRequired: 0,
      unknownRecord: 0,
      notInReport: 0,
      crossAttributed: 0,
      ambiguous: 0,
      ambiguousAcrossReports: 0,
      badPresence: 0,
      badEnum: 0,
    };
    // Sample up to 3 rows for the ambiguousAcrossReports warning so the
    // panel can show concrete record_id pairs that need verification.
    const ambiguousAcrossReportsSamples = [];

    // Identify columns the user provided that are neither reserved nor canonical.
    // These will be preserved as custom (free-text) attributes on the finding.
    const RESERVED = new Set(['record_id', 'finding_name', 'presence', 'sentence_idx', 'source_text']);
    const canonical = new Set(Object.keys(attributeConfig || {}));
    const customAttributes = new Set();
    for (const f of (fields || [])) {
      const norm = Norm.colName(f);
      // Reserve the confidence column and the `<axis>_confidence` suffix family
      // BEFORE the set is built, so they never reach the validation panel's
      // custom-attribute listing NOR the downstream canonical-alias pass (which
      // would otherwise mis-suggest `chronicity_confidence` → `chronicity`).
      if (norm === 'confidence' || /_confidence$/.test(norm)) continue;
      // Map back via columnMap: if the user mapped this field to a canonical
      // attribute key, it's not custom. Otherwise it might be.
      const mappedTo = Object.entries(columnMap || {}).find(([, col]) => col === f)?.[0];
      const target = mappedTo || norm;
      if (RESERVED.has(target)) continue;
      if (canonical.has(target)) continue;
      customAttributes.add(f);
    }

    const allReports = Object.values(reportsById);
    const knownIds = new Set(Object.keys(reportsById));
    const knownIdsSample = [...knownIds].slice(0, 3).join(', ');

    for (const f of parsedFindings) {
      const errors = [];

      // 1. Required fields. Presence joins record_id / finding_name /
      //    source_text as a hard required field; the parser leaves it null
      //    when missing so this check rejects the row instead of silently
      //    defaulting to 'indeterminate'.
      const presenceMissing = !f.attributes?.presence;
      if (!f.record_id || !f.finding_name || !f.source_text || presenceMissing) {
        const missing = [
          !f.record_id ? 'record_id' : null,
          !f.finding_name ? 'finding_name' : null,
          !f.source_text ? 'source_text' : null,
          presenceMissing ? 'presence' : null,
        ].filter(Boolean).join(', ');
        errors.push({
          msg: `missing required field(s): ${missing}`,
          fix: `Every row must include record_id, finding_name, source_text, and presence (present | absent | indeterminate).`,
        });
        counts.missingRequired++;
      }

      // 2. record_id must exist in loaded reports
      if (f.record_id && !knownIds.has(f.record_id)) {
        errors.push({
          msg: `record_id "${f.record_id}" not in loaded reports`,
          fix: `Either re-import reports CSV including this record, or check for typo. Known IDs: ${knownIdsSample}${knownIds.size > 3 ? '...' : ''}.`,
        });
        counts.unknownRecord++;
      }

      // 3. source_text matches exactly one sentence in the named report.
      //    Cross-attribution (text not in named report but IS in another
      //    loaded report) gets its own bucket: it's a strong record_id
      //    mix-up signal, qualitatively different from a paraphrase miss.
      //    When the named report matches AND the text also exists in
      //    other reports, the row passes validation but increments the
      //    non-blocking ambiguousAcrossReports warning bucket.
      if (errors.length === 0 && f.record_id && f.source_text) {
        const report = reportsById[f.record_id];
        const r = Sentences.matchSourceToSentence(f.source_text, report.sentences || [], f.record_id, allReports);
        if (r.idx) {
          f.source_sentence_idx = r.idx;
          if (r.alsoMatchesIn && r.alsoMatchesIn.length > 0) {
            counts.ambiguousAcrossReports++;
            if (ambiguousAcrossReportsSamples.length < 3) {
              ambiguousAcrossReportsSamples.push({
                record_id: f.record_id,
                finding_name: f.finding_name,
                alsoIn: r.alsoMatchesIn.slice(0, 3),
              });
            }
          }
        } else if (r.error === 'not_in_report') {
          const alsoCount = r.alsoMatchesIn?.length || 0;
          if (alsoCount > 0) {
            errors.push({
              msg: `source_text not in ${f.record_id} but found in ${r.alsoMatchesIn.slice(0, 3).join(', ')}${alsoCount > 3 ? '...' : ''}`,
              fix: `Likely record_id mix-up; the text appears in another loaded report. Verify whether this row's record_id is correct.`,
            });
            counts.crossAttributed++;
          } else {
            errors.push({
              msg: `source_text not found in ${f.record_id}`,
              fix: `Verify source_text is a verbatim quote from the FINDINGS section. Paraphrased or hallucinated text won't match.`,
            });
            counts.notInReport++;
          }
        } else if (r.error === 'ambiguous') {
          errors.push({
            msg: `source_text matches ${r.matches.length} sentences in ${f.record_id}`,
            fix: `Add the section header to source_text to disambiguate, e.g., "Brain Parenchyma: - No mass effect."`,
          });
          counts.ambiguous++;
        }
      }

      // 4. presence enum — raw value is preserved through parsing, so
      //    off-vocabulary values surface here as actionable errors.
      const rawPresence = f.attributes?.presence;
      if (rawPresence && !['present', 'absent', 'indeterminate'].includes(rawPresence)) {
        errors.push({
          msg: `presence value "${rawPresence}" not recognized`,
          fix: `Allowed values: present, absent, indeterminate. Update your extraction.`,
        });
        counts.badPresence++;
      }

      // 5. canonical enum attributes
      for (const [k, v] of Object.entries(f.attributes || {})) {
        if (k === 'presence') continue;
        const cfg = attributeConfig?.[k];
        if (!cfg || cfg.type !== 'enum') continue;
        const allowed = cfg.values.map(s => s.toLowerCase());
        const got = String(v).toLowerCase();
        if (!allowed.includes(got)) {
          errors.push({
            msg: `${k} value "${v}" not recognized`,
            fix: `Allowed values: ${cfg.values.join(', ')}.`,
          });
          counts.badEnum++;
        }
      }

      if (errors.length === 0) {
        valid.push(f);
        counts.ready++;
      } else {
        invalid.push({ ...f, _validation_errors: errors });
      }
    }

    // Detect canonical-vs-custom attribute drift: CSV columns that look like
    // they should map to a canonical attribute (laterality, temporal_status,
    // chronicity, etc.) but were swept in as free-text custom attributes.
    // Catches the " case" where the CSV had attribute data under
    // slightly off-spec column names and rows imported with the wrong schema.
    const ALIAS_TABLE = {
      laterality: ['lat', 'side', 'lateral'],
      temporal_status: ['temporal', 'change', 'comparison'],
      chronicity: ['chronic', 'acuity', 'duration', 'age'],
      severity: ['degree', 'grade', 'extent'],
      size: ['measurement', 'dimension', 'measures'],
      anatomic_site: ['site', 'location', 'anatomy', 'region'],
      tip_location: ['tip', 'terminus'],
      position_status: ['position', 'placement', 'malposition'],
      features: ['feature', 'descriptor', 'modifier'],
      multiple: ['plural', 'count', 'instances'],
    };
    const canonicalAliasWarnings = [];
    for (const colName of customAttributes) {
      const norm = Norm.colName(colName);
      const tokens = norm.split('_').filter(Boolean);
      for (const [canonical, aliases] of Object.entries(ALIAS_TABLE)) {
        if (!canonical || canonical in (attributeConfig || {}) === false) continue;
        const hit = aliases.some(a => tokens.includes(a) || norm === a || norm.includes(a));
        if (hit) {
          canonicalAliasWarnings.push({ column: colName, suggestedKey: canonical });
          break;
        }
      }
    }

    // Detect tool-export round-trip with missing canonical attribute columns.
    // If the CSV looks like it came from this tool (record_id + finding_name +
    // source_text + taxonomy_id all present), then every canonical attribute
    // key in attributeConfig is expected to be a column; missing ones likely
    // indicate a round-trip regression.
    const normalizedFields = (fields || []).map(f => Norm.colName(f));
    const isToolExport = ['record_id', 'finding_name', 'source_text', 'taxonomy_id']
      .every(req => normalizedFields.includes(req));
    const missingCanonicalColumns = [];
    if (isToolExport) {
      for (const key of Object.keys(attributeConfig || {})) {
        if (key === 'presence') continue;
        if (!normalizedFields.includes(key)) missingCanonicalColumns.push(key);
      }
    }

    return { valid, invalid, counts, customAttributes, canonicalAliasWarnings, missingCanonicalColumns, ambiguousAcrossReportsSamples };
  }
};

window.CsvImport = CsvImport;
