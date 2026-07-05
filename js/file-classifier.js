/**
 * Universal drop-zone file classifier.
 *
 * One pure function decides what an accepted file is, so the drop zone can
 * route it without asking the user. Classification runs tightest-signature
 * first — the precedence order is a contract (see the plan's D1 and the
 * table-test in tests/file-classifier.test.js):
 *
 *   1. .idm / zip magic (PK\x03\x04)            → 'idm'
 *   2. JSON object with {version, reports}      → 'session'
 *   3. JSON array of objects, OR the same array
 *      recoverable via D3 tolerance (prose/fenced
 *      wrapping, a wrapper key, a lone object, a
 *      truncated reply, multiple batches, curly
 *      smart quotes — CsvImport._parseJson), OR a
 *      CSV with a finding-name + source-text column
 *      (any of the CsvImport alias names)         → 'extraction'
 *      (a taxonomy_id column adds a "tool export" note)
 *   4. CSV with id + name + category columns
 *      (required cols only — parent_id optional) → 'taxonomy'
 *   5. CSV with an ID-like column + a long-text
 *      column (median cell length > 200 chars)  → 'reports'
 *   6. none of the above                        → 'unknown'
 *
 * The ordering matters: an extraction CSV can also satisfy the looser
 * reports signature (it has an id-ish column), and a tool-export CSV
 * satisfies both the extraction and (potentially) taxonomy shapes. Every
 * routed file carries a one-line plain-language `rationale` so routing
 * never feels like magic.
 */

