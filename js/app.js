/**
 * Alpine.js application store and UI logic.
 */

const MAX_CSV_SIZE = 10 * 1024 * 1024;     // 10 MB
const MAX_SESSION_SIZE = 50 * 1024 * 1024;  // 50 MB

document.addEventListener('alpine:init', () => {

  Alpine.store('app', {
    // View management
    currentView: 'welcome',

    // Report data
    recordIds: [],
    currentIdx: 0,
    report: null,
    selectedSentenceIdx: null,

    // Taxonomy (loaded from static JSON)
    taxonomy: [],
    attributeConfig: {},
    actionabilityLookup: {},
    actionabilityRules: {},

    // Progress
    validatedCount: 0,
    totalCount: 0,
    validatedIds: new Set(),

    // Preferences
    autoAdvance: true,

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

    // Extraction import state
    extractionData: null,
    extractionFields: [],
    extractionColumnMap: {},
    extractionStep: 1,
    extractionFindings: [],
    extractionErrors: [],
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

      // Load static data
      let taxonomyRes, attrsRes, rulesRes, normalityRes;
      try {
        [taxonomyRes, attrsRes, rulesRes, normalityRes] = await Promise.all([
          fetch('data/taxonomy.json').then(r => { if (!r.ok) throw new Error('taxonomy'); return r.json(); }),
          fetch('data/attributes.json').then(r => { if (!r.ok) throw new Error('attributes'); return r.json(); }),
          fetch('data/actionability-rules.json').then(r => { if (!r.ok) throw new Error('rules'); return r.json(); }),
          fetch('data/normality-mappings.json').then(r => r.json()).catch(() => ({})),
        ]);
      } catch (e) {
        this.showToast('Failed to load application data. Check your connection and refresh.', 'error');
        return;
      }

      this.taxonomy = taxonomyRes;
      this.attributeConfig = attrsRes;
      this.actionabilityRules = rulesRes;
      this.actionabilityLookup = Actionability.buildLookup(this.taxonomy);
      Taxonomy.setNormalityMappings(normalityRes);

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

      // Scroll selected sentence into view
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

      // Create validated finding from extraction
      const taxMatch = Taxonomy.matchFindingToTaxonomy(extraction.finding_name, this.taxonomy);
      const validated = {
        finding_name: taxMatch ? taxMatch.name : extraction.finding_name,
        taxonomy_id: taxMatch ? taxMatch.id : null,
        source_sentence_idx: this.selectedSentenceIdx || extraction.source_sentence_idx,
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
      const validated = {
        finding_name: taxMatch ? taxMatch.name : findingName,
        taxonomy_id: taxMatch ? taxMatch.id : null,
        source_sentence_idx: this.selectedSentenceIdx,
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

    // --- Actionability helper ---

    resolveActionability(taxonomyId, attributes) {
      return Actionability.resolve(
        taxonomyId, attributes,
        this.actionabilityLookup, this.actionabilityRules
      );
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

      // Build reports array, then atomically replace
      const reports = [];
      for (const row of this.uploadData) {
        const id = (row[this.uploadIdCol] || '').trim();
        const text = (row[this.uploadTextCol] || '').trim();
        if (!id || !text) continue;

        const findingsText = Sentences.parseFindingsSection(text);
        const sentences = Sentences.splitIntoSentences(findingsText);

        reports.push({
          record_id: id,
          report_text: text,
          sentences,
          llm_extractions: [],
          validated_findings: [],
          validated: false,
          validated_at: null,
          custom_findings_added: [],
          extraction_model: null,
          extraction_timestamp: null,
        });
      }
      await Storage.atomicReplace(reports);

      await this._loadSession();
      this.uploadData = null;
      this.uploadFields = [];
      this.uploadValidation = null;
      this.showToast(`Loaded ${this.totalCount} reports`, 'success');
    },

    // --- Sample data ---

    async loadSampleData() {
      let samples;
      try {
        const res = await fetch('data/sample-reports.json');
        if (!res.ok) throw new Error('fetch failed');
        samples = await res.json();
      } catch (e) {
        this.showToast('Failed to load sample reports', 'error');
        return;
      }

      const reports = samples.map(sample => {
        const findingsText = Sentences.parseFindingsSection(sample.report_text);
        const sentences = Sentences.splitIntoSentences(findingsText);
        return {
          record_id: sample.record_id,
          report_text: sample.report_text,
          sentences,
          llm_extractions: [],
          validated_findings: [],
          validated: false,
          validated_at: null,
          custom_findings_added: [],
          extraction_model: null,
          extraction_timestamp: null,
        };
      });
      await Storage.atomicReplace(reports);

      await this._loadSession();
      this.showToast(`Loaded ${samples.length} sample reports`, 'success');
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

    async processExtractionImport() {
      const validIds = new Set(this.recordIds);
      const { findings, errors } = CsvImport.parseExtractionCsv(
        this.extractionData, this.extractionColumnMap, validIds
      );
      this.extractionFindings = findings;
      this.extractionErrors = errors;

      // Taxonomy matching on unique finding names (3 categories)
      const uniqueNames = [...new Set(findings.map(f => f.finding_name))].sort();
      const matched = {};   // name → { name, id }
      const fuzzy = {};     // name → { name, id, score }
      const unmatched = []; // names with no match

      for (const name of uniqueNames) {
        // matchFindingToTaxonomy includes exact + synonym + normality (but not fuzzy alone)
        const exactResult = this._findByExactOrNormality(name);
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

    // Helper: find by exact name, synonym, or normality mapping (no fuzzy).
    _findByExactOrNormality(findingName) {
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
      // Level 3: Normality mapping
      return Taxonomy.matchNormality(normalized, this.taxonomy);
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

      let imported = 0;
      for (const [recordId, findings] of Object.entries(byRecord)) {
        const report = await Storage.loadReport(recordId);
        if (!report) continue;

        const newExtractions = [];
        for (const f of findings) {
          let finalName = f.finding_name;

          // Resolve name from match categories
          if (matched[f.finding_name]) {
            finalName = matched[f.finding_name].name;
          } else if (fuzzy[f.finding_name] && this.fuzzyAccepted.has(f.finding_name)) {
            finalName = fuzzy[f.finding_name].name;
          }

          // Resolve source_text → sentence index
          let sentenceIdx = f.source_sentence_idx;
          if (!sentenceIdx && f.source_text && report.sentences) {
            sentenceIdx = Sentences.matchSourceToSentence(f.source_text, report.sentences);
          }

          newExtractions.push({
            finding_name: finalName,
            source_sentence_idx: sentenceIdx,
            source_text: f.source_text || '',
            attributes: f.attributes || { presence: 'indeterminate' },
          });
          imported++;
        }

        // Replace (not append) extractions, clear validation
        report.llm_extractions = newExtractions;
        report.validated_findings = [];
        report.validated = false;
        report.validated_at = null;
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
      this.extractionMatchCategories = { matched: {}, fuzzy: {}, unmatched: [] };
      this.fuzzyAccepted = new Set();
      this.extractionReportsWithExisting = [];
      this.extractionReportsWithValidated = [];
      this.showToast(`Imported ${imported} findings into ${Object.keys(byRecord).length} reports`, 'success');
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
            report.sentences = Sentences.splitIntoSentences(findingsText);
          } else {
            report.sentences = [];
          }
        }
      }

      // Atomic clear+import in a single transaction
      try {
        await Storage.atomicReplace(validReports);
      } catch (e) {
        this.showToast('Failed to restore session: ' + (e.message || 'unknown error'), 'error');
        return;
      }

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

    async exportAllCsv() {
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
      this._downloadBlob(csv, 'all-findings.csv', 'text/csv');
    },

    async exportTaxonomyCsv() {
      const rows = this.taxonomy.map(f => ({
        id: f.id,
        name: f.name,
        category: f.category,
        synonyms: f.synonyms.join(', '),
        actionability: f.actionability,
      }));
      const csv = Papa.unparse(rows);
      this._downloadBlob(csv, 'findings-taxonomy.csv', 'text/csv');
    },

    // --- Template CSV Download ---

    downloadExtractionTemplate() {
      const attrKeys = Object.keys(this.attributeConfig).filter(a => a !== 'presence');
      const headers = ['record_id', 'finding_name', 'presence', 'source_text', ...attrKeys];
      const emptyAttrs = attrKeys.map(() => '');
      const rows = [
        ['EXAMPLE-001', 'Pleural effusion', 'present', 'Small left-sided pleural effusion', ...emptyAttrs],
        ['EXAMPLE-001', 'Lung abnormality', 'absent', 'Lungs are clear', ...emptyAttrs],
      ];
      const csv = Papa.unparse({ fields: headers, data: rows });
      this._downloadBlob(csv, 'extraction_template.csv', 'text/csv');
    },

    // --- LLM Prompt Download ---

    downloadExtractionPrompt() {
      const findingNames = this.taxonomy.map(f => `- ${f.name}`).join('\n');
      const attrLines = Object.entries(this.attributeConfig)
        .filter(([key]) => key !== 'presence')
        .map(([key, cfg]) => {
          let desc = `- ${key}: ${cfg.description}`;
          if (cfg.type === 'enum' && cfg.values.length) {
            desc += ` (${cfg.values.join(', ')})`;
          }
          return desc;
        })
        .join('\n');
      const prompt = `You are a radiology report extractor. Given a chest X-ray radiology report, extract all findings mentioned in the FINDINGS section.

For each finding, output one row in CSV format with these columns:
- record_id: The report identifier (provided with each report)
- finding_name: Use a name from the taxonomy list below. If no match, use a concise clinical name.
- presence: One of: present, absent, indeterminate
- source_text: The exact sentence or phrase from the report supporting this finding
${attrLines}

TAXONOMY (use these finding names when possible):
${findingNames}

OUTPUT FORMAT:
Output ONLY valid CSV with the header row followed by data rows. One row per finding per report.
Do not include any other text, explanation, or markdown formatting.
`;
      this._downloadBlob(prompt, 'extraction_prompt.txt', 'text/plain');
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
      document.getElementById('stats-overlay')?.classList.remove('hidden');
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

    _buildFindingRows(report) {
      const rows = [];
      const sentences = report.sentences || [];

      // Helper to build one row
      const makeRow = (f, status) => {
        const attrs = f.attributes || {};
        const idx = f.source_sentence_idx;
        const sentenceText = (idx && idx > 0 && idx <= sentences.length)
          ? Sentences.splitSentenceHeader(sentences[idx - 1])[1]
          : '';
        const row = {
          record_id: report.record_id,
          status,
          finding_name: f.finding_name,
          taxonomy_id: f.taxonomy_id || '',
          source_sentence_idx: idx || '',
          source_text: f.source_text || sentenceText || '',
          origin: f.origin || '',
          was_modified: f.was_modified || false,
          is_custom: f.is_custom || false,
        };
        for (const key of Object.keys(this.attributeConfig)) {
          const val = attrs[key];
          row[key] = Array.isArray(val) ? val.join('; ') : (val || '');
        }
        row.actionability = this.resolveActionability(f.taxonomy_id, attrs) || '';
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
      document.getElementById('shortcuts-overlay')?.classList.toggle('hidden');
      break;
    case 'Escape':
      document.getElementById('shortcuts-overlay')?.classList.add('hidden');
      document.getElementById('stats-overlay')?.classList.add('hidden');
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
