/**
 * CSV upload and import logic using PapaParse.
 */

const CsvImport = {
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
   * Parse a CSV file and return { data, fields, errors }.
   * Tries multiple encodings via fallback chain.
   */
  async parseFile(file) {
    const text = await this._readFileWithEncoding(file);
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
   * Auto-detect column mappings from field names.
   */
  detectColumns(fields) {
    const idPatterns = ['record_id', 'id', 'report_id', 'case_id', 'accession'];
    const textPatterns = ['rad_deid_report', 'report_text', 'report', 'text', 'findings'];

    let idCol = null;
    let textCol = null;

    for (const pattern of idPatterns) {
      const match = fields.find(f => f.toLowerCase().includes(pattern));
      if (match) { idCol = match; break; }
    }

    for (const pattern of textPatterns) {
      const match = fields.find(f => f.toLowerCase().includes(pattern));
      if (match) { textCol = match; break; }
    }

    return { idCol, textCol };
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
      const id = (row[idCol] || '').trim();
      const text = (row[textCol] || '').trim();

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
  parseExtractionCsv(data, columnMap, validRecordIds) {
    const findings = [];
    const errors = [];

    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const recordId = (row[columnMap.record_id] || '').trim();
      const findingName = (row[columnMap.finding_name] || '').trim();

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
        const p = (row[columnMap.presence] || '').trim().toLowerCase();
        attrs.presence = ['present', 'absent', 'indeterminate'].includes(p) ? p : 'indeterminate';
      } else {
        attrs.presence = 'indeterminate';
      }

      // Map optional attribute columns
      let sourceText = '';
      for (const [attrName, colName] of Object.entries(columnMap)) {
        if (['record_id', 'finding_name', 'presence', 'sentence_idx', 'source_text'].includes(attrName)) continue;
        if (colName && row[colName]) {
          const val = row[colName].trim();
          if (!val || val.toLowerCase() === 'nan') continue;
          if (attrName === 'features') {
            attrs[attrName] = val.split(',').map(v => v.trim()).filter(Boolean);
          } else {
            attrs[attrName] = val;
          }
        }
      }

      if (columnMap.source_text && row[columnMap.source_text]) {
        sourceText = row[columnMap.source_text].trim();
        if (sourceText.toLowerCase() === 'nan') sourceText = '';
      }

      const sentenceIdx = columnMap.sentence_idx ? parseInt(row[columnMap.sentence_idx], 10) || null : null;

      findings.push({
        record_id: recordId,
        finding_name: findingName,
        source_text: sourceText,
        source_sentence_idx: sentenceIdx,
        attributes: attrs,
      });
    }

    return { findings, errors };
  }
};

window.CsvImport = CsvImport;
