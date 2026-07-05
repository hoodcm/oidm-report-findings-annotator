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
    return this.parseText(text, file.name);
  },

  /**
   * Parse extraction text (JSON or CSV) that didn't come from a File — e.g.
   * pasted directly into a textarea. Same { data, fields, errors } shape and
   * the same D3 tolerance as parseFile; `filenameHint` is optional (pasted
   * text has no filename, so format detection falls back entirely to
   * _looksLikeJsonText).
   */
  parseText(text, filenameHint = '') {
    if ((filenameHint && filenameHint.toLowerCase().endsWith('.json')) || this._looksLikeJsonText(text)) {
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

  // A JSON candidate doesn't have to start at byte zero (an LLM chat reply
  // often prefaces the array with a sentence — commonly "Sure, here you
  // go:", itself starting with a comma). A fenced code block anywhere is an
  // unambiguous JSON signal on its own (a CSV never contains a Markdown
  // fence) regardless of what precedes it — tolerate trailing whitespace
  // after the fence's language tag ("```json " with a space). Otherwise,
  // look for a bracket in the file's opening window; TWO OR MORE tight
  // commas (no space after — "id,name,text...") before it is the
  // multi-column CSV-header tell that rules JSON out. A single tight comma
  // isn't enough on its own — a terse preamble ("Sure,here you go:") can
  // legitimately have one — but a real CSV header packs several. Scoped to
  // the opening window only, so a bracket character buried deep in a
  // report-text CSV cell never triggers this.
  _looksLikeJsonText(text) {
    if (/```[\w-]*[ \t]*\r?\n\s*[\[{]/.test(text)) return true;
    const head = text.slice(0, 300);
    const bracketIdx = head.search(/[\[{]/);
    if (bracketIdx === -1) return false;
    const tightCommas = head.slice(0, bracketIdx).match(/,\S/g);
    return !tightCommas || tightCommas.length < 2;
  },

  // Curly "smart quotes" (from a word processor or a copy-paste) aren't
  // valid JSON structural delimiters. Only invoked as a repair fallback
  // when a strict parse fails, so it never touches an already-valid file.
  _normalizeSmartQuotes(text) {
    return text.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  },

  // Index of the closing bracket matching the opening bracket at `openIdx`,
  // respecting JSON string literals and escapes (so a `[` or `{` inside a
  // quoted source_text never miscounts). Returns -1 when the structure runs
  // off the end of the text unterminated (a truncated reply).
  _matchBracket(text, openIdx) {
    const open = text[openIdx];
    const close = open === '[' ? ']' : '}';
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = openIdx; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  },

  // Scan left to right for every top-level bracket structure ([...] or
  // {...}), skipping prose/fencing in between. Multiple spans means
  // multiple batches concatenated in one file; the last span may be
  // truncated (unterminated) when the reply got cut off mid-generation.
  //
  // A bracket character loose in prose before the real JSON (a cut-off
  // markdown link, an aside like "processing report [1 now") would
  // otherwise "eat" everything from itself to end-of-string as one
  // unmatched span, discarding a perfectly complete JSON payload that
  // follows it. Before accepting a match failure, retry from the next
  // occurrence of the SAME opening bracket (bounded, so a truly truncated
  // reply still falls through to the truncation-salvage path below).
  _findTopLevelJsonSpans(text) {
    const spans = [];
    const MAX_RETRIES = 5;
    let i = text.search(/[\[{]/);
    while (i !== -1 && i < text.length) {
      let start = i;
      let end = this._matchBracket(text, start);
      let retries = 0;
      while (end === -1 && retries < MAX_RETRIES) {
        const nextSameBracket = text.slice(start + 1).search(text[start] === '[' ? /\[/ : /\{/);
        if (nextSameBracket === -1) break;
        start = start + 1 + nextSameBracket;
        end = this._matchBracket(text, start);
        retries++;
      }
      if (end === -1) {
        // Genuinely unresolved even after retries — treat from the
        // ORIGINAL bracket as the truncated tail (today's salvage path).
        spans.push({ text: text.slice(i), truncated: true });
        break;
      }
      spans.push({ text: text.slice(start, end + 1), truncated: false });
      const next = text.slice(end + 1).search(/[\[{]/);
      if (next === -1) break;
      i = end + 1 + next;
    }
    return spans;
  },

  // Recover complete leading objects from a truncated `[...` array span
  // (no matching closing bracket — the reply was cut off). Walks object by
  // object; stops at the first object that is itself incomplete.
  _salvageTruncatedArray(spanText) {
    const recovered = [];
    if (spanText[0] !== '[') return recovered;
    let i = 1;
    while (i < spanText.length) {
      const objStart = spanText.slice(i).search(/[^\s,]/);
      if (objStart === -1) break;
      i += objStart;
      if (spanText[i] !== '{') break;
      const end = this._matchBracket(spanText, i);
      if (end === -1) break;
      try {
        recovered.push(JSON.parse(spanText.slice(i, end + 1)));
      } catch {
        break;
      }
      i = end + 1;
    }
    return recovered;
  },

  /**
   * Parse JSON extraction output, tolerating the shapes a real LLM chat
   * reply commonly arrives in: prose or fenced-code-block wrapping around
   * the JSON, a single finding object instead of an array, an object
   * wrapping the array under some key ({"findings": [...]} or any other
   * single array-valued key), multiple batches concatenated as separate
   * top-level arrays, a reply truncated mid-array, and curly "smart quotes"
   * in place of straight ones. Returns the same { data, fields, errors }
   * shape as the CSV path, plus a `notes` array of plain-language,
   * non-fatal messages (one per unwrap/repair actually applied). Garbage
   * input — nothing bracket-shaped, or nothing parses — still fails with
   * the same fatal error as before: tolerance never hides a real failure.
   */
  _parseJson(text) {
    const notes = [];
    const spans = this._findTopLevelJsonSpans(text);
    if (spans.length === 0) {
      return { data: [], fields: [], errors: [{ message: 'Expected a JSON array of finding objects.', type: 'fatal' }] };
    }

    const docs = [];
    let truncatedRecovered = null;
    for (const span of spans) {
      if (span.truncated) {
        if (span.text[0] === '[') {
          const recovered = this._salvageTruncatedArray(span.text);
          if (recovered.length) { docs.push(recovered); truncatedRecovered = recovered; }
        }
        continue;
      }
      try {
        docs.push(JSON.parse(span.text));
      } catch {
        try {
          docs.push(JSON.parse(this._normalizeSmartQuotes(span.text)));
          notes.push('straightened some curly "smart quotes" so the file could be read');
        } catch {
          // Unparseable span: skip it. If nothing else yields data, the
          // empty-result fatal error below still fires.
        }
      }
    }

    const findings = [];
    for (const doc of docs) {
      if (Array.isArray(doc)) { findings.push(...doc); continue; }
      if (doc && typeof doc === 'object') {
        // A wrapper key's value must itself look like a list of finding
        // OBJECTS — otherwise a lone finding whose own attribute happens to
        // be an array (e.g. a multi-value axis like chronicity: ["acute",
        // "chronic"], or features: [...]) gets its attribute values
        // mistaken for the findings list and the finding's other fields
        // (record_id, presence, source_text) silently vanish.
        const arrayEntries = Object.entries(doc).filter(([, v]) =>
          Array.isArray(v) && v.length > 0 && v.every(el => el && typeof el === 'object' && !Array.isArray(el)));
        if (arrayEntries.length === 1) {
          findings.push(...arrayEntries[0][1]);
          notes.push(`unwrapped the findings from the "${arrayEntries[0][0]}" field`);
        } else {
          findings.push(doc);
          notes.push('wrapped your single finding into a list');
        }
      }
    }

    if (findings.length === 0) {
      return { data: [], fields: [], errors: [{ message: 'Expected a JSON array of finding objects.', type: 'fatal' }] };
    }

    const nonTruncatedDocCount = docs.length - (truncatedRecovered ? 1 : 0);
    if (nonTruncatedDocCount > 1) {
      notes.push(`found ${nonTruncatedDocCount} separate batches in the file and combined them`);
    }
    if (truncatedRecovered) {
      const last = truncatedRecovered[truncatedRecovered.length - 1];
      const lastId = (last && last.record_id) || 'the last one shown';
      notes.push(`the AI's reply looked cut off — recovered ${truncatedRecovered.length} complete finding${truncatedRecovered.length === 1 ? '' : 's'}; ask it to continue from record ${lastId}`);
    }
    // Non-whitespace characters outside every found bracket span (a chatty
    // preamble/postamble, fence markers, "let me know if..." sign-off) means
    // prose or fencing was ignored to get here.
    const consumedLen = spans.reduce((n, s) => n + s.text.replace(/\s/g, '').length, 0);
    if (text.replace(/\s/g, '').length > consumedLen) {
      notes.push('ignored some text around the JSON');
    }

    const fieldSet = new Set();
    for (const obj of findings) {
      if (obj && typeof obj === 'object') for (const k of Object.keys(obj)) fieldSet.add(k);
    }
    return { data: findings, fields: [...fieldSet], errors: [], notes };
  },

  /**
   * Auto-detect column mappings from field names. Comparison uses
   * normalized column names (case-folded, separator-folded) so that
   * "Record ID", "record_id", and "record-id" all match the same target.
   * The returned column name is the original field name as it appears
   * in the CSV header (so callers can index rows with it).
   */
  // Column-name aliases for the two fields that DEFINE an "extractions" file
  // (one finding per row + the sentence it came from). Single source of truth,
  // shared by the import column-guesser and the drop-zone classifier's
  // extraction signature — so a file the importer would accept can never be
  // misclassified as reports (whose import destructively replaces the corpus).
  FINDING_NAME_ALIASES: ['finding_name', 'finding', 'name', 'diagnosis', 'observation'],
  SOURCE_TEXT_ALIASES: ['source_text', 'source', 'text', 'sentence', 'context'],

  // Match a header column against alias patterns: exact normalized name first,
  // then (unless exactOnly) a token-boundary pass. Token-boundary avoids bare
  // substring false positives like `id` matching `side`/`wide`/`midline`;
  // exactOnly is stricter still — used where a token match would over-route
  // (e.g. `name`/`text` token-matching `patient_name`/`report_text`).
  _matchField(fields, patterns, exactOnly = false) {
    for (const pattern of patterns) {
      const match = fields.find(f => Norm.colName(f) === pattern);
      if (match) return match;
    }
    if (exactOnly) return null;
    for (const pattern of patterns) {
      const match = fields.find(f => Norm.colName(f).split('_').includes(pattern));
      if (match) return match;
    }
    return null;
  },

  detectColumns(fields) {
    const idPatterns = ['record_id', 'id', 'report_id', 'case_id', 'accession'];
    const textPatterns = ['rad_deid_report', 'report_text', 'report', 'text', 'findings'];
    return { idCol: this._matchField(fields, idPatterns), textCol: this._matchField(fields, textPatterns) };
  },

  // The finding-name and source-text columns of an extractions file, via the
  // shared alias lists. Both non-null ⇒ the file has the extraction shape.
  // EXACT matches only (exactOnly): generic aliases like `name`/`text` would
  // token-match `patient_name`/`report_text` and misroute a reports CSV into
  // the extraction panel. Routing must be conservative; the import panel's own
  // column-guesser stays looser because the user confirms it.
  detectFindingColumns(fields) {
    return {
      findingNameCol: this._matchField(fields, this.FINDING_NAME_ALIASES, true),
      sourceTextCol: this._matchField(fields, this.SOURCE_TEXT_ALIASES, true),
    };
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
   * Returns { findings, errors, warnings, dropped, migrated, migrationNotes }:
   *   findings — [{record_id, finding_name, source_text, attributes}] rows that
   *     survived parsing (validation proper happens in validateExtractionRows)
   *   dropped — one entry per row rejected HERE (missing identity fields or an
   *     unknown record_id), carrying the row's identity + a _drop_reason, so
   *     callers can account for every input row instead of silently shrinking
   *     the denominator
   *   migrated / migrationNotes — count of rows whose attributes were converted
   *     from a legacy schema (Schema.migrateLegacyAttributes) + deduped notes
   */
  parseExtractionCsv(data, columnMap, validRecordIds, attributeConfig = {}) {
    const findings = [];
    const errors = [];
    const dropped = [];
    // Non-fatal notes (malformed/dropped confidence entries, boolean
    // coercions). Same "Row N: <plain message>" shape as errors, but these do
    // NOT reject the row. Plain-language for the radiologist audience.
    const warnings = [];
    let migrated = 0;
    const migrationNotes = new Set();

    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const recordId = Norm.cell(row[columnMap.record_id]);
      const findingName = Norm.cell(row[columnMap.finding_name]);
      const droppedRow = (reason) => {
        dropped.push({
          record_id: recordId,
          finding_name: findingName,
          source_text: columnMap.source_text ? Norm.cell(row[columnMap.source_text]) : '',
          _drop_reason: reason,
        });
      };

      if (!recordId || !findingName) {
        errors.push(`Row ${i + 2}: missing record_id or finding_name`);
        droppedRow('missing record_id or finding_name');
        continue;
      }

      if (validRecordIds && !validRecordIds.has(recordId)) {
        errors.push(`Row ${i + 2}: unknown record_id '${recordId}'`);
        droppedRow(`record_id '${recordId}' is not among the loaded reports`);
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
        // Array attrs (features) and multi-value enum axes (temporal_status,
        // chronicity) store a comma-split array. Everything else is a scalar.
        if (attrName === 'features' || Schema.isMultiValue(attrName)) {
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

      // Legacy-schema conversion: attributes named or valued under a prior
      // published schema (column renames like multiple → aggregate; severity
      // small/medium/large → extent) are moved to their current home before
      // any coercion or validation sees them.
      const legacyNotes = Schema.migrateLegacyAttributes(attrs);
      if (legacyNotes.length) {
        migrated++;
        for (const n of legacyNotes) migrationNotes.add(n);
      }

      // Boolean-attribute coercion (currently only `aggregate`): true/false →
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
          // JSON extraction files carry confidence as a native object already
          // (no stringify/parse round-trip needed); CSV cells carry it as a
          // JSON-encoded string. Routing an object through Norm.cell would
          // stringify it to "[object Object]" and fail JSON.parse below.
          if (cellVal && typeof cellVal === 'object' && !Array.isArray(cellVal)) {
            Object.assign(rawConfidence, cellVal);
            continue;
          }
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

    return { findings, errors, warnings, dropped, migrated, migrationNotes: [...migrationNotes] };
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
      // presence is hedgeable under the workbench polarity+hedge model. Accept a
      // presence hedge (subject to the has-value invariant below, like any axis)
      // when the schema allows it; drop it with a note only when it doesn't —
      // so workbench exports carrying confidence.presence are no longer corrupted.
      if (k === 'presence' && !Schema.isHedgeable('presence')) {
        notes.push(`ignored a hedge on 'presence' (presence isn't hedgeable in this schema)`);
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
   *                notInReport, outOfScope, boilerplate, multiSentence,
   *                crossAttributed, ambiguous, badPresence, badEnum },
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
      outOfScope: 0,
      boilerplate: 0,
      multiSentence: 0,
      crossAttributed: 0,
      ambiguous: 0,
      ambiguousAcrossReports: 0,
      badPresence: 0,
      badEnum: 0,
      presenceConverted: 0,
    };
    // Sample up to 3 rows for the ambiguousAcrossReports warning so the
    // panel can show concrete record_id pairs that need verification.
    const ambiguousAcrossReportsSamples = [];
    // Non-fatal notes for legacy 'indeterminate' presence values converted to
    // the polarity+hedge model (surfaced in the import panel, not blocking).
    const conversionNotes = [];

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
      // A legacy column name (e.g. `multiple`, the old name for `aggregate`)
      // is canonical-in-disguise: its values were already migrated per row,
      // so it must not be listed as a custom free-text column.
      if (Schema.legacyColumnTarget(target) && canonical.has(Schema.legacyColumnTarget(target))) continue;
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
          fix: `Every row must include record_id, finding_name, source_text, and presence (${Schema.presenceValues().join(' | ')}).`,
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
      //    Failure modes get distinct buckets because their fixes differ:
      //    out_of_scope (verbatim quote from the Impression/Conclusion),
      //    boilerplate (templated wording found in 3+ other reports — the
      //    named report likely has a near-variant), and crossAttributed
      //    (text found only in 1–2 other reports — a strong record_id
      //    mix-up signal). A quote that stitched several report sentences
      //    together still matches (anchored to its first uniquely-matching
      //    piece) but is review-flagged. When the named report matches AND
      //    the text also exists in other reports, the row passes validation
      //    but increments the non-blocking ambiguousAcrossReports bucket.
      if (errors.length === 0 && f.record_id && f.source_text) {
        const report = reportsById[f.record_id];
        const r = Sentences.matchSourceToSentence(
          f.source_text, report.sentences || [], f.record_id, allReports, report.report_text || '');
        const attachSuggestion = (err) => {
          if (r.suggestion) {
            err.suggestion = {
              idx: r.suggestion.idx,
              sentenceText: (report.sentences || [])[r.suggestion.idx - 1] || '',
            };
          }
          return err;
        };
        if (r.idx) {
          f.source_sentence_idx = r.idx;
          if (r.spannedPieces) {
            // The quote is real but spans several sentences; anchored to one.
            // Flag for the annotator to confirm the anchor is the right one.
            f._needsReview = true;
            counts.multiSentence++;
          }
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
        } else if (r.error === 'out_of_scope') {
          errors.push(attachSuggestion({
            msg: `source_text is in ${f.record_id} but outside the FINDINGS section`,
            fix: `The quote comes from the Impression/Conclusion, which the tool doesn't annotate. Re-extract quoting the FINDINGS sentence that states this finding — or apply the closest FINDINGS sentence below if it says the same thing.`,
          }));
          counts.outOfScope++;
        } else if (r.error === 'not_in_report') {
          const alsoCount = r.alsoMatchesIn?.length || 0;
          if (alsoCount > 0 && !r.boilerplate) {
            // Never attach a suggestion here: a cross-attributed row's own
            // record_id is likely wrong, and offering a same-report "closest
            // sentence" fix would let the annotator paper over the mix-up
            // instead of noticing it.
            errors.push({
              msg: `source_text not in ${f.record_id} but found in ${r.alsoMatchesIn.slice(0, 3).join(', ')}${alsoCount > 3 ? '...' : ''}`,
              fix: `Likely record_id mix-up; the text appears in another loaded report. Verify whether this row's record_id is correct.`,
            });
            counts.crossAttributed++;
          } else if (alsoCount > 0) {
            // Templated wording ("No pneumothorax.") that appears in many
            // reports but not verbatim in this one: the named report almost
            // certainly words this line slightly differently — a wording
            // problem, not a record_id problem, so the suggestion stays.
            errors.push(attachSuggestion({
              msg: `source_text not found in ${f.record_id} (templated wording — it appears in ${alsoCount} other reports)`,
              fix: `The named report likely words this line differently. Apply the closest-sentence suggestion below if it's right; otherwise verify the record_id.`,
            }));
            counts.boilerplate++;
          } else {
            errors.push(attachSuggestion({
              msg: `source_text not found in ${f.record_id}`,
              fix: `Verify source_text is a verbatim quote from the FINDINGS section. Paraphrased or hallucinated text won't match.`,
            }));
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

      // 4. presence enum. The accepted set derives from Schema.presenceValues().
      //    A legacy 'indeterminate' is accepted as an alias and converted in
      //    place to the polarity+hedge model (cue-aware) with a non-fatal note,
      //    so extraction files generated by the old prompt aren't rejected
      //    wholesale. Any other off-vocabulary value is an actionable error.
      const rawPresence = f.attributes?.presence;
      if (rawPresence === 'indeterminate') {
        const { presence, hedge } = Schema.convertIndeterminate(f.source_text);
        f.attributes.presence = presence;
        if (hedge && Schema.isHedgeable('presence')) {
          f.confidence = f.confidence || {};
          f.confidence.presence = 'hedged';
        }
        f._polarityReview = true;
        counts.presenceConverted++;
        conversionNotes.push(`'indeterminate' is retired — converted to ${presence === 'absent' ? 'no definite' : 'possible'} based on the sentence wording; flagged for review.`);
      } else if (rawPresence && !Schema.presenceValues().includes(rawPresence)) {
        errors.push({
          msg: `presence value "${rawPresence}" not recognized`,
          fix: `Allowed values: ${Schema.presenceValues().join(', ')}. Update your extraction.`,
        });
        counts.badPresence++;
      }

      // 5. canonical enum attributes. Multi-value axes hold an array; validate
      //    each element so the row error names the specific offending value.
      for (const [k, v] of Object.entries(f.attributes || {})) {
        if (k === 'presence') continue;
        const cfg = attributeConfig?.[k];
        if (!cfg || cfg.type !== 'enum') continue;
        const allowed = cfg.values.map(s => s.toLowerCase());
        const elements = Array.isArray(v) ? v : [v];
        for (const el of elements) {
          if (!allowed.includes(String(el).toLowerCase())) {
            errors.push({
              msg: `${k} value "${el}" not recognized`,
              fix: `Allowed values: ${cfg.values.join(', ')}.`,
              field: k,
            });
            counts.badEnum++;
          }
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
      severity: ['degree', 'grade'],
      extent: ['extent'],
      integrity: ['intact', 'integrity'],
      size: ['measurement', 'dimension', 'measures'],
      anatomic_site: ['site', 'location', 'anatomy', 'region'],
      tip_location: ['tip', 'terminus'],
      position_status: ['position', 'placement', 'malposition'],
      features: ['feature', 'descriptor', 'modifier'],
      aggregate: ['multiple', 'plural', 'count', 'instances'],
    };
    const canonicalAliasWarnings = [];
    const aliasEntries = Object.entries(ALIAS_TABLE).filter(([key]) => key in (attributeConfig || {}));
    for (const colName of customAttributes) {
      const norm = Norm.colName(colName);
      const tokens = norm.split('_').filter(Boolean);
      // Exact/token alias hits beat substring hits across the WHOLE table: a
      // short alias matched as a bare substring false-positives freely
      // ('tip' ⊂ 'multiple' suggested tip_location for a column that exactly
      // aliased aggregate), so substring matching is a second pass restricted
      // to aliases long enough (5+ chars) to be distinctive.
      let match = aliasEntries.find(([, aliases]) => aliases.some(a => norm === a || tokens.includes(a)));
      if (!match) {
        match = aliasEntries.find(([, aliases]) => aliases.some(a => a.length >= 5 && norm.includes(a)));
      }
      if (match) canonicalAliasWarnings.push({ column: colName, suggestedKey: match[0] });
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

    return { valid, invalid, counts, customAttributes, canonicalAliasWarnings, missingCanonicalColumns, ambiguousAcrossReportsSamples, conversionNotes };
  }
};

window.CsvImport = CsvImport;
