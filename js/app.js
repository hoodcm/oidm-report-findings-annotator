/**
 * Alpine.js application store and UI logic.
 */

const MAX_CSV_SIZE = 10 * 1024 * 1024;     // 10 MB
const MAX_SESSION_SIZE = 50 * 1024 * 1024;  // 50 MB

// Single source of truth for the on-disk report schema version. Bump
// this when changes to sentence splitting, finding shape, or migration
// logic require re-deriving stored data.
const SCHEMA_VERSION = 4;

document.addEventListener('alpine:init', () => {

  Alpine.store('app', {
    // View management
    currentView: 'welcome',

    // Report data
    recordIds: [],
    currentIdx: 0,
    report: null,
    selectedSentenceIdx: null,

    // Taxonomy (loaded from CSV)
    taxonomy: [],
    attributeConfig: {},
    examType: '',

    // Progress
    validatedCount: 0,
    totalCount: 0,
    validatedIds: new Set(),

    // Preferences
    autoAdvance: true,
    showSentenceBoundaries: false,

    // Search state
    searchQuery: '',
    searchResults: [],
    autocompleteIndex: -1,

    // Upload state
    uploadData: null,
    uploadFields: [],
    uploadIdCol: '',
    uploadTextCol: '',
    uploadValidation: null,
    // Set after row-level validation on confirmUpload. Each entry is
    // { id, errors: [{msg, fix}] }. When non-empty, the user must
    // explicitly choose to proceed (importing only valid rows) or cancel.
    uploadInvalidRows: [],
    // The valid rows pre-built and waiting for the user's choice.
    // Only populated when uploadInvalidRows.length > 0.
    _pendingValidReports: null,

    // Extraction import state
    extractionData: null,
    extractionFields: [],
    extractionColumnMap: {},
    extractionStep: 1,
    extractionFindings: [],
    extractionErrors: [],
    // Validation summary populated after the user clicks "Check My Data"
    // in Step 1. Shape: { counts:{...}, invalid:[...], valid:[...], customAttributes:Set }.
    // Null until validation has run.
    extractionValidationSummary: null,
    extractionMatchCategories: { matched: {}, fuzzy: {}, unmatched: [] },
    fuzzyAccepted: new Set(),
    extractionReportsWithExisting: [],
    extractionReportsWithValidated: [],

    // Stats (populated on demand)
    _stats: null,

    // Dirty tracking
    hasUnsavedChanges: false,

    // Toast
    toastMessage: '',
    toastType: 'info',
    toastVisible: false,
    _toastTimerId: null,
    _autoAdvanceTimerId: null,

    async init() {
      // Load preferences
      this.autoAdvance = localStorage.getItem('autoAdvance') !== 'false';

      // Load taxonomy from IndexedDB if persisted; otherwise leave empty
      // until the user uploads one on the welcome screen.
      const stored = await Storage.loadTaxonomy();
      if (stored) {
        this.taxonomy = stored.findings;
        this.examType = stored.examType;
      }

      // Load attributes
      try {
        this.attributeConfig = await fetch('data/attributes.json').then(r => { if (!r.ok) throw new Error('attributes'); return r.json(); });
      } catch (e) {
        this.showToast('Failed to load application data. Check your connection and refresh.', 'error');
        return;
      }

      // Migrate existing data to current schema BEFORE any view loads
      await this._runMigrationIfNeeded();

      // Check for existing data in IndexedDB
      const count = await Storage.getReportCount();
      if (count > 0) {
        await this._loadSession();
      }

      // Listen for browser back/forward
      window.addEventListener('popstate', (e) => {
        if (e.state && typeof e.state.idx === 'number') {
          this.navigateTo(e.state.idx, true);
        }
      });
    },

    async _loadSession() {
      this.recordIds = await Storage.listReportIds();
      this.totalCount = this.recordIds.length;
      const validatedIds = await Storage.getValidatedIds();
      this.validatedIds = new Set(validatedIds);
      this.validatedCount = validatedIds.length;
      if (this.recordIds.length > 0) {
        // Check URL for initial position
        const params = new URLSearchParams(window.location.search);
        const urlIdx = parseInt(params.get('idx'), 10);
        const startIdx = (!isNaN(urlIdx) && urlIdx >= 0 && urlIdx < this.recordIds.length) ? urlIdx : 0;
        await this.navigateTo(startIdx);
        this.currentView = 'annotate';

        // Restore sentence from URL
        const urlSentence = parseInt(params.get('sentence'), 10);
        if (!isNaN(urlSentence) && urlSentence > 0) {
          this.selectSentence(urlSentence);
        }
      }
    },

    async _runMigrationIfNeeded() {
      const all = await Storage.exportAllReports();
      const stale = all.filter(r => r.schema_version !== SCHEMA_VERSION);
      if (!stale.length) return;

      const taxMeta = await Storage.loadTaxonomy();
      const taxonomyVersion = taxMeta ? `${taxMeta.examType}:${taxMeta.loadedAt}` : '';

      // Pass 1: rebuild sentences for every stale report so that pass 2
      // can use the new sentence text for cross-report matching diagnostics.
      const rebuilt = stale.map(r => {
        const ft = Sentences.parseFindingsSection(r.report_text || '');
        const { sentences, sectionBreaks } = Sentences.splitIntoSentences(ft);
        return { ...r, sentences, sectionBreaks };
      });

      // Pass 2: remap findings on each report against the new sentences.
      let remapped = 0, needsReview = 0;
      for (const report of rebuilt) {
        for (const arr of [report.llm_extractions || [], report.validated_findings || []]) {
          for (const f of arr) {
            if (!f.source_text) {
              f.source_sentence_idx = null;
              continue;
            }
            const r = Sentences.matchSourceToSentence(f.source_text, report.sentences, report.record_id, rebuilt);
            if (r.idx) {
              f.source_sentence_idx = r.idx;
              delete f._needsReview;
              remapped++;
            } else {
              f.source_sentence_idx = null;
              f._needsReview = true;
              needsReview++;
            }
          }
        }
        report.taxonomyVersion = taxonomyVersion;
        report.schema_version = SCHEMA_VERSION;
      }

      await Storage.importReports(rebuilt);
      const tone = needsReview > 0 ? 'info' : 'success';
      const detail = needsReview
        ? ` ${remapped} findings remapped; ${needsReview} need review (look for the amber badge in finding cards)`
        : ` ${remapped} findings remapped`;
      this.showToast(`Updated ${stale.length} reports to new sentence splitter.${detail}`, tone);
    },

    // --- Navigation ---

    async navigateTo(idx, fromPopstate) {
      if (idx < 0 || idx >= this.recordIds.length) return;
      if (this._autoAdvanceTimerId) {
        clearTimeout(this._autoAdvanceTimerId);
        this._autoAdvanceTimerId = null;
      }
      this.currentIdx = idx;
      const recordId = this.recordIds[idx];
      this.report = await Storage.loadReport(recordId);
      this.selectedSentenceIdx = null;
      this.searchQuery = '';
      this.searchResults = [];

      // Update URL
      if (!fromPopstate) {
        const url = '?idx=' + idx;
        history.pushState({ idx }, '', url);
      }

      // Auto-select first sentence if any
      if (this.report && this.report.sentences && this.report.sentences.length > 0) {
        this.selectSentence(1);
      }
    },

    async navigatePrev() {
      if (this.currentIdx > 0) await this.navigateTo(this.currentIdx - 1);
    },

    async navigateNext() {
      if (this.currentIdx < this.recordIds.length - 1) await this.navigateTo(this.currentIdx + 1);
    },

    async goToNextUnvalidated() {
      const n = this.recordIds.length;
      for (let offset = 1; offset < n; offset++) {
        const checkIdx = (this.currentIdx + offset) % n;
        if (!this.validatedIds.has(this.recordIds[checkIdx])) {
          if (checkIdx < this.currentIdx) {
            this.showToast('Wrapped around to report ' + (checkIdx + 1), 'info');
          }
          await this.navigateTo(checkIdx);
          return;
        }
      }
      this.showToast('All reports validated!', 'success');
    },

    async jumpToReport(num) {
      const idx = Math.max(0, Math.min(num - 1, this.recordIds.length - 1));
      await this.navigateTo(idx);
    },

    // --- Sentence selection ---

    selectSentence(idx) {
      this.selectedSentenceIdx = idx;
      this.searchQuery = '';
      this.searchResults = [];
      this.autocompleteIndex = -1;

      // Update URL with sentence param
      const url = '?idx=' + this.currentIdx + '&sentence=' + idx;
      history.replaceState({ idx: this.currentIdx }, '', url);

      // Scroll selected sentence into view. Do NOT auto-focus the finding
      // search input — focusing an input traps J/K keystrokes there and
      // breaks sentence navigation. Press F to focus search explicitly.
      requestAnimationFrame(() => {
        document.querySelector('[data-sentence-idx="' + idx + '"]')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });
    },

    // --- Finding groups (computed) ---

    get pendingFindings() {
      if (!this.report || !this.selectedSentenceIdx) return [];
      return (this.report.llm_extractions || [])
        .map((f, i) => ({ ...f, _globalIdx: i }))
        .filter(f => f.source_sentence_idx === this.selectedSentenceIdx);
    },

    get validatedFindings() {
      if (!this.report || !this.selectedSentenceIdx) return [];
      return (this.report.validated_findings || [])
        .map((f, i) => ({ ...f, _globalIdx: i }))
        .filter(f => f.source_sentence_idx === this.selectedSentenceIdx);
    },

    get unassignedFindings() {
      if (!this.report) return [];
      return (this.report.llm_extractions || [])
        .map((f, i) => ({ ...f, _globalIdx: i }))
        .filter(f => !f.source_sentence_idx);
    },

    get allValidatedFindings() {
      if (!this.report) return [];
      return this.report.validated_findings || [];
    },

    // Sentence finding counts for highlights
    sentenceFindingCounts(sentenceIdx) {
      if (!this.report) return { validated: 0, pending: 0 };
      const validated = (this.report.validated_findings || [])
        .filter(f => f.source_sentence_idx === sentenceIdx).length;
      const pending = (this.report.llm_extractions || [])
        .filter(f => f.source_sentence_idx === sentenceIdx).length;
      return { validated, pending };
    },

    // --- Finding operations ---

    async acceptFinding(extractionIdx) {
      if (!this.report) return;
      const extraction = this.report.llm_extractions[extractionIdx];
      if (!extraction) return;

      const sentenceIdx = this.selectedSentenceIdx || extraction.source_sentence_idx;
      if (!sentenceIdx) {
        this.showToast('Cannot accept: no sentence linkage. Select a sentence first or fix the extraction.', 'error');
        return;
      }

      const taxMatch = Taxonomy.matchFindingToTaxonomy(extraction.finding_name, this.taxonomy);
      const validated = {
        finding_name: taxMatch ? taxMatch.name : extraction.finding_name,
        taxonomy_id: taxMatch ? taxMatch.id : null,
        source_sentence_idx: sentenceIdx,
        source_text: extraction.source_text || '',
        _needsReview: extraction._needsReview || false,
        is_custom: !taxMatch,
        origin: 'llm',
        was_modified: false,
        attributes: { ...extraction.attributes },
      };

      this.report.validated_findings.push(validated);
      this.report.llm_extractions.splice(extractionIdx, 1);
      await this._saveCurrentReport();
    },

    async rejectFinding(extractionIdx) {
      if (!this.report) return;
      this.report.llm_extractions.splice(extractionIdx, 1);
      await this._saveCurrentReport();
    },

    async addFinding(findingName, isCustom) {
      if (!this.report || !findingName) return;

      const taxMatch = isCustom ? null : Taxonomy.matchFindingToTaxonomy(findingName, this.taxonomy);

      // Hard rule: a human-added finding is either a taxonomy match OR
      // explicitly marked custom — never an undecided in-between. If we
      // got here without isCustom and without a taxonomy match, the UI
      // surfaces an actionable message and refuses to save.
      if (!taxMatch && !isCustom) {
        this.showToast(
          `"${findingName}" doesn't match the taxonomy. → Pick a result from the search list, or use the Custom option to add it as a custom finding.`,
          'error'
        );
        return;
      }

      const sentenceText = this.selectedSentenceIdx
        ? (this.report.sentences?.[this.selectedSentenceIdx - 1] || '')
        : '';

      const validated = {
        finding_name: taxMatch ? taxMatch.name : findingName,
        taxonomy_id: taxMatch ? taxMatch.id : null,
        source_sentence_idx: this.selectedSentenceIdx,
        source_text: sentenceText,
        _needsReview: false,
        is_custom: !taxMatch,
        origin: 'human_added',
        was_modified: false,
        attributes: { presence: 'present' },
      };

      this.report.validated_findings.push(validated);
      await this._saveCurrentReport();
      this.showToast('Added: ' + validated.finding_name, 'success');
      this.searchQuery = '';
      this.searchResults = [];
    },


    async deleteFinding(validatedIdx) {
      if (!this.report) return;
      this.report.validated_findings.splice(validatedIdx, 1);
      await this._saveCurrentReport();
    },

    async updatePresence(validatedIdx, value) {
      if (!this.report) return;
      const finding = this.report.validated_findings[validatedIdx];
      if (!finding) return;
      if (!finding.attributes) finding.attributes = {};
      finding.attributes.presence = value;
      if (finding.origin === 'llm') finding.was_modified = true;
      await this._saveCurrentReport();
    },

    async updateAttribute(validatedIdx, attrName, value) {
      if (!this.report) return;
      const finding = this.report.validated_findings[validatedIdx];
      if (!finding) return;
      if (!finding.attributes) finding.attributes = {};

      if (value === '' || value === null) {
        delete finding.attributes[attrName];
      } else {
        // Handle array type
        const config = this.attributeConfig[attrName];
        if (config && config.type === 'array') {
          finding.attributes[attrName] = value.split(',').map(v => v.trim()).filter(Boolean);
        } else {
          finding.attributes[attrName] = value;
        }
      }
      if (finding.origin === 'llm') finding.was_modified = true;
      await this._saveCurrentReport();
    },

    async removeAttribute(validatedIdx, attrName) {
      await this.updateAttribute(validatedIdx, attrName, '');
    },

    // --- Validation ---

    async toggleValidation() {
      if (!this.report) return;

      // Guard: every validated finding must carry a presence value before
      // the report can be marked validated. This is one of the user-input
      // boundaries the integrity mandate covers — we surface and block,
      // never silently accept partial findings.
      if (!this.report.validated) {
        const missing = (this.report.validated_findings || []).filter(f => !f.attributes?.presence);
        if (missing.length) {
          this.showToast(
            `${missing.length} finding(s) missing presence value. → Set presence (present / absent / indeterminate) on each before validating.`,
            'error'
          );
          return;
        }
      }

      const wasValidated = this.report.validated;
      this.report.validated = !this.report.validated;
      this.report.validated_at = this.report.validated ? new Date().toISOString() : null;
      await this._saveCurrentReport();

      if (this.report.validated) {
        this.validatedIds.add(this.report.record_id);
        this.validatedIds = new Set(this.validatedIds);
        this.validatedCount = this.validatedIds.size;
        if (!wasValidated && this.autoAdvance) {
          this._autoAdvanceTimerId = setTimeout(() => {
            this._autoAdvanceTimerId = null;
            this.goToNextUnvalidated();
          }, 300);
        }
      } else {
        this.validatedIds.delete(this.report.record_id);
        this.validatedIds = new Set(this.validatedIds);
        this.validatedCount = this.validatedIds.size;
      }
    },

    // --- Search ---

    updateSearch(query) {
      this.searchQuery = query;
      this.autocompleteIndex = -1;
      if (!query) {
        this.searchResults = [];
        return;
      }
      this.searchResults = Taxonomy.searchFindings(query, this.taxonomy).slice(0, 20);
    },

    selectSearchResult(finding) {
      this.addFinding(finding.name, false);
    },

    addCustomFinding(name) {
      if (name) this.addFinding(name, true);
    },

    // --- CSV Upload ---

    async handleReportsCsvUpload(file) {
      if (!file) return;
      if (file.size > MAX_CSV_SIZE) {
        this.showToast('CSV file exceeds 10 MB limit', 'error');
        return;
      }
      let result;
      try {
        result = await CsvImport.parseFile(file);
      } catch (e) {
        this.showToast('Could not parse CSV file', 'error');
        return;
      }
      this.uploadData = result.data;
      this.uploadFields = result.fields;
      const detected = CsvImport.detectColumns(result.fields);
      this.uploadIdCol = detected.idCol || '';
      this.uploadTextCol = detected.textCol || '';
      this.uploadValidation = null;
      this.currentView = 'upload-mapping';
    },

    validateUploadMapping() {
      this.uploadValidation = CsvImport.validateMapping(
        this.uploadData, this.uploadIdCol, this.uploadTextCol
      );
      return this.uploadValidation.valid;
    },

    async confirmUpload() {
      if (!this.uploadIdCol || !this.uploadTextCol) {
        this.showToast('Please select both ID and text columns', 'error');
        return;
      }
      if (!this.validateUploadMapping()) {
        this.showToast('Please fix validation errors before importing', 'error');
        return;
      }

      // Stamp taxonomyVersion + schema_version at ingest so new reports
      // skip the migration path on next load.
      const taxMeta = await Storage.loadTaxonomy();
      const taxonomyVersion = taxMeta ? `${taxMeta.examType}:${taxMeta.loadedAt}` : '';

      // Build valid reports AND collect any rows that fail per-row checks.
      // Nothing is written to IndexedDB until the user confirms.
      const reports = [];
      const invalidRows = [];
      for (const row of this.uploadData) {
        const id = CsvImport.Norm.cell(row[this.uploadIdCol]);
        const text = CsvImport.Norm.cell(row[this.uploadTextCol]);
        if (!id || !text) continue;

        const findingsText = Sentences.parseFindingsSection(text);
        const { sentences, sectionBreaks } = Sentences.splitIntoSentences(findingsText);

        const rowErrors = [];
        if (text.includes('�')) rowErrors.push({
          msg: 'encoding error: unrecognized characters detected',
          fix: 'Re-save the source CSV as UTF-8 and re-upload.',
        });
        if (!findingsText || findingsText.trim().length < 10) rowErrors.push({
          msg: 'no parseable FINDINGS section',
          fix: 'Reports must contain a "FINDINGS:" header followed by content. Check the report text.',
        });
        if (sentences.length === 0) rowErrors.push({
          msg: 'zero sentences extracted from FINDINGS',
          fix: 'The FINDINGS section appears empty after parsing. Confirm the report has content under FINDINGS.',
        });
        if (rowErrors.length) {
          invalidRows.push({ id, errors: rowErrors });
          continue;
        }

        reports.push({
          record_id: id,
          report_text: text,
          sentences,
          sectionBreaks,
          llm_extractions: [],
          validated_findings: [],
          validated: false,
          validated_at: null,
          custom_findings_added: [],
          extraction_model: null,
          extraction_timestamp: null,
          taxonomyVersion,
          schema_version: SCHEMA_VERSION,
        });
      }

      if (invalidRows.length > 0) {
        // Halt — user must explicitly accept skipping invalid rows.
        this.uploadInvalidRows = invalidRows;
        this._pendingValidReports = reports;
        this.showToast(`${invalidRows.length} report(s) need attention before import — see panel below`, 'info');
        return;
      }

      await this._writeReportsAndStartSession(reports);
    },

    async confirmUploadProceedAfterReview() {
      const reports = this._pendingValidReports || [];
      this._pendingValidReports = null;
      this.uploadInvalidRows = [];
      if (!reports.length) {
        this.showToast('No valid reports to import.', 'error');
        return;
      }
      await this._writeReportsAndStartSession(reports);
    },

    cancelUploadAfterReview() {
      this._pendingValidReports = null;
      this.uploadInvalidRows = [];
    },

    async _writeReportsAndStartSession(reports) {
      await Storage.atomicReplace(reports);
      await this._loadSession();
      this.uploadData = null;
      this.uploadFields = [];
      this.uploadValidation = null;
      this.showToast(`Loaded ${this.totalCount} reports`, 'success');
    },

    // --- Extraction Import ---

    async handleExtractionCsvUpload(file) {
      if (!file) return;
      if (file.size > MAX_CSV_SIZE) {
        this.showToast('CSV file exceeds 10 MB limit', 'error');
        return;
      }
      let result;
      try {
        result = await CsvImport.parseFile(file);
      } catch (e) {
        this.showToast('Could not parse CSV file', 'error');
        return;
      }
      this.extractionData = result.data;
      this.extractionFields = result.fields;
      this.extractionStep = 1;
      // Reset any prior validation state so the user starts clean.
      this.extractionValidationSummary = null;

      // Auto-detect columns (matching old app's _COLUMN_GUESSES)
      const KNOWN_KEYWORDS = {
        laterality: ['laterality', 'lateral', 'side'],
        temporal_status: ['temporal_status', 'temporal', 'change', 'comparison'],
        chronicity: ['chronicity', 'chronic', 'acuity', 'duration'],
        size: ['size', 'measurement', 'dimension'],
        severity: ['severity', 'degree', 'grade'],
        anatomic_site: ['anatomic_site', 'site', 'location', 'anatomy'],
        features: ['features', 'feature', 'descriptor'],
      };
      const guessMap = {
        record_id: ['record_id', 'id', 'record', 'accession', 'case'],
        finding_name: ['finding_name', 'finding', 'name', 'diagnosis', 'observation'],
        presence: ['presence', 'status'],
        source_text: ['source_text', 'source', 'text', 'sentence', 'context'],
        sentence_idx: ['sentence_idx', 'sentence_index'],
      };
      for (const key of Object.keys(this.attributeConfig)) {
        if (key === 'presence') continue; // already mapped above
        guessMap[key] = KNOWN_KEYWORDS[key] || [key, key.replace(/_/g, ' ')];
      }
      const map = {};
      const claimed = new Set();
      // Pass 1: exact matches only (field name === keyword)
      for (const [target, keywords] of Object.entries(guessMap)) {
        for (const f of result.fields) {
          const fl = f.toLowerCase();
          if (!claimed.has(f) && keywords.some(kw => fl === kw)) {
            map[target] = f;
            claimed.add(f);
            break;
          }
        }
      }
      // Pass 2: substring matches for any targets still unmapped
      for (const [target, keywords] of Object.entries(guessMap)) {
        if (map[target]) continue;
        for (const f of result.fields) {
          const fl = f.toLowerCase();
          if (!claimed.has(f) && keywords.some(kw => fl.includes(kw))) {
            map[target] = f;
            claimed.add(f);
            break;
          }
        }
      }
      // Set view first so x-for renders options, then set map so x-model binds
      this.extractionColumnMap = {};
      this.currentView = 'import-extractions';
      requestAnimationFrame(() => { this.extractionColumnMap = map; });
    },

    /**
     * Step 1 button: parses the CSV, runs aggressive validation, and
     * populates extractionValidationSummary. Does NOT advance to Step 2.
     * The UI surfaces counts and per-row issues; the user clicks
     * "Review Matches" once they're satisfied with what will be imported.
     */
    async runExtractionValidation() {
      // Parse + normalize. The validIds-set check inside parse is a coarse
      // filter; the per-row matcher in validateExtractionRows is authoritative.
      const validIds = new Set(this.recordIds);
      const { findings, errors } = CsvImport.parseExtractionCsv(
        this.extractionData, this.extractionColumnMap, validIds
      );

      // Build the reports map once; the validator needs report.sentences for matching.
      const allReports = await Storage.exportAllReports();
      const reportsById = Object.fromEntries(allReports.map(r => [r.record_id, r]));

      const summary = CsvImport.validateExtractionRows(
        findings,
        reportsById,
        this.attributeConfig,
        this.extractionColumnMap,
        this.extractionFields,
        Sentences
      );

      this.extractionFindings = summary.valid;
      this.extractionErrors = errors;
      this.extractionValidationSummary = summary;
    },

    /**
     * Step 1 -> Step 2 transition. Runs taxonomy matching on the validated
     * findings only, then advances. Disabled in the UI until validation
     * has been run and at least one row is ready.
     */
    async processExtractionImport() {
      if (!this.extractionValidationSummary) {
        // Defensive: button shouldn't be clickable without validation run.
        await this.runExtractionValidation();
      }
      const findings = this.extractionFindings;
      if (!findings.length) {
        this.showToast('No valid rows to import. Check the validation panel above.', 'error');
        return;
      }

      // Taxonomy matching on unique finding names (3 categories)
      const uniqueNames = [...new Set(findings.map(f => f.finding_name))].sort();
      const matched = {};   // name → { name, id }
      const fuzzy = {};     // name → { name, id, score }
      const unmatched = []; // names with no match

      for (const name of uniqueNames) {
        // Try exact name + synonym match (no fuzzy)
        const exactResult = this._findByExactOrSynonym(name);
        if (exactResult) {
          matched[name] = { name: exactResult.name, id: exactResult.id };
        } else {
          const fuzzyResult = Taxonomy.fuzzyMatchFinding(name, this.taxonomy, 0.3);
          if (fuzzyResult) {
            fuzzy[name] = { name: fuzzyResult.finding.name, id: fuzzyResult.finding.id, score: fuzzyResult.score };
          } else {
            unmatched.push(name);
          }
        }
      }

      this.extractionMatchCategories = { matched, fuzzy, unmatched };

      // Pre-accept fuzzy matches scoring >= 0.7
      this.fuzzyAccepted = new Set(
        Object.entries(fuzzy).filter(([, v]) => v.score >= 0.7).map(([k]) => k)
      );

      // Check for reports with existing extractions or validated findings
      const affectedIds = [...new Set(findings.map(f => f.record_id))];
      this.extractionReportsWithExisting = [];
      this.extractionReportsWithValidated = [];
      for (const rid of affectedIds) {
        const report = await Storage.loadReport(rid);
        if (report && report.llm_extractions && report.llm_extractions.length > 0) {
          this.extractionReportsWithExisting.push(rid);
        }
        if (report && report.validated_findings && report.validated_findings.length > 0) {
          this.extractionReportsWithValidated.push(rid);
        }
      }

      this.extractionStep = 2;
    },

    /**
     * Download a CSV of every invalid extraction row with a `_validation_error`
     * column appended (msg + fix per error, joined by newlines). Lets the
     * user fix issues upstream and re-upload.
     */
    downloadExtractionErrorCsv() {
      const summary = this.extractionValidationSummary;
      if (!summary || !summary.invalid?.length) {
        this.showToast('No invalid rows to export.', 'info');
        return;
      }
      const rows = summary.invalid.map(f => {
        const flat = {
          record_id: f.record_id || '',
          finding_name: f.finding_name || '',
          source_text: f.source_text || '',
        };
        for (const [k, v] of Object.entries(f.attributes || {})) {
          flat[k] = Array.isArray(v) ? v.join(', ') : v;
        }
        flat._validation_error = (f._validation_errors || [])
          .map(e => `${e.msg} → ${e.fix}`)
          .join('\n');
        return flat;
      });
      const csv = Papa.unparse(rows);
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `extraction-errors-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    },

    // Helper: find by exact name or synonym (no fuzzy).
    _findByExactOrSynonym(findingName) {
      const normalized = Taxonomy.normalizeName(findingName);
      const withSpaces = normalized.replace(/_/g, ' ');

      // Level 1: Direct canonical name match
      for (const f of this.taxonomy) {
        if (f.name.toLowerCase() === withSpaces) return f;
      }
      // Level 2: Synonym match
      for (const f of this.taxonomy) {
        for (const syn of f.synonyms) {
          if (syn.toLowerCase() === withSpaces) return f;
        }
      }
      return null;
    },

    toggleFuzzyAccept(name) {
      if (this.fuzzyAccepted.has(name)) {
        this.fuzzyAccepted.delete(name);
      } else {
        this.fuzzyAccepted.add(name);
      }
      // Force reactivity
      this.fuzzyAccepted = new Set(this.fuzzyAccepted);
    },

    async confirmExtractionImport() {
      const { matched, fuzzy } = this.extractionMatchCategories;

      // Group findings by record_id
      const byRecord = {};
      for (const f of this.extractionFindings) {
        if (!byRecord[f.record_id]) byRecord[f.record_id] = [];
        byRecord[f.record_id].push(f);
      }

      // Hoist all reports once for cross-report matching diagnostics
      const allReports = await Storage.exportAllReports();

      // Defensive backstop: if Phase 5 validation was bypassed, this formatter
      // produces a human-readable string for the runtime _matchError annotation.
      const formatMatchError = (r, recordId) => {
        if (r.error === 'not_in_report') {
          return r.alsoMatchesIn?.length
            ? `not in ${recordId}; matches ${r.alsoMatchesIn.join(', ')}`
            : `not in ${recordId}`;
        }
        return `ambiguous: sentences ${r.matches?.join(', ')}`;
      };

      // Stable merge key for matching new extraction rows against existing
      // validated findings. Uses normalized source_text + canonical finding
      // name — both fields are stable across sentence-index recomputation,
      // unlike (source_sentence_idx, finding_name) which shifts when the
      // splitter changes.
      const mergeKey = (sourceText, findingName) => Sentences.mergeKey(sourceText, findingName);

      let imported = 0;
      let preserved = 0;
      let mergedAttrs = 0;
      let addedPending = 0;
      for (const [recordId, findings] of Object.entries(byRecord)) {
        const report = await Storage.loadReport(recordId);
        if (!report) continue;

        const existingValidated = report.validated_findings || [];
        const validatedByKey = new Map();
        for (const vf of existingValidated) {
          validatedByKey.set(mergeKey(vf.source_text, vf.finding_name), vf);
        }

        const newExtractions = [];
        const consumedValidatedKeys = new Set();
        for (const f of findings) {
          let finalName = f.finding_name;

          // Resolve name from match categories
          if (matched[f.finding_name]) {
            finalName = matched[f.finding_name].name;
          } else if (fuzzy[f.finding_name] && this.fuzzyAccepted.has(f.finding_name)) {
            finalName = fuzzy[f.finding_name].name;
          }

          // Resolve source_text → sentence index via deterministic matcher
          let sentenceIdx = null;
          let matchError = null;
          if (f.source_text && report.sentences) {
            const r = Sentences.matchSourceToSentence(f.source_text, report.sentences, recordId, allReports);
            if (r.idx) sentenceIdx = r.idx;
            else matchError = formatMatchError(r, recordId);
          }

          // Try to merge onto an existing validated finding before falling
          // back to pending. Annotator edits are preserved: we only fill
          // attributes that aren't already set.
          const key = mergeKey(f.source_text, finalName);
          const existing = validatedByKey.get(key);
          if (existing && !consumedValidatedKeys.has(key)) {
            consumedValidatedKeys.add(key);
            let changed = false;
            if (sentenceIdx && existing.source_sentence_idx !== sentenceIdx) {
              existing.source_sentence_idx = sentenceIdx;
              changed = true;
            }
            if (f.source_text && existing.source_text !== f.source_text) {
              existing.source_text = f.source_text;
              changed = true;
            }
            const incomingAttrs = f.attributes || {};
            existing.attributes = existing.attributes || {};
            for (const [k, v] of Object.entries(incomingAttrs)) {
              const cur = existing.attributes[k];
              const isEmpty = cur == null || cur === '' || (Array.isArray(cur) && cur.length === 0);
              if (isEmpty && v != null && v !== '') {
                existing.attributes[k] = v;
                changed = true;
              }
            }
            if (changed) {
              existing.was_modified = true;
              mergedAttrs++;
            }
            preserved++;
            imported++;
            continue;
          }

          const ext = {
            finding_name: finalName,
            source_sentence_idx: sentenceIdx,
            source_text: f.source_text || '',
            attributes: f.attributes || { presence: 'indeterminate' },
          };
          if (matchError) ext._matchError = matchError;
          newExtractions.push(ext);
          addedPending++;
          imported++;
        }

        // Existing validated findings that weren't matched by this re-import
        // are kept as-is (re-import doesn't delete annotator work).
        report.validated_findings = existingValidated;

        // Pending extractions get fully replaced: any unreviewed pending rows
        // from a previous import are superseded by this import.
        report.llm_extractions = newExtractions;

        // Validated status now depends on whether there's any unreviewed
        // pending work. If new rows were added (or were already pending),
        // the report drops out of validated state.
        const hasPending = newExtractions.length > 0;
        if (hasPending && report.validated) {
          report.validated = false;
          report.validated_at = null;
        }
        report.extraction_model = 'external_import';
        report.extraction_timestamp = new Date().toISOString();
        // Strip Alpine reactive proxies before IndexedDB storage
        await Storage.saveReport(JSON.parse(JSON.stringify(report)));
      }

      await this._loadSession();
      this.extractionData = null;
      this.extractionFields = [];
      this.extractionFindings = [];
      this.extractionErrors = [];
      this.extractionValidationSummary = null;
      this.extractionMatchCategories = { matched: {}, fuzzy: {}, unmatched: [] };
      this.fuzzyAccepted = new Set();
      this.extractionReportsWithExisting = [];
      this.extractionReportsWithValidated = [];

      // Single outcome toast: surface the merge breakdown so the annotator
      // knows what happened to their prior work — silent merge would feel
      // like data loss even when it isn't.
      const breakdown = [];
      if (preserved > 0) breakdown.push(`${preserved} validated preserved`);
      if (mergedAttrs > 0) breakdown.push(`${mergedAttrs} attribute merge${mergedAttrs === 1 ? '' : 's'}`);
      if (addedPending > 0) breakdown.push(`${addedPending} new pending`);
      const detail = breakdown.length ? ` (${breakdown.join(', ')})` : '';
      this.showToast(`Imported ${imported} findings into ${Object.keys(byRecord).length} reports${detail}`, 'success');
    },

    // --- Session Export/Import ---

    async exportSession() {
      const reports = await Storage.exportAllReports();

      const session = {
        version: 1,
        created_at: new Date().toISOString(),
        reports,
      };
      this._downloadJson(session, `annotation-session-${new Date().toISOString().slice(0, 10)}.json`);
      this.hasUnsavedChanges = false;
    },

    async restoreSession(file) {
      if (!file) return;
      if (file.size > MAX_SESSION_SIZE) {
        this.showToast('Session file exceeds 50 MB limit', 'error');
        return;
      }
      const text = await file.text();
      let session;
      try {
        session = JSON.parse(text);
      } catch {
        this.showToast('Invalid JSON file', 'error');
        return;
      }

      if (!session.reports || !session.version) {
        this.showToast('Invalid session format', 'error');
        return;
      }

      // Accept both formats: array (old client-side) or object keyed by record_id (old server app)
      let reportsArray;
      if (Array.isArray(session.reports)) {
        reportsArray = session.reports;
      } else if (typeof session.reports === 'object') {
        reportsArray = Object.values(session.reports);
      } else {
        this.showToast('Invalid session format', 'error');
        return;
      }

      // Filter out reports without a valid record_id
      const validReports = reportsArray.filter(r => r && r.record_id);
      const skipped = reportsArray.length - validReports.length;
      if (validReports.length === 0) {
        this.showToast('No valid reports found in session file', 'error');
        return;
      }

      // Re-parse sentences for reports from older sessions that may lack them
      for (const report of validReports) {
        if (!report.sentences || !Array.isArray(report.sentences) || report.sentences.length === 0) {
          if (report.report_text) {
            const findingsText = Sentences.parseFindingsSection(report.report_text);
            const { sentences, sectionBreaks } = Sentences.splitIntoSentences(findingsText);
            report.sentences = sentences;
            report.sectionBreaks = sectionBreaks;
          } else {
            report.sentences = [];
            report.sectionBreaks = [];
          }
        }
        // Backfill sectionBreaks for old sessions that have sentences but no sectionBreaks
        if (!report.sectionBreaks) {
          report.sectionBreaks = [];
        }
      }

      // Atomic clear+import in a single transaction
      try {
        await Storage.atomicReplace(validReports);
      } catch (e) {
        this.showToast('Failed to restore session: ' + (e.message || 'unknown error'), 'error');
        return;
      }

      // Restored data may predate the current schema (older sentence
      // indices, missing sectionBreaks, etc.). Run the same migration
      // path init uses so the session is current before it loads.
      await this._runMigrationIfNeeded();

      await this._loadSession();
      let msg = `Restored ${validReports.length} reports`;
      if (skipped > 0) msg += ` (${skipped} invalid entries skipped)`;
      this.showToast(msg, 'success');
    },

    async exportCurrentReportJson() {
      if (!this.report) return;
      const safeId = this.report.record_id.replace(/[^a-zA-Z0-9._-]/g, '_');
      this._downloadJson(this.report, `${safeId}.json`);
    },

    async exportCurrentReportCsv() {
      if (!this.report) return;
      const rows = this._buildFindingRows(this.report);
      if (rows.length === 0) {
        this.showToast('No findings to export', 'info');
        return;
      }
      const csv = Papa.unparse(rows);
      const safeId = this.report.record_id.replace(/[^a-zA-Z0-9._-]/g, '_');
      this._downloadBlob(csv, `${safeId}-findings.csv`, 'text/csv');
    },

    async exportAllJson() {
      const reports = await Storage.exportAllReports();
      this._downloadJson(reports, 'all-reports.json');
    },

    /**
     * Training-data export. Stable schema: every export has the same
     * canonical columns regardless of corpus, with custom attributes
     * collapsed into a `custom_attributes` JSON column. See
     * _buildFindingRows for the full column list.
     */
    async exportTrainingData() {
      const reports = await Storage.exportAllReports();
      const rows = [];
      for (const report of reports) {
        rows.push(...this._buildFindingRows(report));
      }

      if (rows.length === 0) {
        this.showToast('No findings to export', 'info');
        return;
      }

      const csv = Papa.unparse(rows);
      const date = new Date().toISOString().slice(0, 10);
      this._downloadBlob(csv, `training-data-${date}.csv`, 'text/csv');
    },

    // Back-compat alias kept for the existing UI button binding; the
    // canonical name is exportTrainingData. Remove this alias once the
    // last caller is migrated.
    async exportAllCsv() {
      return this.exportTrainingData();
    },

    // --- Taxonomy Viewer ---

    getTaxonomyTree() {
      const byId = {};
      const roots = [];
      for (const f of this.taxonomy) {
        byId[f.id] = { ...f, children: [] };
      }
      for (const f of this.taxonomy) {
        if (f.parent_id && byId[f.parent_id]) {
          byId[f.parent_id].children.push(byId[f.id]);
        } else {
          roots.push(byId[f.id]);
        }
      }
      // Group roots by category
      const byCategory = {};
      for (const node of roots) {
        const cat = node.category || 'other';
        if (!byCategory[cat]) byCategory[cat] = [];
        byCategory[cat].push(node);
      }
      return byCategory;
    },

    // --- Taxonomy Management ---

    _parseTaxonomyCsv(csvText) {
      const parsed = Papa.parse(csvText, { header: true, skipEmptyLines: true });
      return parsed.data.map(row => ({
        id: row.id,
        name: row.name,
        category: row.category,
        parent_id: row.parent_id || null,
        synonyms: row.synonyms ? row.synonyms.split(',').map(s => s.trim()).filter(Boolean) : [],
        finding_type: row.finding_type || null,
      })).filter(f => f.id && f.name);
    },

    _deriveExamType(filename) {
      return filename
        .replace(/\.csv$/i, '')
        .replace(/-findings-taxonomy$/i, '')
        .split('-')
        .map(s => s.toUpperCase() === s ? s : s.charAt(0).toUpperCase() + s.slice(1))
        .join(' ');
    },

    humanizeName(name) {
      if (!name) return '';
      return name.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());
    },

    async handleTaxonomyUpload(file) {
      if (!file) return;
      if (file.size > MAX_CSV_SIZE) {
        this.showToast('Taxonomy CSV exceeds 10 MB limit', 'error');
        return;
      }
      const text = await file.text();
      const findings = this._parseTaxonomyCsv(text);
      if (findings.length === 0) {
        this.showToast('No valid findings found in CSV. Expected columns: id, name, category, synonyms', 'error');
        return;
      }

      // Warn and clear session if reports are loaded
      const reportCount = await Storage.getReportCount();
      if (reportCount > 0) {
        if (!confirm(`Switching taxonomy will clear all ${reportCount} loaded reports and annotations. Export your session first if needed.\n\nContinue?`)) {
          return;
        }
        await this.clearAllData();
      }

      const examType = this._deriveExamType(file.name);
      this.taxonomy = findings;
      this.examType = examType;
      await Storage.saveTaxonomy(examType, file.name, findings, false);
      this.showToast(`Loaded ${findings.length} findings for ${examType}`, 'success');
    },

    // --- Annotation Stats ---

    async getAnnotationStats() {
      const reports = await Storage.exportAllReports();
      let totalFindings = 0, fromLlm = 0, humanAdded = 0, modified = 0, custom = 0;

      for (const report of reports) {
        for (const f of (report.validated_findings || [])) {
          totalFindings++;
          if (f.origin === 'llm') fromLlm++;
          if (f.origin === 'human_added') humanAdded++;
          if (f.was_modified) modified++;
          if (f.is_custom) custom++;
        }
      }

      return {
        total_reports: reports.length,
        validated_reports: reports.filter(r => r.validated).length,
        total_findings: totalFindings,
        findings_from_llm: fromLlm,
        findings_human_added: humanAdded,
        findings_modified: modified,
        findings_custom: custom,
        validation_progress: reports.length > 0
          ? (reports.filter(r => r.validated).length / reports.length)
          : 0,
      };
    },

    async showStats() {
      this._stats = await this.getAnnotationStats();
      window.dispatchEvent(new CustomEvent('open-stats'));
    },

    async exportStats() {
      const stats = await this.getAnnotationStats();
      this._downloadJson(stats, 'annotation-stats.json');
    },

    // --- Clear data ---

    async clearAllData() {
      await Storage.clearAllReports();
      this.recordIds = [];
      this.totalCount = 0;
      this.validatedCount = 0;
      this.validatedIds = new Set();
      this.report = null;
      this.currentView = 'welcome';
      this.hasUnsavedChanges = false;
    },

    // --- Internal helpers ---

    /**
     * Build the training-data export rows for a single report.
     *
     * Schema is STABLE across corpora — same columns in the same order,
     * regardless of what custom attributes the user uploaded. Non-canonical
     * attributes are serialized into a single `custom_attributes` JSON
     * column at the end so downstream consumers parse them only when
     * they care.
     *
     * Transient runtime annotations (_matchError, _needsReview,
     * _validation_errors, _globalIdx) are stripped — they're not part
     * of the export contract.
     */
    _buildFindingRows(report) {
      const rows = [];
      const sentences = report.sentences || [];
      const cfg = this.attributeConfig || {};
      const canonicalKeys = Object.keys(cfg);

      const makeRow = (f, status) => {
        const attrs = f.attributes || {};
        const idx = f.source_sentence_idx;
        const matchedSentenceText = (idx && idx > 0 && idx <= sentences.length)
          ? Sentences.splitSentenceHeader(sentences[idx - 1])[1]
          : '';

        // Compute section header for the matched sentence by walking
        // sectionBreaks (each entry: { before: sentencesLength, header })
        let section = '';
        if (idx && Array.isArray(report.sectionBreaks)) {
          for (const sb of report.sectionBreaks) {
            if (sb.before < idx) section = sb.header || '';
            else break;
          }
        }

        // Split attributes into canonical (one column each) and custom
        // (collapsed into a single JSON column).
        const customAttrs = {};
        for (const [k, v] of Object.entries(attrs)) {
          if (k === 'presence') continue;
          if (cfg[k]) continue;
          customAttrs[k] = v;
        }

        const row = {
          record_id: report.record_id,
          status,
          finding_name: f.finding_name,
          taxonomy_id: f.taxonomy_id || '',
          source_sentence_idx: idx || '',
          source_text: f.source_text || matchedSentenceText || '',
          matched_sentence_text: matchedSentenceText,
          section,
          origin: f.origin || '',
          was_modified: f.was_modified || false,
          is_custom: f.is_custom || false,
          taxonomy_version: report.taxonomyVersion || '',
        };
        for (const key of canonicalKeys) {
          const val = attrs[key];
          row[key] = Array.isArray(val) ? val.join('; ') : (val || '');
        }
        row.custom_attributes = Object.keys(customAttrs).length
          ? JSON.stringify(customAttrs)
          : '{}';
        row.report_validated = report.validated || false;
        row.report_validated_at = report.validated_at || '';
        return row;
      };

      for (const f of (report.validated_findings || [])) {
        rows.push(makeRow(f, 'validated'));
      }
      for (const f of (report.llm_extractions || [])) {
        rows.push(makeRow(f, 'pending'));
      }
      return rows;
    },

    async _saveCurrentReport() {
      if (!this.report) return;
      // Strip Alpine reactive proxies before IndexedDB storage
      const plain = JSON.parse(JSON.stringify(this.report));
      await Storage.saveReport(plain);
      this.hasUnsavedChanges = true;
    },

    _downloadJson(data, filename) {
      const json = JSON.stringify(data, null, 2);
      this._downloadBlob(json, filename, 'application/json');
    },

    _downloadBlob(content, filename, type) {
      const parts = type === 'text/csv' ? ['\uFEFF', content] : [content];
      const blob = new Blob(parts, { type });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },

    showToast(message, type = 'info') {
      this.toastMessage = message;
      this.toastType = type;
      this.toastVisible = true;
      if (this._toastTimerId) clearTimeout(this._toastTimerId);
      this._toastTimerId = setTimeout(() => { this.toastVisible = false; }, 3000);
    },

    // --- Attribute helpers ---

    getSetAttributes(finding) {
      const attrs = finding.attributes || {};
      return Object.entries(attrs)
        .filter(([k, v]) => k !== 'presence' && v !== null && v !== undefined && v !== '')
        .map(([k, v]) => ({ key: k, value: v }));
    },

    getAvailableAttributes(finding) {
      const attrs = finding.attributes || {};
      return Object.entries(this.attributeConfig)
        .filter(([k]) => k !== 'presence' && !attrs[k])
        .map(([k, config]) => ({ key: k, ...config }));
    },

    formatAttrValue(value) {
      if (Array.isArray(value)) return value.join(', ');
      return String(value);
    },
  });
});

// --- Keyboard shortcuts ---
// Keys are chosen for ergonomic positioning on a standard keyboard, not
// mapped to Vim or any other convention. u/i and j/k sit on the home row
// under the right hand, arrows supplement for discoverability.

document.addEventListener('keydown', (e) => {
  // Don't trigger when typing in inputs
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) {
    // Allow Escape in inputs
    if (e.key === 'Escape') {
      e.target.blur();
      return;
    }
    return;
  }

  const app = Alpine.store('app');
  if (!app || app.currentView !== 'annotate') return;

  switch (e.key) {
    case 'ArrowLeft':
    case 'u':
    case 'U':
      e.preventDefault();
      app.navigatePrev();
      break;
    case 'ArrowRight':
    case 'i':
    case 'I':
      e.preventDefault();
      app.navigateNext();
      break;
    case 'n':
    case 'N':
      e.preventDefault();
      app.goToNextUnvalidated();
      break;
    case 'a':
    case 'A':
      e.preventDefault();
      if (app.pendingFindings.length > 0) {
        app.acceptFinding(app.pendingFindings[0]._globalIdx);
      } else if (app.unassignedFindings.length > 0) {
        app.acceptFinding(app.unassignedFindings[0]._globalIdx);
      }
      break;
    case 'r':
    case 'R':
      e.preventDefault();
      if (app.pendingFindings.length > 0) {
        app.rejectFinding(app.pendingFindings[0]._globalIdx);
      } else if (app.unassignedFindings.length > 0) {
        app.rejectFinding(app.unassignedFindings[0]._globalIdx);
      }
      break;
    case 'd':
    case 'D':
      e.preventDefault();
      if (app.validatedFindings.length > 0) {
        const f = app.validatedFindings[0];
        const current = (f.attributes || {}).presence || 'present';
        const cycle = { present: 'absent', absent: 'indeterminate', indeterminate: 'present' };
        app.updatePresence(f._globalIdx, cycle[current] || 'present');
      }
      break;
    case 'f':
    case 'F':
      e.preventDefault();
      document.getElementById('finding-search-input')?.focus();
      break;
    case 'j':
    case 'J':
    case 'ArrowUp':
      e.preventDefault();
      if (app.selectedSentenceIdx === null) {
        if (app.report && app.report.sentences && app.report.sentences.length > 0) {
          app.selectSentence(app.report.sentences.length);
        }
      } else if (app.selectedSentenceIdx > 1) {
        app.selectSentence(app.selectedSentenceIdx - 1);
      }
      break;
    case 'k':
    case 'K':
    case 'ArrowDown':
      e.preventDefault();
      if (app.selectedSentenceIdx === null) {
        if (app.report && app.report.sentences && app.report.sentences.length > 0) {
          app.selectSentence(1);
        }
      } else if (app.report && app.selectedSentenceIdx < app.report.sentences.length) {
        app.selectSentence(app.selectedSentenceIdx + 1);
      }
      break;
    case '?':
      e.preventDefault();
      window.dispatchEvent(new CustomEvent('open-shortcuts'));
      break;
    case 'Escape':
      window.dispatchEvent(new CustomEvent('close-overlays'));
      break;
  }
});

// beforeunload warning
window.addEventListener('beforeunload', (e) => {
  const app = Alpine.store('app');
  if (app && app.hasUnsavedChanges) {
    e.preventDefault();
    e.returnValue = '';
  }
});