const FileClassifier = {
  // Zip local-file-header magic — the first four bytes of every zip (and
  // therefore every .idm bundle).
  ZIP_MAGIC: 'PK\x03\x04',

  // Median cell length above which a CSV column counts as "report text".
  LONG_TEXT_MEDIAN: 200,

  /**
   * Classify pre-extracted file signals. Pure — no File/FileReader access,
   * so the Node test runner exercises the same code the browser runs.
   *
   * @param {Object} input
   * @param {string} input.name  original filename (extension is a hint only)
   * @param {string} input.text  decoded file text (may be empty for binaries)
   * @param {boolean} [input.isZip]  true when the first bytes match ZIP_MAGIC
   * @returns {{type: string, rationale: string, note?: string}}
   */
  classify({ name = '', text = '', isZip = false }) {
    // 1. Zip container (.idm bundle). Byte check from the caller wins, with a
    //    text-prefix fallback for callers that only read text.
    if (isZip || text.startsWith(this.ZIP_MAGIC)) {
      return { type: 'idm', rationale: 'recognized as a data bundle (a single zipped file)' };
    }

    const trimmed = (text || '').replace(/^﻿/, '').trim();

    // 2 + 3 (JSON arm). Session shape is checked with a STRICT parse first —
    // it must be an unambiguous, well-formed {version, reports} object, so a
    // real session file is never mistaken for a wrapper-shaped extraction
    // file (a session's own `reports` array would otherwise look exactly
    // like a single array-valued key to the tolerant extraction parser
    // below). Everything else routes through CsvImport's tolerant JSON
    // parser (same front door parseFile uses) so a dropped file gets the
    // same D3 tolerance here as it would on the extraction import panel:
    // prose/fenced wrapping, a lone finding object, {"findings": [...]}
    // (any key), multiple concatenated batches, a truncated reply, and
    // curly "smart quotes" all still route to 'extraction'.
    if (CsvImport._looksLikeJsonText(trimmed)) {
      let strict;
      try { strict = JSON.parse(trimmed); } catch { strict = null; }
      if (strict && !Array.isArray(strict) && typeof strict === 'object'
          && 'version' in strict && 'reports' in strict) {
        return { type: 'session', rationale: 'recognized as a saved session to restore' };
      }

      // A clean top-level array of objects is unconditionally 'extraction'
      // (the original, pre-D3 contract — unchanged) — this is also how a
      // bare exported taxonomy.json routes, which has no finding-name/
      // source-text fields at all but has nowhere else to go (taxonomy JSON
      // is otherwise only consumed from inside an .idm bundle).
      if (Array.isArray(strict) && strict.length > 0 && strict.every(x => x && typeof x === 'object' && !Array.isArray(x))) {
        const result = { type: 'extraction', rationale: 'recognized as AI-extracted findings' };
        if (strict.some(x => 'taxonomy_id' in x)) result.note = 'this looks like a file this tool exported';
        return result;
      }

      // Anything else needs D3 tolerance to become an array at all: prose/
      // fenced wrapping, a wrapper key ({"findings": [...]}, any key name),
      // a lone finding object, multiple concatenated batches, a truncated
      // reply, or curly "smart quotes". Since the shape itself no longer
      // implies "this is meant to be findings" the way a bare array does,
      // additionally require the same finding-name + source-text signature
      // the CSV arm requires below — so an arbitrary JSON object like
      // {"foo": 1} never gets routed into the extraction-review flow on a
      // guess.
      const parsed = CsvImport._parseJson(trimmed);
      if (parsed.errors.length > 0) {
        return {
          type: 'unknown',
          rationale: 'this looks like a saved file but couldn\'t be read — it may be incomplete',
        };
      }
      const ext = CsvImport.detectFindingColumns(parsed.fields);
      if (ext.findingNameCol && ext.sourceTextCol) {
        const result = { type: 'extraction', rationale: 'recognized as AI-extracted findings' };
        if (parsed.notes && parsed.notes.length) result.note = parsed.notes.join('; ');
        else if (parsed.data.some(x => x && 'taxonomy_id' in x)) result.note = 'this looks like a file this tool exported';
        return result;
      }
      return {
        type: 'unknown',
        rationale: 'this isn\'t a saved session or a list of findings the app can read',
      };
    }

    // CSV arms. One bounded parse (header + a sample of rows) feeds all
    // three signatures.
    const sample = this._sampleCsv(trimmed);
    if (!sample || sample.fields.length === 0) {
      return {
        type: 'unknown',
        rationale: 'this file isn\'t a data bundle, a saved session, or a readable spreadsheet',
      };
    }
    const norm = sample.fields.map(f => CsvImport.Norm.colName(f));
    const has = (col) => norm.includes(col);

    // 3 (CSV arm). Extractions: a finding-name column + a source-text column,
    // detected via the SAME alias lists the importer accepts (CsvImport) — so a
    // valid extractions file using column names like `name`/`text` routes here
    // rather than falling through to the destructive reports import.
    const ext = CsvImport.detectFindingColumns(sample.fields);
    if (ext.findingNameCol && ext.sourceTextCol) {
      const result = {
        type: 'extraction',
        rationale: 'recognized as AI-extracted findings (a finding and the sentence it came from)',
      };
      if (has('taxonomy_id')) result.note = 'this looks like a file this tool exported';
      return result;
    }

    // 4. Taxonomy: id + name + category. parent_id is optional — flat
    //    taxonomies are legal.
    if (has('id') && has('name') && has('category')) {
      return { type: 'taxonomy', rationale: 'recognized as a taxonomy (a list of finding types)' };
    }

    // 5. Reports: an ID-like column plus a long-text column.
    const { idCol } = CsvImport.detectColumns(sample.fields);
    if (idCol && this._hasLongTextColumn(sample)) {
      return { type: 'reports', rationale: 'recognized as reports (an ID column and a column of report text)' };
    }

    return {
      type: 'unknown',
      rationale: 'this spreadsheet doesn\'t match a findings list, a set of reports, '
        + 'or AI-extracted findings — check it has the expected columns',
    };
  },

  /**
   * Browser entry point: read the signals off a File, then classify.
   * Kept thin so everything decision-shaped stays in classify().
   */
  async classifyFile(file) {
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    const isZip = head.length === 4
      && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
    // Binary bundles never need their text; everything else does.
    const text = isZip ? '' : await file.text();
    return this.classify({ name: file.name, text, isZip });
  },

  // Parse the header plus a bounded sample of rows. Real CSV parsing (Papa)
  // because report cells legally contain quoted commas and newlines that a
  // line-split would garble.
  _sampleCsv(text) {
    if (!text) return null;
    const parsed = Papa.parse(text, { header: true, skipEmptyLines: true, preview: 20 });
    const fields = (parsed.meta && parsed.meta.fields || []).filter(f => (f || '').trim() !== '');
    return { fields, rows: parsed.data || [] };
  },

  // True when any column's median cell length over the sample exceeds the
  // long-text threshold — the report-text signature.
  _hasLongTextColumn(sample) {
    if (!sample.rows.length) return false;
    for (const field of sample.fields) {
      const lengths = sample.rows
        .map(r => (r[field] == null ? '' : String(r[field])).length)
        .sort((a, b) => a - b);
      const median = lengths[Math.floor(lengths.length / 2)];
      if (median > this.LONG_TEXT_MEDIAN) return true;
    }
    return false;
  },
};

window.FileClassifier = FileClassifier;
