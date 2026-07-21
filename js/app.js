/**
 * Alpine.js application store and UI logic.
 */

const MAX_CSV_SIZE = 10 * 1024 * 1024;     // 10 MB
const MAX_SESSION_SIZE = 50 * 1024 * 1024;  // 50 MB

// Single source of truth for the on-disk report schema version. Bump
// this when changes to sentence splitting, finding shape, or migration
// logic require re-deriving stored data.
const SCHEMA_VERSION = 5;

// Ordered forward-migration registry. A stale report applies every migration
// whose `to` exceeds its (normalized) schema_version, in order, then the
// version-independent sentence-remap runs. Migrations mutate the report in
// place. Keep them idempotent — a restored old session may re-enter here.
//
// v5 is the single step up from the published v4 schema:
//   1. unify the two legacy finding arrays into one status-tagged findings[]
//   2. convert legacy presence 'indeterminate' to the polarity+hedge model
//      (cue-aware; sets the DISTINCT _polarityReview marker — not
//      _needsReview — so the sentence-remap can't silently un-flag it, and
//      returns the conversion count so a review banner can surface)
//   3. move legacy attribute names/values to their current home via
//      Schema.migrateLegacyAttributes (the same old→new table applied at the
//      import boundary, so stored annotations and fresh imports convert
//      identically)
// The version bump also forces the sentence rebuild below, so v4 corpora
// pick up the current splitter (flattened-line-break recovery, templated
// "Header: none" lines kept as numbered sentences, section vs subheader
// classification).
function toV5_convergeFromPublishedV4(report) {
  if (!Array.isArray(report.findings)) {
    const validated = (report.validated_findings || []).map(f => ({ ...f, status: 'validated' }));
    const pending = (report.llm_extractions || []).map(f => ({ ...f, status: 'pending' }));
    report.findings = [...validated, ...pending];
  }
  delete report.validated_findings;
  delete report.llm_extractions;

  let converted = 0;
  for (const f of report.findings) {
    if (f.attributes && f.attributes.presence === 'indeterminate') {
      const { presence, hedge, review } = Schema.convertIndeterminate(f.source_text);
      f.attributes.presence = presence;
      if (hedge) { f.confidence = f.confidence || {}; f.confidence.presence = 'hedged'; }
      if (review) f._polarityReview = true;
      converted++;
    }
    Schema.migrateLegacyAttributes(f.attributes);
  }
  return converted;
}

const MIGRATIONS = [
  { to: 5, fn: toV5_convergeFromPublishedV4 },
];

document.addEventListener('alpine:init', () => {

  // One finding-card component serves every panel (D5). It carries only the
  // rendering mode — value bindings stay on the x-for scope's `finding` so
  // Alpine reactivity keeps working when the store mutates a finding in
  // place (an x-data snapshot of the finding would go stale on keyed re-render).
  Alpine.data('findingCard', (mode) => ({
    mode,
    get isEdit() { return this.mode === 'edit'; },
    get isTriage() { return this.mode === 'triage'; },
    get isRecovery() { return this.mode === 'recovery'; },
    get isRejected() { return this.mode === 'rejected'; },
  }));

  Alpine.store('app', {
    // View management. Starts on a dedicated loading view so a mid-session
    // reload never flashes the empty welcome screen ("my data is gone")
    // while init resolves.
    currentView: 'loading',

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
    searchTotal: 0,
    autocompleteIndex: -1,

    // Universal drop zone state. dropResults renders one chip per dropped
    // file (routed / queued / error, with a plain-language rationale so
    // routing never feels like magic). queuedExtractions holds extraction
    // files dropped before any reports exist — they auto-import when
    // reports arrive.
    dropResults: [],
    queuedExtractions: [],
    // True once an extraction import has been committed this session —
    // drives the welcome stepper's step-3 "done" chip.
    extractionsImported: false,

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
    // Rows set aside at parse time (missing identity fields / unknown
    // record_id) — kept for the panel accounting and the error CSV.
    extractionDropped: [],
    // reportsById cache from the last validation run; lets the fix-it prompt
    // build synchronously inside the copy click (see runExtractionValidation).
    _fixItReports: null,
    // Validation summary populated after the user clicks "Check My Data"
    // in Step 1. Shape: { counts:{...}, invalid:[...], valid:[...], customAttributes:Set }.
    // Null until validation has run.
    extractionValidationSummary: null,
    extractionMatchCategories: { matched: {}, fuzzy: {}, unmatched: [] },
    fuzzyAccepted: new Set(),
    extractionReportsWithExisting: [],
    extractionReportsWithValidated: [],
    // Merge-mode choice shown when extractionReportsWithExisting is
    // non-empty (a touched report already has unreviewed pending findings):
    // 'add' (default) keeps them and appends the new import; 'replace'
    // reproduces the old supersede-on-reimport behavior.
    extractionMergeMode: 'add',

    // Stats (populated on demand)
    _stats: null,
    // Storage persistence + usage snapshot (populated by showStats)
    _storageInfo: null,
    // Rolling-backup metadata for the welcome recovery area (populated on init)
    backups: [],

    // Set only when a save actually fails (the sole unload hazard). Every
    // action auto-saves, so a normal session is never "unsaved" — the
    // beforeunload guard fires exclusively on a real save failure.
    _saveFailed: false,
    // Snapshot undo (D5): per-report ring of prior serialized states
    // (cap UndoRing.DEPTH), pushed by _saveCurrentReport before each write.
    // One mechanism covers the whole accidental-edit class — attribute
    // cycles, deletes, rejects, presence flips. _redo holds a single level;
    // _lastSavedState caches the most recent persisted serialization so a
    // save can push its predecessor without an extra IndexedDB read.
    _undo: {},
    _redo: {},
    _lastSavedState: {},
    // Per-panel collapse override (panel.key → bool). Empty = use each panel's
    // default; a manual expand/collapse writes here so it survives re-renders.
    _panelCollapsed: {},
    // Dismissible banner text set by an indeterminate-conversion migration.
    _migrationBanner: null,
    // Generic dismissible notice banner (migration + import summaries render
    // here, not as auto-expiring toasts — the user should acknowledge them).
    _notice: null,
    // Styled-confirm dialog state: { message, detail, resolve } while open.
    // confirmDialog() resolves true/false; replaces native confirm().
    _confirm: null,

    // Toast
    toastMessage: '',
    toastType: 'info',
    toastVisible: false,
    _toastTimerId: null,
    _autoAdvanceTimerId: null,

    async init() {
      // Load preferences
      this.autoAdvance = localStorage.getItem('autoAdvance') !== 'false';

      // Independent reads run in parallel (D3): taxonomy, attribute config
      // (a persisted .idm 'attributes' asset governs over the repo default),
      // report count, and the one-integer schema-version meta record.
      let stored, count, schemaMeta, attrs;
      try {
        [stored, attrs, count, schemaMeta] = await Promise.all([
          Storage.loadTaxonomy(),
          // Attribute settings: a persisted .idm asset wins over the repo
          // default. A fetch failure here is NON-fatal (returns null) — it must
          // not hide an intact corpus behind the empty welcome screen (the
          // whole point of the loading view). The annotate view still loads;
          // attribute rows stay empty until the settings are available again.
          Storage.resolveAttributeConfig('data/attributes.json'),
          Storage.getReportCount(),
          Storage.getDataAsset('schema_meta'),
        ]);
      } catch (e) {
        // Only a genuine IndexedDB read failure lands here — nothing to show.
        this.currentView = 'welcome';
        this.showToast('Could not read your saved data. Refresh to try again.', 'error');
        return;
      }
      if (attrs === null) {
        attrs = {};
        this.showToast('Could not load the attribute settings — some fields may be missing. Refresh to retry.', 'error');
      }
      this.attributeConfig = attrs;
      if (stored) {
        this.taxonomy = stored.findings;
        this.examType = stored.examType;
      }

      // Wire the Schema accessor from the fetched config BEFORE migration —
      // the v5 presence conversion and every vocabulary surface read from it.
      Schema.init(this.attributeConfig);

      // One-integer staleness check: the corpus scan inside
      // _runMigrationIfNeeded only runs when the stored dataSchemaVersion
      // (written at import/migration time) doesn't match the app's.
      if (count > 0 && schemaMeta?.payload?.dataSchemaVersion !== SCHEMA_VERSION) {
        await this._runMigrationIfNeeded();
      }

      // Load rolling-backup metadata for the welcome recovery area.
      await this.loadBackups();

      if (count > 0) {
        await this._loadSession();
      }
      // Anything that didn't resolve to the annotate view lands on welcome.
      if (this.currentView === 'loading') this.currentView = 'welcome';

      // Listen for browser back/forward
      window.addEventListener('popstate', async (e) => {
        if (e.state && typeof e.state.idx === 'number') {
          // Capture the sentence param BEFORE navigateTo — its auto-select of
          // sentence 1 replaces the URL, clobbering the popped entry's value.
          const s = parseInt(new URLSearchParams(window.location.search).get('sentence'), 10);
          await this.navigateTo(e.state.idx, true);
          if (!isNaN(s) && s > 0) this.selectSentence(s);
        }
      });
    },

    async _loadSession() {
      // A full (re)load establishes a fresh corpus state — the snapshot undo
      // history is scoped to a single loaded corpus and must NOT survive it.
      // record_id collides routinely across corpora (small integers, recurring
      // accession numbers); without this reset a stale snapshot could restore
      // over a same-id report in a newly-loaded corpus (Ctrl+Z data loss), and
      // a post-import reload would let Ctrl+Z discard the just-imported work.
      this._undo = {};
      this._redo = {};
      this._lastSavedState = {};
      this.recordIds = await Storage.listReportIds();
      this.totalCount = this.recordIds.length;
      const validatedIds = await Storage.getValidatedIds();
      this.validatedIds = new Set(validatedIds);
      this.validatedCount = validatedIds.length;
      if (this.recordIds.length > 0) {
        // Initial position from the URL: ?record=<record_id> is canonical
        // (bookmarks survive corpus changes); legacy ?idx=<position> still
        // resolves.
        const params = new URLSearchParams(window.location.search);
        let startIdx = 0;
        const urlRecord = params.get('record');
        if (urlRecord && this.recordIds.includes(urlRecord)) {
          startIdx = this.recordIds.indexOf(urlRecord);
        } else {
          const urlIdx = parseInt(params.get('idx'), 10);
          if (!isNaN(urlIdx) && urlIdx >= 0 && urlIdx < this.recordIds.length) startIdx = urlIdx;
        }
        // replaceState on the initial position — loading a session must not
        // add a redundant history entry.
        await this.navigateTo(startIdx, false, true);
        this.currentView = 'annotate';

        // Restore sentence from URL
        const urlSentence = parseInt(params.get('sentence'), 10);
        if (!isNaN(urlSentence) && urlSentence > 0) {
          this.selectSentence(urlSentence);
        }
      }
    },

    // Persist the one-integer schema-version meta record init compares.
    // Stored as a reserved dataAssets record (excluded from session export).
    async _writeSchemaMeta() {
      await Storage.saveDataAsset({ name: 'schema_meta', payload: { dataSchemaVersion: SCHEMA_VERSION } });
    },

    // Re-init the attribute schema from the repo default (data/attributes.json),
    // dropping any bundle-provided override. Used when the governing data set
    // changes — a plain taxonomy swap or "delete all data" — so a previously
    // loaded .idm's vocabulary stops governing. Non-fatal on fetch failure.
    async _resetAttributesToDefault() {
      try {
        const r = await fetch('data/attributes.json');
        if (!r.ok) return;
        this.attributeConfig = await r.json();
        Schema.init(this.attributeConfig);
      } catch { /* keep current config — a plain swap is still better than a crash */ }
    },

    async _runMigrationIfNeeded() {
      const all = await Storage.exportAllReports();
      const stale = all.filter(r => r.schema_version !== SCHEMA_VERSION);
      if (!stale.length) {
        // Corpus is current — record that so the next init skips this scan.
        await this._writeSchemaMeta();
        return;
      }

      const taxMeta = await Storage.loadTaxonomy();
      const taxonomyVersion = taxMeta ? `${taxMeta.examType}:${taxMeta.loadedAt}` : '';

      // Pass 1: rebuild sentences for every stale report so that pass 2
      // can use the new sentence text for cross-report matching diagnostics.
      const rebuilt = stale.map(r => {
        const ft = Sentences.parseFindingsSection(r.report_text || '');
        const { sentences, sectionBreaks } = Sentences.splitIntoSentences(ft);
        return { ...r, sentences, sectionBreaks };
      });

      // Pass 2: apply the forward-migration registry, then remap findings
      // against the new sentences.
      let remapped = 0, needsReview = 0, converted = 0;
      for (const report of rebuilt) {
        // Normalize a missing/non-integer schema_version to the legacy floor (4)
        // BEFORE selecting migrations — otherwise `migration.to > undefined` is
        // false and a truly legacy report never migrates (stranded two-array).
        let version = Number.isInteger(report.schema_version) ? report.schema_version : 4;
        for (const m of MIGRATIONS) {
          if (m.to > version) {
            const r = m.fn(report);
            if (typeof r === 'number') converted += r; // v5 returns its presence-conversion count
            version = m.to;
          }
        }

        // Version-independent repair: re-link every finding to its sentence.
        // Iterates the unified findings[] (v5 removed the legacy arrays).
        // Clears _needsReview on a match but never touches _polarityReview — a
        // polarity-converted finding stays flagged through the remap.
        for (const f of report.findings || []) {
          if (!f.source_text) {
            f.source_sentence_idx = null;
            continue;
          }
          const r = Sentences.matchSourceToSentence(
            f.source_text, report.sentences, report.record_id, rebuilt, report.report_text || '');
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
        report.taxonomyVersion = taxonomyVersion;
        report.schema_version = SCHEMA_VERSION;
      }

      await Storage.importReports(rebuilt);
      await this._writeSchemaMeta();
      const detail = needsReview
        ? ` ${needsReview} finding(s) no longer match a sentence — see the "Unassigned Validated" list to reassign or remove them.`
        : ` ${remapped} finding(s) re-linked to their sentences.`;
      // Migration summaries persist until acknowledged (banner, not toast).
      this.showNotice(`Updated ${stale.length} report(s) to the latest version.${detail}`);

      // Presence conversions get a DISMISSIBLE banner (not a 3s toast): the
      // annotator needs to review each flagged card to confirm which way it
      // leans, so the notice must persist until acknowledged.
      if (converted > 0) {
        this._migrationBanner = `${converted} finding(s) converted from "indeterminate" — review the flagged cards (possible / no definite) to confirm which way each leans.`;
      }
    },

    // --- Navigation ---

    async navigateTo(idx, fromPopstate, replaceHistory) {
      // Guard against a non-integer index (e.g. an empty jump input → parseInt('')
      // = NaN, which slips past the `< 0` / `>= length` range checks and would
      // load recordIds[NaN] = undefined). Keeps the current report loaded.
      if (!Number.isInteger(idx)) return;
      if (idx < 0 || idx >= this.recordIds.length) return;
      if (this._autoAdvanceTimerId) {
        clearTimeout(this._autoAdvanceTimerId);
        this._autoAdvanceTimerId = null;
      }
      this.currentIdx = idx;
      const recordId = this.recordIds[idx];
      this.report = await Storage.loadReport(recordId);
      // Seed the undo baseline: the freshly-loaded state is what the next
      // mutation's undo restores to.
      if (this.report) this._lastSavedState[recordId] = JSON.stringify(this.report);
      this.selectedSentenceIdx = null;
      this.searchQuery = '';
      this.searchResults = [];

      // Update URL. Reports are identified by record_id (?record=) so
      // bookmarks survive corpus changes; the initial session load replaces
      // instead of pushing (no redundant history entry).
      if (!fromPopstate) {
        const url = '?record=' + encodeURIComponent(recordId);
        if (replaceHistory) history.replaceState({ idx }, '', url);
        else history.pushState({ idx }, '', url);
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
      // No other unvalidated reports. Distinguish "current is the only one left"
      // from "everything is validated" — the old code falsely claimed the latter.
      if (this.recordIds.length && !this.validatedIds.has(this.recordIds[this.currentIdx])) {
        this.showToast('No other unvalidated reports', 'info');
      } else {
        this.showToast('All reports validated!', 'success');
      }
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

      // Update URL with sentence param (record_id-keyed, like navigateTo)
      const recordId = this.recordIds[this.currentIdx];
      const url = '?record=' + encodeURIComponent(recordId) + '&sentence=' + idx;
      history.replaceState({ idx: this.currentIdx }, '', url);

      // Scroll selected sentence into view. Do NOT auto-focus the finding
      // search input — focusing an input traps J/K keystrokes there and
      // breaks sentence navigation. Press F to focus search explicitly.
      requestAnimationFrame(() => {
        document.querySelector('[data-sentence-idx="' + idx + '"]')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });
    },

    // --- Finding groups (computed) ---

    // All finding getters map-before-filter over the unified report.findings so
    // _globalIdx is the BACKING array index (not the filtered position). This
    // matters under unification: findings[] is heterogeneous by status, so a
    // filter-then-index slip would mutate the wrong element whenever a
    // differently-statused finding precedes the visible row.
    get pendingFindings() {
      if (!this.report || !this.selectedSentenceIdx) return [];
      return (this.report.findings || [])
        .map((f, i) => ({ ...f, _globalIdx: i }))
        .filter(f => f.status === 'pending' && f.source_sentence_idx === this.selectedSentenceIdx);
    },

    get validatedFindings() {
      if (!this.report || !this.selectedSentenceIdx) return [];
      return (this.report.findings || [])
        .map((f, i) => ({ ...f, _globalIdx: i }))
        .filter(f => f.status === 'validated' && f.source_sentence_idx === this.selectedSentenceIdx);
    },

    get unassignedFindings() {
      if (!this.report) return [];
      return (this.report.findings || [])
        .map((f, i) => ({ ...f, _globalIdx: i }))
        .filter(f => f.status === 'pending' && !f.source_sentence_idx);
    },

    // Validated findings with no usable sentence linkage. Surfaces data
    // damaged by the old addFinding bug (saved with source_sentence_idx
    // null on empty reports / before a sentence was selected) so the
    // user can delete and re-add. Uses Number.isInteger to also catch
    // string/float restored shapes.
    // A source_sentence_idx is a valid sentence anchor iff it's an integer in
    // [1, count]. Single source of truth for "is this finding anchored to a real
    // sentence" — drives the export row set, the Unassigned-Validated recovery
    // list, the sidebar progress count, and the validate-time incomplete block,
    // so a finding is consistently either anchored everywhere or unanchored
    // everywhere (never dropped from export yet invisible in recovery).
    _isSentenceAnchor(idx, count) {
      return Number.isInteger(idx) && idx >= 1 && idx <= count;
    },

    get unassignedValidatedFindings() {
      if (!this.report) return [];
      const max = (this.report.sentences || []).length;
      // "Unassigned" is the exact complement of _isSentenceAnchor — an
      // out-of-range integer idx counts as unassigned too, so it can't fall
      // through the cracks (dropped from export yet invisible everywhere).
      return (this.report.findings || [])
        .map((f, i) => ({ ...f, _globalIdx: i }))
        .filter(f => f.status === 'validated' && !this._isSentenceAnchor(f.source_sentence_idx, max));
    },

    // Rejected findings on the selected sentence — the browsable/restorable
    // review surface (completes the rejection status flip's lifecycle).
    get rejectedFindings() {
      if (!this.report || !this.selectedSentenceIdx) return [];
      const max = (this.report.sentences || []).length;
      // A rejected finding on the selected sentence, OR one with no valid
      // sentence anchor at all. The latter (rejected from the Unassigned panel,
      // source_sentence_idx null) matches no sentence, so without this it would
      // render in no panel and the Restore action could never reach it —
      // recoverable only via the transient undo. Surfacing orphans on any
      // selected sentence keeps them restorable.
      return (this.report.findings || [])
        .map((f, i) => ({ ...f, _globalIdx: i }))
        .filter(f => f.status === 'rejected'
          && (f.source_sentence_idx === this.selectedSentenceIdx
            || !this._isSentenceAnchor(f.source_sentence_idx, max)));
    },

    // The finding panels the right rail renders, in display order. One card
    // template serves all of them, parameterized by `mode`:
    //   recovery — read-only + delete (unassigned validated)
    //   triage   — read-only + accept/reject (unassigned, pending)
    //   edit     — the full attribute editor (validated)
    //   rejected — read-only + restore, collapsed by default
    // Tone classes are complete literals (the Tailwind precompile scans
    // js/*.js — never build class names dynamically).
    get findingPanels() {
      const panels = [
        {
          key: 'unassigned-validated', mode: 'recovery', title: 'Unassigned Validated', icon: 'ti-alert-triangle',
          wrap: 'bg-orange-50 border border-orange-300', head: 'text-orange-800', hintClass: 'text-orange-700',
          hint: 'Validated findings without a source sentence — created before a sentence was selected. Delete and re-add against the correct sentence.',
          defaultCollapsed: false, findings: this.unassignedValidatedFindings,
        },
        {
          key: 'unassigned', mode: 'triage', title: 'Unassigned', icon: 'ti-link-off',
          wrap: 'bg-gray-50 border border-gray-300', head: 'text-gray-700', hintClass: 'text-gray-500',
          hint: 'Findings without a source sentence. Accept to assign to selected sentence.',
          defaultCollapsed: false, findings: this.unassignedFindings,
        },
        {
          key: 'pending', mode: 'triage', title: 'Pending Review', icon: 'ti-checklist',
          wrap: 'bg-amber-50 border border-amber-200', head: 'text-amber-800', hintClass: 'text-amber-700',
          hint: '', defaultCollapsed: false, findings: this.pendingFindings,
        },
        {
          // Unboxed: no wrap tint (unlike the other panels) because there's no
          // color signal to carry — the presence pill inside each card is that
          // signal — so the surrounding white/bordered box was pure nested-
          // container overhead, narrowing every validated card relative to a
          // sibling panel's cards for no visual payoff. Dropping it also lines
          // validated cards up with the Add Finding box's own width.
          key: 'validated', mode: 'edit', title: 'Validated', icon: 'ti-circle-check',
          boxed: false, head: 'text-gray-700', hintClass: 'text-gray-500',
          hint: '', defaultCollapsed: false, findings: this.validatedFindings,
        },
        {
          key: 'rejected', mode: 'rejected', title: 'Rejected', icon: 'ti-ban',
          wrap: 'bg-red-50/60 border border-red-200', head: 'text-red-800', hintClass: 'text-red-700',
          hint: 'Rejected findings still export as "not this" training signal. Restore returns one to pending review.',
          defaultCollapsed: true, findings: this.rejectedFindings,
        },
      ];
      // Collapse state is a user override on top of each panel's default, kept
      // in a reactive map so a manual expand/collapse survives the next
      // mutation (the getter re-runs constantly; without this the <details>
      // would snap back to its default every re-render).
      return panels
        .filter(p => p.findings.length > 0)
        .map(p => ({ ...p, collapsed: this._panelCollapsed[p.key] ?? p.defaultCollapsed }));
    },

    // Flip a rejected finding back to pending from the rejected review panel.
    async restoreRejected(globalIdx) {
      if (!this.report) return;
      const finding = (this.report.findings || [])[globalIdx];
      if (!finding || finding.status !== 'rejected') return;
      finding.status = 'pending';
      await this._saveCurrentReport();
      this.showToast('Restored to pending review', 'success');
    },

    get allValidatedFindings() {
      if (!this.report) return [];
      return (this.report.findings || []).filter(f => f.status === 'validated');
    },

    // Count of unreviewed pending findings on the current report (any sentence).
    // Drives the footer validate button's review-gate.
    get reportPendingCount() {
      return (this.report?.findings || []).filter(f => f.status === 'pending').length;
    },

    // Sentence finding counts for highlights
    sentenceFindingCounts(sentenceIdx) {
      if (!this.report) return { validated: 0, pending: 0, incomplete: 0 };
      const findings = this.report.findings || [];
      const onSentence = findings
        .filter(f => f.status === 'validated' && f.source_sentence_idx === sentenceIdx);
      const validated = onSentence.length;
      const pending = findings
        .filter(f => f.status === 'pending' && f.source_sentence_idx === sentenceIdx).length;
      // Validated findings on this sentence that have an attribute added but
      // left without a value — drives the wrap-safe "needs a value" cue so an
      // incomplete finding's sentence no longer reads as fully done.
      const incomplete = onSentence.filter(f => this.incompleteAttrKeys(f).length > 0).length;
      return { validated, pending, incomplete };
    },

    // Highlight class map for one sentence, computed from a SINGLE
    // sentenceFindingCounts call. Bound directly as the sentence span's :class
    // so Alpine re-evaluates the counts once per sentence per tick instead of
    // once per class key (was ~11 calls, each re-filtering findings and running
    // incompleteAttrKeys). States are mutually exclusive: incomplete ⊂ validated,
    // so a sentence is exactly one of incomplete / done-green / pending-amber /
    // plain, plus the matching hover treatment when it isn't the selected one.
    sentenceHighlightClass(sentenceIdx) {
      const c = this.sentenceFindingCounts(sentenceIdx);
      const selected = this.selectedSentenceIdx === sentenceIdx;
      const doneGreen = c.validated > 0 && c.incomplete === 0;
      const pendingAmber = c.validated === 0 && c.pending > 0;
      const plain = c.validated === 0 && c.pending === 0;
      return {
        'sentence-selected': selected,
        'sentence-incomplete': c.incomplete > 0,
        'bg-green-100': doneGreen,
        'hover:bg-green-300': doneGreen && !selected,
        'bg-amber-100': pendingAmber,
        'hover:bg-amber-300': pendingAmber && !selected,
        'hover:bg-gray-200': plain && !selected,
      };
    },

    // Keys of a finding's non-presence attributes that were added but left
    // without a value chosen: '', whitespace-only, null, or an empty array. An
    // added-then-empty attribute row stays visible in the editor (getSetAttributes
    // keeps it) and reads as "—" — but nothing on screen otherwise marks it as
    // unfinished, so it can silently ride into a validated report. This pure
    // predicate backs the validate-time block and the card/sentence cues.
    // Booleans store 'true'/'false' (non-empty) and presence is excluded, so
    // only genuine empty-value rows are flagged.
    incompleteAttrKeys(finding) {
      const attrs = (finding && finding.attributes) || {};
      return Object.keys(attrs).filter(k => k !== 'presence' && this.attrValueEmpty(attrs[k]));
    },

    // True when an attribute value counts as "no value chosen": null/undefined,
    // an empty array, or an empty/whitespace-only string. Shared by the
    // incomplete predicate and the card's per-row amber tint.
    attrValueEmpty(v) {
      if (v == null) return true;
      if (Array.isArray(v)) return v.length === 0;
      return typeof v === 'string' && v.trim() === '';
    },

    // Empty-value amber tint for an attribute control, split by binding target
    // (:style background, :class border). Both the hybrid enum control and the
    // free-text input use these, so the tint colors live in exactly one place.
    attrTintStyle(v) {
      return this.attrValueEmpty(v) ? 'background:#fffbeb' : 'background:#fcfdfe';
    },
    attrTintBorderClass(v) {
      return this.attrValueEmpty(v) ? 'border-amber-400' : 'border-gray-200';
    },

    // --- Finding operations ---

    // Accept flips a pending finding to validated IN PLACE (no splice across
    // arrays): its identity and _globalIdx are preserved. Enriches with the
    // taxonomy match and clears both review markers — accepting confirms the
    // sentence anchor AND the cue-guessed polarity. attributes/confidence ride
    // along untouched (a hedged pending finding stays hedged once accepted).
    async acceptFinding(globalIdx) {
      if (!this.report) return;
      const finding = (this.report.findings || [])[globalIdx];
      if (!finding || finding.status !== 'pending') return;

      const sentenceIdx = this.selectedSentenceIdx || finding.source_sentence_idx;
      if (!sentenceIdx) {
        this.showToast('Cannot accept: no sentence linkage. Select a sentence first or fix the extraction.', 'error');
        return;
      }

      const taxMatch = Taxonomy.matchFindingToTaxonomy(finding.finding_name, this.taxonomy);
      finding.finding_name = taxMatch ? taxMatch.name : finding.finding_name;
      finding.taxonomy_id = taxMatch ? taxMatch.id : null;
      finding.is_custom = !taxMatch;
      finding.origin = finding.origin || 'llm';
      finding.was_modified = false;
      finding.source_sentence_idx = sentenceIdx;
      finding.source_text = finding.source_text || '';
      finding.status = 'validated';
      finding._needsReview = false;
      delete finding._polarityReview;
      delete finding._matchError;
      await this._saveCurrentReport();
    },

    // Reject preserves the finding as status:'rejected' (never spliced) — it
    // renders in no annotate panel but survives to the training-data export.
    // An "Undo" toast lets the annotator flip it straight back to pending.
    async rejectFinding(globalIdx, reason) {
      if (!this.report) return;
      const finding = (this.report.findings || [])[globalIdx];
      if (!finding) return;
      const name = this.humanizeName(finding.finding_name);
      finding.status = 'rejected';
      if (reason) finding.reject_reason = reason;
      await this._saveCurrentReport();
      // The toast's generic Undo button rides the snapshot stack — the save
      // above pushed the pre-reject state, so Undo flips it straight back.
      this.showToast(`Rejected ${name}`, 'info');
    },

    // --- Snapshot undo / redo (D5) ---

    // True when the current report has an undoable prior state (drives the
    // toast's Undo button).
    get canUndo() {
      const rid = this.report && this.report.record_id;
      return !!(rid && (this._undo[rid] || []).length);
    },

    // Restore the report's previous snapshot. The replaced state becomes the
    // single-level redo entry (Ctrl+Shift+Z); deeper redo is out of scope.
    async undoLastChange() {
      if (!this.report) return;
      const rid = this.report.record_id;
      const stack = this._undo[rid] || [];
      if (!stack.length) {
        this.showToast('Nothing to undo', 'info');
        return;
      }
      const currentStr = JSON.stringify(this.report);
      const priorStr = stack.pop();
      this._redo[rid] = currentStr;
      await this._restoreSnapshot(rid, priorStr);
      this.showToast('Undid the last change', 'success');
    },

    async redoLastUndo() {
      if (!this.report) return;
      const rid = this.report.record_id;
      const nextStr = this._redo[rid];
      if (!nextStr) {
        this.showToast('Nothing to redo', 'info');
        return;
      }
      delete this._redo[rid];
      // The state redo replaces becomes undoable again.
      UndoRing.push(this._undo[rid] ||= [], JSON.stringify(this.report));
      await this._restoreSnapshot(rid, nextStr);
      this.showToast('Redid the change', 'success');
    },

    // Write a serialized snapshot back as the current report, bypassing
    // _saveCurrentReport's push (a restore must not push itself onto the
    // undo stack it just popped).
    async _restoreSnapshot(rid, snapshotStr) {
      const restored = JSON.parse(snapshotStr);
      this.report = restored;
      try {
        // A fresh parse of the snapshot (not `restored`, which is now aliased by
        // the reactive this.report) — guaranteed proxy-free, so it can be saved
        // without a re-clone.
        await Storage.savePlainReport(JSON.parse(snapshotStr));
        this._saveFailed = false;
      } catch (e) {
        this._saveFailed = true;
        this.showToast(`Could not save changes: ${e?.name || 'error'}. Export your session to preserve edits.`, 'error');
      }
      this._lastSavedState[rid] = snapshotStr;
      // An undone/redone snapshot may flip the report's validated state.
      if (restored.validated) this.validatedIds.add(rid);
      else this.validatedIds.delete(rid);
      this.validatedIds = new Set(this.validatedIds);
      this.validatedCount = this.validatedIds.size;
    },

    async addFinding(findingName, isCustom) {
      if (!this.report || !findingName) return;

      // Hard rule: every validated finding must be anchored to a sentence.
      // Without this guard, a null source_sentence_idx silently writes a
      // finding that no panel can render (all groups key off
      // selectedSentenceIdx). Two distinguishable failure modes:
      //   - report parsed to zero sentences (data problem upstream)
      //   - user hasn't clicked a sentence yet (workflow problem)
      if (!this.selectedSentenceIdx) {
        const noSentences = (this.report.sentences || []).length === 0;
        this.showToast(
          noSentences
            ? 'Cannot add: this report has no annotatable sentences. → Fix the source CSV\'s findings column for this record.'
            : 'Cannot add: no sentence selected. → Click a sentence in the report first.',
          'error'
        );
        return;
      }

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

      const sentenceText = this.report.sentences?.[this.selectedSentenceIdx - 1] || '';

      const validated = {
        finding_name: taxMatch ? taxMatch.name : findingName,
        taxonomy_id: taxMatch ? taxMatch.id : null,
        source_sentence_idx: this.selectedSentenceIdx,
        source_text: sentenceText,
        status: 'validated',
        _needsReview: false,
        is_custom: !taxMatch,
        origin: 'human_added',
        was_modified: false,
        attributes: { presence: 'present' },
      };

      (this.report.findings ||= []).push(validated);
      await this._saveCurrentReport();
      this.showToast('Added: ' + validated.finding_name, 'success');
      this.searchQuery = '';
      this.searchResults = [];
    },


    // True removal (delete ≠ reject): drops the finding from findings[] entirely.
    async deleteFinding(validatedIdx) {
      if (!this.report) return;
      (this.report.findings || []).splice(validatedIdx, 1);
      await this._saveCurrentReport();
    },

    // Single presence mutator. Takes a spectrum option {presence, hedged} (from
    // Schema.presenceOptions), sets the polarity, sets/clears confidence.presence
    // via the invariant helper, and clears any cue-guessed _polarityReview — the
    // sole clear-path for findings validated at migration time (they never pass
    // through acceptFinding).
    async updatePresence(validatedIdx, option) {
      if (!this.report) return;
      const finding = this.report.findings[validatedIdx];
      if (!finding || !option) return;
      if (!finding.attributes) finding.attributes = {};
      finding.attributes.presence = option.presence;
      if (option.hedged && Schema.presenceHedgeable()) {
        finding.confidence = finding.confidence || {};
        finding.confidence.presence = 'hedged';
      } else {
        this._clearConfidence(finding, 'presence');
      }
      delete finding._polarityReview;
      if (finding.origin === 'llm') finding.was_modified = true;
      await this._saveCurrentReport();
    },

    // --- Presence spectrum control (all derived from Schema.presenceOptions) ---

    presenceOptions() { return Schema.presenceOptions(); },
    presenceOptionAt(i) { return Schema.presenceOptions()[Number(i)]; },

    // Advance presence to the next spectrum option (present → possible → no
    // definite → absent → …), wrapping. From an unset presence, lands on the
    // first option. Shared by the click-to-advance presence body and the 'd'
    // keyboard shortcut; the ▾ dropdown remains for a direct pick.
    cyclePresence(validatedIdx) {
      if (!this.report) return;
      const finding = this.report.findings[validatedIdx];
      if (!finding) return;
      const opts = Schema.presenceOptions();
      if (!opts.length) return;
      const curHedged = !!(finding.confidence && finding.confidence.presence === 'hedged');
      const i = opts.findIndex(o => o.presence === (finding.attributes || {}).presence && o.hedged === curHedged);
      this.updatePresence(validatedIdx, opts[(i + 1) % opts.length]);
    },

    // The spectrum option matching a finding's stored (presence, hedged), or null
    // when presence is unset. Falls back to the polarity-only option if the
    // finding is hedged under a schema where presence isn't hedgeable.
    _findingPresenceOption(finding) {
      const attrs = (finding && finding.attributes) || {};
      if (!attrs.presence) return null;
      const hedged = !!(finding.confidence && finding.confidence.presence === 'hedged');
      const opts = Schema.presenceOptions();
      return opts.find(o => o.presence === attrs.presence && o.hedged === hedged)
        || opts.find(o => o.presence === attrs.presence)
        || null;
    },

    // Tabler webfont class for the spectrum icon (see Schema.presenceOptions);
    // '' when presence is unset.
    presenceCellIcon(finding) {
      const o = this._findingPresenceOption(finding);
      return o ? o.icon : '';
    },

    // Label for the card cell / list badges ('possible'); '—' unset.
    presenceCellDisplay(finding) {
      const o = this._findingPresenceOption(finding);
      return o ? o.label.toLowerCase() : '—';
    },

    // Tooltip: names the state the circle's fill amount represents — one of
    // Present / Hedged present / Hedged absent / Absent.
    presenceCellTooltip(finding) {
      const attrs = (finding && finding.attributes) || {};
      if (!attrs.presence) return 'Presence — pick from list';
      const hedged = !!(finding.confidence && finding.confidence.presence === 'hedged');
      const polarity = attrs.presence === 'present' ? 'present' : 'absent';
      return hedged ? `Hedged ${polarity}` : polarity.charAt(0).toUpperCase() + polarity.slice(1);
    },

    // True iff `opt` is the finding's current presence choice (for :selected).
    isPresenceOptionSelected(finding, opt) {
      const cur = this._findingPresenceOption(finding);
      return !!(cur && cur.presence === opt.presence && cur.hedged === opt.hedged);
    },

    async updateAttribute(validatedIdx, attrName, value) {
      if (!this.report) return;
      const finding = this.report.findings[validatedIdx];
      if (!finding) return;
      if (!finding.attributes) finding.attributes = {};

      if (value === '' || value === null) {
        // Add-then-choose semantics: an empty value means "row present, no
        // value chosen yet" (renders — in the editor), NOT "delete the
        // attribute". Deletion is exclusively removeAttribute's job. Keeping
        // the empty key is what lets a just-added or cleared row stay visible.
        finding.attributes[attrName] = '';
        // A cleared row must not stay hedged: a hedge only ever accompanies a
        // real attribute value (the confidence invariant).
        this._clearConfidence(finding, attrName);
      } else {
        // Handle array type
        const config = this.attributeConfig[attrName];
        if (config && config.type === 'array') {
          const arr = value.split(',').map(v => v.trim()).filter(Boolean);
          finding.attributes[attrName] = arr;
          // A comma/whitespace-only input collapses to []: logically empty, so
          // it must drop any hedge too (the confidence invariant — a hedge only
          // ever accompanies a real value). Without this, an array attribute
          // emptied this way keeps a dangling confidence[axis]='hedged'.
          if (arr.length === 0) this._clearConfidence(finding, attrName);
        } else {
          finding.attributes[attrName] = value;
        }
      }
      if (finding.origin === 'llm') finding.was_modified = true;
      await this._saveCurrentReport();
    },

    // Sole deletion path for an attribute row. Removes the attribute AND any
    // hedge pointing at it, so removing a hedged attribute can't leave a stale
    // confidence key referencing a now-absent axis.
    async removeAttribute(validatedIdx, attrName) {
      if (!this.report) return;
      const finding = this.report.findings[validatedIdx];
      if (!finding) return;
      if (finding.attributes) delete finding.attributes[attrName];
      this._clearConfidence(finding, attrName);
      if (finding.origin === 'llm') finding.was_modified = true;
      await this._saveCurrentReport();
    },

    // --- Hedge / confidence ---

    // Delete finding.confidence[attrName] and drop the whole confidence object
    // when it becomes empty (canonical shape: a fully-definite finding carries
    // no confidence key). Pure helper — callers save.
    _clearConfidence(finding, attrName) {
      if (finding.confidence && attrName in finding.confidence) {
        delete finding.confidence[attrName];
        if (Object.keys(finding.confidence).length === 0) delete finding.confidence;
      }
    },

    // Toggle the per-axis hedge for an eye-toggle attribute row. Gated on the
    // schema's hedgeable axes (confidence.allowed_axes); presence is excluded
    // here even though it's hedgeable — its hedge is owned by the spectrum
    // control, not an eye-toggle row. Hedging an empty value is a no-op.
    async toggleHedge(validatedIdx, attrName) {
      if (attrName === 'presence' || !Schema.isHedgeable(attrName)) return;
      if (!this.report) return;
      const finding = this.report.findings[validatedIdx];
      if (!finding) return;
      const attrs = finding.attributes || {};
      const isHedged = !!(finding.confidence && finding.confidence[attrName] === 'hedged');
      if (isHedged) {
        this._clearConfidence(finding, attrName);
      } else {
        // Can't hedge a — row: an empty/whitespace/[]/null value isn't a real
        // value (same predicate the incomplete-attribute cue uses, so a row that
        // reads "needs a value" is never hedgeable). No save.
        if (this.attrValueEmpty(attrs[attrName])) return;
        finding.confidence = finding.confidence || {};
        finding.confidence[attrName] = 'hedged';
      }
      if (finding.origin === 'llm') finding.was_modified = true;
      await this._saveCurrentReport();
    },

    // Advance an enum/boolean attribute to its next allowed value. Not presence
    // (dropdown-only), not free-text/array, not multi-value (cycling would
    // overwrite the array — multi-value axes use add/remove chips instead).
    async cycleAttribute(validatedIdx, attrName) {
      if (attrName === 'presence' || Schema.isMultiValue(attrName)) return;
      if (!this.report) return;
      const finding = this.report.findings[validatedIdx];
      if (!finding) return;
      const values = Schema.enumValues(attrName);
      if (!values.length) return;
      if (!finding.attributes) finding.attributes = {};
      const i = values.indexOf(finding.attributes[attrName]);
      finding.attributes[attrName] = values[(i + 1) % values.length];
      if (finding.origin === 'llm') finding.was_modified = true;
      await this._saveCurrentReport();
    },

    // Add-then-choose: insert an empty row (renders —) and wait for the user to
    // pick a value via the row's dropdown. No silent default. Multi-value axes
    // seed [] (rendered as removable chips) rather than an empty string.
    async addAttribute(validatedIdx, attrName) {
      if (!this.report || !attrName) return;
      const finding = this.report.findings[validatedIdx];
      if (!finding) return;
      if (!finding.attributes) finding.attributes = {};
      if (attrName in finding.attributes) return; // no double-add
      finding.attributes[attrName] = Schema.isMultiValue(attrName) ? [] : '';
      await this._saveCurrentReport();
    },

    // --- Multi-value axes (temporal_status, chronicity): removable chips ---

    // Coerce a multi-value attribute's stored value to an array (a legacy scalar
    // becomes a one-element array).
    asMultiArray(v) {
      if (Array.isArray(v)) return v;
      return (v == null || v === '') ? [] : [v];
    },

    // Enum values for a multi-value axis not already chosen (the add-dropdown).
    multiValueRemaining(finding, key) {
      const cur = this.asMultiArray((finding.attributes || {})[key]);
      return Schema.enumValues(key).filter(v => !cur.includes(v));
    },

    async addMultiValue(validatedIdx, attrName, value) {
      if (!this.report || !value) return;
      const finding = this.report.findings[validatedIdx];
      if (!finding) return;
      if (!finding.attributes) finding.attributes = {};
      const cur = this.asMultiArray(finding.attributes[attrName]);
      if (!cur.includes(value)) cur.push(value);
      finding.attributes[attrName] = cur;
      if (finding.origin === 'llm') finding.was_modified = true;
      await this._saveCurrentReport();
    },

    async removeMultiValue(validatedIdx, attrName, value) {
      if (!this.report) return;
      const finding = this.report.findings[validatedIdx];
      if (!finding) return;
      const next = this.asMultiArray((finding.attributes || {})[attrName]).filter(v => v !== value);
      finding.attributes[attrName] = next;
      // Emptying the axis drops any hedge (the confidence invariant applies to
      // the axis as a whole).
      if (next.length === 0) this._clearConfidence(finding, attrName);
      if (finding.origin === 'llm') finding.was_modified = true;
      await this._saveCurrentReport();
    },

    // --- Per-finding flag ---

    async toggleFindingFlag(validatedIdx) {
      if (!this.report) return;
      const finding = this.report.findings[validatedIdx];
      if (!finding) return;
      finding.flagged = !finding.flagged;
      if (!finding.flagged) finding.flag_reason = '';
      await this._saveCurrentReport();
    },

    async setFindingFlagReason(validatedIdx, text) {
      if (!this.report) return;
      const finding = this.report.findings[validatedIdx];
      if (!finding) return;
      finding.flag_reason = text || '';
      await this._saveCurrentReport();
    },

    async removeFindingFlag(validatedIdx) {
      if (!this.report) return;
      const finding = this.report.findings[validatedIdx];
      if (!finding) return;
      finding.flagged = false;
      finding.flag_reason = '';
      await this._saveCurrentReport();
    },

    // --- Whole-exam flag ---

    async toggleExamFlag() {
      if (!this.report) return;
      this.report.flagged = !this.report.flagged;
      if (!this.report.flagged) this.report.flag_reason = '';
      await this._saveCurrentReport();
    },

    async setExamFlagReason(text) {
      if (!this.report) return;
      this.report.flag_reason = text || '';
      await this._saveCurrentReport();
    },

    // --- Validation ---

    async toggleValidation() {
      if (!this.report) return;

      // Guard: every validated finding must carry a presence value before
      // the report can be marked validated. This is one of the user-input
      // boundaries the integrity mandate covers — we surface and block,
      // never silently accept partial findings.
      if (!this.report.validated) {
        const validatedFindings = (this.report.findings || []).filter(f => f.status === 'validated');
        const missing = validatedFindings.filter(f => !f.attributes?.presence);
        if (missing.length) {
          this.showToast(
            `${missing.length} finding(s) missing a presence value. → Set presence on each before validating.`,
            'error'
          );
          return;
        }
        // Block validation when an anchored finding has an attribute that was
        // added but left with no value chosen. Scoped to validly-anchored
        // findings because the Unassigned Validated recovery card has no
        // attribute editor — blocking on an unanchored finding's empty attribute
        // would leave delete as the only escape.
        const max = (this.report.sentences || []).length;
        const incomplete = validatedFindings.filter(
          f => this._isSentenceAnchor(f.source_sentence_idx, max) && this.incompleteAttrKeys(f).length > 0
        );
        if (incomplete.length) {
          this.showToast(
            `${incomplete.length} finding(s) have an attribute with no value chosen. → Choose a value or remove the empty attribute before validating.`,
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
        // Un-validating cancels a pending auto-advance — the user clearly
        // wants to keep working on this report.
        if (this._autoAdvanceTimerId) {
          clearTimeout(this._autoAdvanceTimerId);
          this._autoAdvanceTimerId = null;
        }
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
      const all = Taxonomy.searchFindings(query, this.taxonomy);
      this.searchTotal = all.length;
      this.searchResults = all.slice(0, 20);
    },

    selectSearchResult(finding) {
      this.addFinding(finding.name, false);
    },

    addCustomFinding(name) {
      if (name) this.addFinding(name, true);
    },

    _reportsContainImportedExtractions(reports) {
      return (reports || []).some(r =>
        r?.extraction_model
        || r?.extraction_timestamp
        || (r?.findings || []).some(f => f?.status === 'pending' || f?.origin === 'llm')
        || (r?.llm_extractions || []).length > 0
      );
    },

    _resetSetupProgress({ keepQueued = false } = {}) {
      this.extractionsImported = false;
      if (!keepQueued) this.queuedExtractions = [];
    },

    // Welcome-stepper state per setup step: 'done' | 'current' | 'waiting'.
    // Step 3 (extractions) is optional, so its not-done-but-available state
    // reads 'optional' instead of 'current'. Purely visual — the drop zone
    // routes files correctly regardless of order.
    stepState(step) {
      const tax = (this.taxonomy || []).length > 0;
      const rep = this.totalCount > 0;
      if (step === 'taxonomy') return tax ? 'done' : 'current';
      if (step === 'reports') return rep ? 'done' : (tax ? 'current' : 'waiting');
      // extractions
      if (this.extractionsImported) return 'done';
      if (this.queuedExtractions.length > 0) return 'waiting';
      return rep ? 'optional' : 'waiting';
    },

    // --- Universal drop zone ---

    // One front door for every accepted file type. Classifies each dropped
    // file by content signature (js/file-classifier.js), then routes the
    // batch in dependency order (bundle → session → taxonomy → reports →
    // extractions) regardless of drop order, so a first-time user can drop
    // everything in one gesture. Existing per-type panels are unchanged —
    // this only decides which door each file goes through.
    async handleUniversalDrop(fileList) {
      const files = Array.from(fileList || []);
      if (!files.length) return;

      const classified = [];
      for (const file of files) {
        let c;
        try {
          c = await FileClassifier.classifyFile(file);
        } catch (e) {
          c = { type: 'unknown', rationale: 'the file could not be read' };
        }
        classified.push({ file, ...c });
      }

      const ORDER = { idm: 0, session: 1, taxonomy: 2, reports: 3, extraction: 4, unknown: 5 };
      classified.sort((a, b) => (ORDER[a.type] ?? 9) - (ORDER[b.type] ?? 9));

      this.dropResults = [];
      for (const c of classified) {
        await this._routeClassifiedFile(c);
      }
    },

    async _routeClassifiedFile(c) {
      const chip = {
        name: c.file.name,
        type: c.type,
        rationale: c.rationale,
        note: c.note || '',
        status: 'routed',
      };
      // Push the chip BEFORE routing so it's visible even when routing
      // switches views (reports mapping, extraction panel).
      const chipIndex = this.dropResults.length;
      this.dropResults = [...this.dropResults, chip];

      switch (c.type) {
        case 'idm':
          if (window.IdmLoader) {
            if (!await IdmLoader.load(c.file, this)) {
              chip.status = 'error';
              chip.rationale = 'data bundle import failed — see the message above';
            }
          } else {
            chip.status = 'error';
            chip.rationale = 'data bundles (.idm) are not supported in this version';
          }
          break;
        case 'session':
          if (await this.confirmDialog('Restore this saved session? It replaces all current data.',
            'A backup of the current data is taken automatically first.')) {
            if (!await this.restoreSession(c.file)) {
              chip.status = 'error';
              chip.rationale = 'session restore failed — see the message above';
            }
          } else {
            chip.status = 'error';
            chip.rationale = 'restore cancelled';
          }
          break;
        case 'taxonomy':
          if (!await this.handleTaxonomyUpload(c.file)) {
            chip.status = 'error';
            chip.rationale = 'taxonomy import failed — see the message above';
          }
          break;
        case 'reports':
          if (!await this.handleReportsCsvUpload(c.file)) {
            chip.status = 'error';
            chip.rationale = 'reports import failed — see the message above';
          }
          break;
        case 'extraction':
          if (this.recordIds.length > 0) {
            if (!await this.handleExtractionCsvUpload(c.file)) {
              chip.status = 'error';
              chip.rationale = 'extraction import failed — see the message above';
            }
          } else {
            chip.status = 'queued';
            this.queuedExtractions = [...this.queuedExtractions, c.file];
          }
          break;
        default:
          chip.status = 'error';
      }
      // Replace the object for Alpine reactivity on bound attrs/classes.
      this.dropResults = this.dropResults.map((r, i) => i === chipIndex ? { ...chip } : r);
    },

    // Auto-run the next queued extraction file once reports exist. Called
    // after reports land and after each extraction import completes (the
    // import panel handles one file at a time).
    async _runQueuedExtractions() {
      if (!this.queuedExtractions.length || this.recordIds.length === 0) return;
      const file = this.queuedExtractions[0];
      this.queuedExtractions = this.queuedExtractions.slice(1);
      const chip = this.dropResults.find(r => r.name === file.name && r.status === 'queued');
      if (chip) {
        chip.status = 'routed';
        this.dropResults = [...this.dropResults];
      }
      const ok = await this.handleExtractionCsvUpload(file);
      if (!ok && chip) {
        chip.status = 'error';
        chip.rationale = 'extraction import failed — see the message above';
        this.dropResults = [...this.dropResults];
      }
    },

    // --- CSV Upload ---

    async handleReportsCsvUpload(file) {
      if (!file) return false;
      if (file.size > MAX_CSV_SIZE) {
        this.showToast('CSV file exceeds 10 MB limit', 'error');
        return false;
      }
      let result;
      try {
        result = await CsvImport.parseFile(file);
      } catch (e) {
        this.showToast('Could not parse CSV file', 'error');
        return false;
      }
      this.uploadData = result.data;
      this.uploadFields = result.fields;
      const detected = CsvImport.detectColumns(result.fields);
      this.uploadIdCol = detected.idCol || '';
      this.uploadTextCol = detected.textCol || '';
      this.uploadValidation = null;
      this.currentView = 'upload-mapping';
      return true;
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
          findings: [],
          validated: false,
          validated_at: null,
          custom_findings_added: [],
          extraction_model: null,
          extraction_timestamp: null,
          taxonomyVersion,
          schema_version: SCHEMA_VERSION,
          // Whole-exam flag (annotator signal that this exam is a problem —
          // wrong heading, un-annotatable mapping, etc.). Non-indexed, so old
          // sessions lacking these read defensively (report.flagged || false).
          flagged: false,
          flag_reason: '',
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
      this._resetSetupProgress({ keepQueued: true });
      await Storage.atomicReplace(reports);
      // atomicReplace snapshotted (and may have pruned) — keep the welcome
      // recovery list in sync so it never offers a pruned snapshot.
      await this.loadBackups();
      // Fresh imports are stamped at the current schema — record the version
      // so the next init compares one integer instead of scanning the corpus.
      await this._writeSchemaMeta();
      // Record the reports CSV's original ID column name so the LLM
      // extraction prompt (built on a later visit to the playbook page) can
      // tell the user/LLM exactly which attached-CSV column record_id comes
      // from, instead of a generic placeholder.
      await Storage.saveDataAsset({ name: 'corpus_id_column', payload: { idColumn: this.uploadIdCol } });
      await this._loadSession();
      this.uploadData = null;
      this.uploadFields = [];
      this.uploadValidation = null;
      this.showToast(`Loaded ${this.totalCount} reports`, 'success');
      // Reports just arrived — run any extraction file that was dropped
      // before reports existed.
      await this._runQueuedExtractions();
    },

    // --- Extraction Import ---

    async handleExtractionCsvUpload(file) {
      if (!file) return false;
      if (file.size > MAX_CSV_SIZE) {
        this.showToast('CSV file exceeds 10 MB limit', 'error');
        return false;
      }
      let result;
      try {
        result = await CsvImport.parseFile(file);
      } catch (e) {
        this.showToast('Could not parse CSV file', 'error');
        return false;
      }
      return this._handleExtractionParseResult(result);
    },

    /**
     * Paste import: a textarea on the import panel feeding the same
     * Norm.text -> parseText pipeline parseFile uses, minus the save-a-file
     * step (and the TextEdit smart-quote mangling it invites) from the
     * happy path. Same D3 tolerance, same downstream wizard.
     */
    async handleExtractionPaste(text) {
      const raw = (text || '').trim();
      if (!raw) {
        this.showToast('Paste some text first.', 'error');
        return false;
      }
      let result;
      try {
        result = await CsvImport.parseText(CsvImport.Norm.text(raw));
      } catch (e) {
        this.showToast('Could not parse the pasted text', 'error');
        return false;
      }
      return this._handleExtractionParseResult(result);
    },

    // Shared by handleExtractionCsvUpload and handleExtractionPaste: both
    // produce the same { data, fields, errors } shape from CsvImport, so
    // everything after "we have parsed rows" — fatal-error handling, column
    // auto-detection, wizard state — is identical regardless of source.
    _handleExtractionParseResult(result) {
      const fatal = (result.errors || []).find(e => e.type === 'fatal');
      if (fatal) {
        this.showToast(fatal.message, 'error');
        return false;
      }
      if (!result.data || result.data.length === 0) {
        this.showToast('No rows found in the uploaded file', 'error');
        return false;
      }
      // Surface any D3 repair notes (a wrapper key unwrapped, prose ignored,
      // a truncated reply salvaged, multiple batches combined, smart quotes
      // straightened) — a file upload gets this via the drop-zone chip, but
      // a pasted reply skips the classifier entirely, so this is its only
      // chance to tell the user something was silently patched.
      if (result.notes && result.notes.length) {
        this.showNotice(result.notes.join(' '));
      }
      this.extractionData = result.data;
      this.extractionFields = result.fields;
      this.extractionStep = 1;
      // Reset any prior validation state so the user starts clean.
      this.extractionValidationSummary = null;
      this.extractionMergeMode = 'add';

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
      // Column names from older published schemas auto-join their current
      // key's alias list (single source of truth: Schema.LEGACY_COLUMN_RENAMES),
      // so an extraction produced under the old schema maps in Pass 1 —
      // `multiple` → aggregate, `anatomical_location` → anatomic_site.
      for (const [oldName, target] of Object.entries(Schema.LEGACY_COLUMN_RENAMES)) {
        (KNOWN_KEYWORDS[target] = KNOWN_KEYWORDS[target] || [target]).push(oldName);
      }
      const guessMap = {
        record_id: ['record_id', 'id', 'record', 'accession', 'case'],
        // The finding-name / source-text alias lists live on CsvImport (single
        // source of truth, shared with the drop-zone classifier's extraction
        // signature so the two front doors can't disagree about a file).
        finding_name: CsvImport.FINDING_NAME_ALIASES,
        presence: ['presence', 'status'],
        source_text: CsvImport.SOURCE_TEXT_ALIASES,
        sentence_idx: ['sentence_idx', 'sentence_index'],
      };
      // Annotatable attributes only (findingAttributeKeys excludes the metadata
      // keys presence + confidence — presence is mapped above, confidence is
      // consumed by the confidence path, never a column-mapped enum).
      for (const key of Schema.findingAttributeKeys()) {
        guessMap[key] = KNOWN_KEYWORDS[key] || [key, key.replace(/_/g, ' ')];
      }
      const map = {};
      const claimed = new Set();
      // Exclude confidence columns from auto-detection FIRST (the earliest
      // consumer). Otherwise Pass 2's substring match (`fl.includes(kw)`) maps
      // a `chronicity_confidence` field to the canonical `chronicity` attribute
      // when no exact `chronicity` column exists — stealing the mapping and
      // feeding 'hedged' into an enum column. These are consumed instead by the
      // confidence path in parseExtractionCsv.
      const mappableFields = result.fields.filter(f => {
        const n = f.toLowerCase().replace(/[\s\-]+/g, '_');
        return n !== 'confidence' && !/_confidence$/.test(n);
      });
      // Pass 1: exact matches only (field name === keyword)
      for (const [target, keywords] of Object.entries(guessMap)) {
        for (const f of mappableFields) {
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
        for (const f of mappableFields) {
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
      return true;
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
      const { findings, errors, warnings, dropped, migrated, migrationNotes } = CsvImport.parseExtractionCsv(
        this.extractionData, this.extractionColumnMap, validIds, this.attributeConfig
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

      // Carry the non-fatal confidence/boolean notes plus the legacy-presence
      // conversion notes onto the summary so the import panel surfaces them.
      summary.confidenceNotes = [...(warnings || []), ...(summary.conversionNotes || [])];
      // Legacy-schema conversions (old attribute names/vocabularies moved to
      // their current home) — informational, the rows import normally.
      summary.legacyMigrated = migrated || 0;
      summary.migrationNotes = migrationNotes || [];
      this.extractionFindings = summary.valid;
      this.extractionErrors = errors;
      // Rows set aside before validation (missing identity fields, or a
      // record_id that isn't among the loaded reports) — surfaced in the
      // panel and included in the error CSV so no input row vanishes from
      // the accounting.
      this.extractionDropped = dropped || [];
      // The fix-it prompt needs report text; cache the map built above so the
      // copy handler stays synchronous (an IndexedDB read between the click
      // and navigator.clipboard.writeText expires the user-activation window
      // and the browser rejects the write).
      this._fixItReports = reportsById;
      this.extractionValidationSummary = summary;
    },

    // Plain-language rollup of the rows set aside before validation.
    // Null when nothing was dropped.
    get extractionDropSummary() {
      const dropped = this.extractionDropped || [];
      if (!dropped.length) return null;
      const unknownIds = [...new Set(
        dropped.filter(d => (d._drop_reason || '').includes('not among')).map(d => d.record_id)
      )];
      const missing = dropped.length - dropped.filter(d => (d._drop_reason || '').includes('not among')).length;
      return { count: dropped.length, unknownIds, missing };
    },

    // Invalid rows carrying a closest-sentence suggestion (D4), for the
    // validation panel's "Use this sentence" list. Never includes a
    // crossAttributed row — validateExtractionRows already omits the
    // suggestion there.
    get extractionSuggestibleRows() {
      const invalid = (this.extractionValidationSummary && this.extractionValidationSummary.invalid) || [];
      const rows = [];
      invalid.forEach((f, invalidIdx) => {
        const err = (f._validation_errors || []).find(e => e.suggestion);
        if (err) rows.push({ invalidIdx, record_id: f.record_id, finding_name: f.finding_name, source_text: f.source_text, suggestion: err.suggestion });
      });
      return rows;
    },

    // D4 coverage summary: how many of the LOADED reports this extraction
    // file even attempted (valid or invalid — a rejected row still counts
    // as an attempt). Informational, non-blocking — the signal for a
    // silently partial extraction (the AI skipped some reports, or its
    // reply got cut off before reaching them), which nothing else in the
    // validation panel would otherwise surface.
    get extractionCoverage() {
      const summary = this.extractionValidationSummary;
      if (!summary) return { covered: 0, total: 0, uncoveredIds: [] };
      const attempted = new Set([...summary.valid, ...summary.invalid].map(f => f.record_id));
      const uncoveredIds = this.recordIds.filter(id => !attempted.has(id));
      return { covered: this.recordIds.length - uncoveredIds.length, total: this.recordIds.length, uncoveredIds };
    },

    /**
     * "Use this sentence" button: fixes the row's source_text to the
     * suggested sentence, re-validates just that row's source_text/enum
     * checks are otherwise satisfied, review-flags it (_needsReview,
     * mirroring the legacy-indeterminate _polarityReview pattern), and — if
     * that was its only problem — promotes it from invalid to valid so it's
     * included in the import.
     */
    applySentenceSuggestion(invalidIdx) {
      const summary = this.extractionValidationSummary;
      if (!summary || !summary.invalid[invalidIdx]) return;
      const finding = summary.invalid[invalidIdx];
      const suggestionError = (finding._validation_errors || []).find(e => e.suggestion);
      if (!suggestionError) return;

      finding.source_text = suggestionError.suggestion.sentenceText;
      finding.source_sentence_idx = suggestionError.suggestion.idx;
      finding._needsReview = true;
      finding._validation_errors = finding._validation_errors.filter(e => e !== suggestionError);

      if (finding._validation_errors.length === 0) {
        delete finding._validation_errors;
        summary.invalid.splice(invalidIdx, 1);
        summary.valid.push(finding);
        summary.counts.notInReport = Math.max(0, summary.counts.notInReport - 1);
        summary.counts.ready += 1;
      }
      // Keep the flattened valid-findings list (what Step 2 / import actually
      // consumes) in sync with the summary it's derived from.
      this.extractionFindings = summary.valid;
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
        const rf = (report && report.findings) || [];
        if (rf.some(f => f.status === 'pending')) {
          this.extractionReportsWithExisting.push(rid);
        }
        if (rf.some(f => f.status === 'validated')) {
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
      const dropped = this.extractionDropped || [];
      if ((!summary || !summary.invalid?.length) && !dropped.length) {
        this.showToast('No invalid rows to export.', 'info');
        return;
      }
      const rows = ((summary && summary.invalid) || []).map(f => {
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
      // Rows set aside before validation belong in the same accounting.
      for (const d of dropped) {
        rows.push({
          record_id: d.record_id || '',
          finding_name: d.finding_name || '',
          source_text: d.source_text || '',
          _validation_error: d._drop_reason || '',
        });
      }
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

    /**
     * D4 fix-it prompt: packages the rejected rows into a self-contained
     * message a fresh LLM chat (no memory of the original extraction
     * prompt) can act on — each rejected row + its error, a minimal
     * contract restatement (required fields + the enum vocabularies the
     * errors actually reference), and the verbatim FINDINGS text of every
     * affected report (required so the LLM can re-quote correctly). Asks
     * for ONLY the corrected rows, as a bare JSON array. Re-uploading that
     * reply uses the default 'add' merge mode, so it layers onto whatever
     * already imported cleanly rather than replacing it.
     *
     * Synchronous by design: report text comes from the _fixItReports cache
     * stashed at validation time. An async read here (IndexedDB) would sit
     * between the user's click and navigator.clipboard.writeText, expiring
     * the user-activation window — the browser then rejects the write.
     */
    buildFixItPromptText() {
      const summary = this.extractionValidationSummary;
      if (!summary || !summary.invalid || summary.invalid.length === 0) return '';

      const lines = [];
      lines.push(
        'The following rows were rejected when importing into a radiology-report '
        + 'annotation tool. Fix ONLY these rows and reply with just the corrected '
        + 'rows as a bare JSON array (no commentary, no markdown fencing) — do not '
        + 're-emit rows that already succeeded.'
      );
      lines.push('');
      lines.push(
        `REQUIRED fields on every finding object: record_id, finding_name, `
        + `presence (${Schema.presenceValues().map(v => `"${v}"`).join(' | ')}), `
        + `source_text (a verbatim sentence from the FINDINGS text below).`
      );

      // Relevant enum vocabularies: dedupe the attribute keys the rejected
      // rows' own bad-enum errors named (validateExtractionRows attaches
      // `field` directly — no need to parse it back out of the message),
      // and restate their allowed values once.
      const enumKeys = new Set();
      for (const f of summary.invalid) {
        for (const err of f._validation_errors || []) {
          if (err.field) enumKeys.add(err.field);
        }
      }
      if (enumKeys.size) {
        lines.push('');
        lines.push('Allowed values for the attributes flagged below:');
        for (const key of enumKeys) {
          const cfg = this.attributeConfig[key];
          if (cfg && Array.isArray(cfg.values) && cfg.values.length) {
            lines.push(`  ${key}: ${cfg.values.map(v => `"${v}"`).join(' | ')}`);
          }
        }
      }

      lines.push('');
      lines.push('ROWS TO FIX:');
      for (const f of summary.invalid) {
        const errText = (f._validation_errors || []).map(e => `${e.msg} → ${e.fix}`).join('; ');
        lines.push(`- record_id=${f.record_id} finding_name=${f.finding_name} source_text="${f.source_text}": ${errText}`);
      }

      const reportsById = this._fixItReports || {};
      const recordIds = [...new Set(summary.invalid.map(f => f.record_id))];
      lines.push('');
      lines.push('FINDINGS text of the affected report(s), for verbatim quoting:');
      for (const rid of recordIds) {
        lines.push(`--- ${rid} ---`);
        lines.push(((reportsById[rid] || {}).sentences || []).join(' '));
      }

      return lines.join('\n');
    },

    copyFixItPrompt() {
      const text = this.buildFixItPromptText();
      if (!text) {
        this.showToast('No rejected rows to fix.', 'info');
        return;
      }
      this._copyText(text, 'Fix-it prompt copied — paste it into a fresh chat.');
    },

    // Copy text to the clipboard from inside a click handler. Tries the
    // async clipboard API first (writeText must be INVOKED while the click's
    // user activation is still live — do no awaits before it); falls back to
    // a hidden-textarea execCommand copy for contexts where the API is
    // unavailable or refuses.
    async _copyText(text, successMsg) {
      try {
        await navigator.clipboard.writeText(text);
        this.showToast(successMsg, 'success');
        return;
      } catch { /* fall through to execCommand */ }
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (!ok) throw new Error('execCommand refused');
        this.showToast(successMsg, 'success');
      } catch {
        this.showToast('Could not copy to the clipboard', 'error');
      }
    },

    // Helper: find by exact name or synonym (no fuzzy). Delegates to the
    // taxonomy module's separator-folding matcher so "exact" means the same
    // thing here as in every other matching path.
    _findByExactOrSynonym(findingName) {
      return Taxonomy.findByExactOrSynonym(findingName, this.taxonomy);
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
        if (r.error === 'out_of_scope') {
          return `in ${recordId} but outside the FINDINGS section`;
        }
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
      let keptPending = 0;
      for (const [recordId, findings] of Object.entries(byRecord)) {
        const report = await Storage.loadReport(recordId);
        if (!report) continue;

        // Split the unified findings[] by status. Validated findings are the
        // merge targets (kept + attribute-filled in place); rejected findings
        // are preserved untouched. Old pending rows are kept alongside the
        // new import in 'add' mode (the default); 'replace' mode reproduces
        // the old supersede-on-reimport behavior and drops them.
        const existingFindings = report.findings || [];
        const existingValidated = existingFindings.filter(f => f.status === 'validated');
        const existingRejected = existingFindings.filter(f => f.status === 'rejected');
        const existingPending = this.extractionMergeMode === 'add'
          ? existingFindings.filter(f => f.status === 'pending')
          : [];
        keptPending += existingPending.length;
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
            const r = Sentences.matchSourceToSentence(
              f.source_text, report.sentences, recordId, allReports, report.report_text || '');
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
            const newlyFilledAxes = [];
            for (const [k, v] of Object.entries(incomingAttrs)) {
              const cur = existing.attributes[k];
              const isEmpty = cur == null || cur === '' || (Array.isArray(cur) && cur.length === 0);
              if (isEmpty && v != null && v !== '') {
                existing.attributes[k] = v;
                newlyFilledAxes.push(k);
                changed = true;
              }
            }
            // Carry incoming hedges, but ONLY for axes this merge actually
            // filled — a hedge only ever accompanies a value the merge accepted.
            // Never hedge an axis the annotator already had a value for (that
            // would silently turn a definite local annotation into a hedged one
            // on re-import).
            const incomingConf = f.confidence || {};
            for (const axis of newlyFilledAxes) {
              if (incomingConf[axis] === 'hedged') {
                existing.confidence = existing.confidence || {};
                existing.confidence[axis] = 'hedged';
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
            status: 'pending',
            source_sentence_idx: sentenceIdx,
            source_text: f.source_text || '',
            // The validator guarantees a presence value (converting a legacy
            // 'indeterminate' alias), so no default is needed here.
            attributes: f.attributes || {},
          };
          // Carry the hedge map onto the pending extraction (only when non-empty),
          // mirroring how attributes are carried, so it survives to acceptFinding.
          if (f.confidence && Object.keys(f.confidence).length) ext.confidence = f.confidence;
          // A validator-converted 'indeterminate' carries a polarity-review flag.
          if (f._polarityReview) ext._polarityReview = true;
          // A closest-sentence-suggestion fix (D4) carries a review flag too —
          // the annotator should double-check the auto-matched sentence.
          if (f._needsReview) ext._needsReview = true;
          if (matchError) ext._matchError = matchError;
          newExtractions.push(ext);
          addedPending++;
          imported++;
        }

        // Reassemble the unified findings[]: validated (merged in place) +
        // rejected (preserved) always survive; pending is old-plus-new in
        // 'add' mode (existingPending is already [] in 'replace' mode).
        // Re-import never deletes annotator work in either mode.
        report.findings = [...existingValidated, ...existingRejected, ...existingPending, ...newExtractions];

        // Validated status now depends on whether there's any unreviewed
        // pending work — old, new, or both.
        const hasPending = existingPending.length > 0 || newExtractions.length > 0;
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
      this.extractionMergeMode = 'add';

      // Single outcome toast: surface the merge breakdown so the annotator
      // knows what happened to their prior work — silent merge would feel
      // like data loss even when it isn't.
      const breakdown = [];
      if (preserved > 0) breakdown.push(`${preserved} validated preserved`);
      if (mergedAttrs > 0) breakdown.push(`${mergedAttrs} attribute merge${mergedAttrs === 1 ? '' : 's'}`);
      if (keptPending > 0) breakdown.push(`${keptPending} prior pending kept`);
      if (addedPending > 0) breakdown.push(`${addedPending} new pending`);
      const detail = breakdown.length ? ` (${breakdown.join(', ')})` : '';
      // Import summaries persist until acknowledged (banner, not toast).
      this.showNotice(`Imported ${imported} findings into ${Object.keys(byRecord).length} reports${detail}.`);
      this.extractionsImported = true;
      // The import panel handles one file at a time — chain the next queued
      // extraction (multi-extraction drops) now that this one is committed.
      await this._runQueuedExtractions();
    },

    // --- Session Export/Import ---

    async exportSession() {
      const reports = await Storage.exportAllReports();
      // v2 carries the full taxonomyMeta record (incl. its original loadedAt) so
      // the session restores on a clean machine with working taxonomy search and
      // stable taxonomyVersion provenance.
      const taxonomy = await Storage.loadTaxonomy();
      const session = {
        version: 2,
        created_at: new Date().toISOString(),
        taxonomy: taxonomy || null,
        reports,
      };
      // Bundle payloads (.idm data assets) travel with the session so a
      // bundle-governed session restores intact on a clean machine. The
      // schema_meta record is local bookkeeping, not a bundle payload.
      const dataAssets = (await Storage.listDataAssets()).filter(a => a.name !== 'schema_meta');
      if (dataAssets.length) session.data_assets = dataAssets;
      this._downloadJson(session, `annotation-session-${new Date().toISOString().slice(0, 10)}.json`);
    },

    async restoreSession(file) {
      if (!file) return false;
      if (file.size > MAX_SESSION_SIZE) {
        this.showToast('Session file exceeds 50 MB limit', 'error');
        return false;
      }
      const text = await file.text();
      let session;
      try {
        session = JSON.parse(text);
      } catch {
        this.showToast('Invalid JSON file', 'error');
        return false;
      }

      if (!session.reports || !session.version) {
        this.showToast('Invalid session format', 'error');
        return false;
      }

      // Accept both formats: array (old client-side) or object keyed by record_id (old server app)
      let reportsArray;
      if (Array.isArray(session.reports)) {
        reportsArray = session.reports;
      } else if (typeof session.reports === 'object') {
        reportsArray = Object.values(session.reports);
      } else {
        this.showToast('Invalid session format', 'error');
        return false;
      }

      // Filter out reports without a valid record_id
      const validReports = reportsArray.filter(r => r && r.record_id);
      const skipped = reportsArray.length - validReports.length;
      if (validReports.length === 0) {
        this.showToast('No valid reports found in session file', 'error');
        return false;
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
        // Backfill validated_at for old sessions: the v4 index on
        // validated_at is the source of truth for "validated", so a legacy
        // validated report without a timestamp must still index.
        if (report.validated && !report.validated_at) {
          report.validated_at = new Date(0).toISOString();
        }
      }

      // Snapshot the CURRENT state before the first write of the restore.
      // Taken any later (e.g. by atomicReplace after the taxonomy/asset
      // swaps below) the safety snapshot would pair the pre-restore reports
      // with the incoming session's taxonomy/schema — undoing the restore
      // would silently put the old reports under the wrong vocabulary.
      await Storage.backupNow('before-restore');

      // A restored session must be governed by ITS OWN attribute schema (or
      // the repo default), never by whatever bundle happened to be loaded
      // before the restore — so drop the existing bundle assets first, then
      // apply the session's own data_assets if it carries any. Without the
      // clear, restoring a plain/older session after using an .idm leaves the
      // old bundle's vocabulary governing the restored corpus.
      try { await Storage.clearBundleAssets(); } catch { /* non-fatal */ }

      // v2 sessions carry the taxonomy — restore it VERBATIM (preserving
      // loadedAt) before the reports, so taxonomyVersion provenance is stable
      // across machines and search works on a clean machine.
      // v2 sessions may carry .idm data assets — restore them before the
      // reports so a bundle-provided attribute schema governs the migration.
      let sessionAttrs = null;
      if (session.version >= 2 && Array.isArray(session.data_assets)) {
        try {
          for (const asset of session.data_assets) {
            if (asset && asset.name) await Storage.saveDataAsset(asset);
          }
          sessionAttrs = session.data_assets.find(a => a && a.name === 'attributes');
        } catch { /* non-fatal — reports still restore below */ }
      }
      if (sessionAttrs && sessionAttrs.payload) {
        this.attributeConfig = sessionAttrs.payload;
        Schema.init(sessionAttrs.payload);
      } else {
        // No bundle schema in this session — the repo default governs.
        await this._resetAttributesToDefault();
      }

      let taxonomyRestored = false;
      if (session.version >= 2 && session.taxonomy && Array.isArray(session.taxonomy.findings)) {
        try {
          await Storage.saveTaxonomyMeta(session.taxonomy);
          const stored = await Storage.loadTaxonomy();
          if (stored) { this.taxonomy = stored.findings; this.examType = stored.examType; taxonomyRestored = true; }
        } catch { /* non-fatal — reports still restore below */ }
      }

      // Atomic clear+import in a single transaction. replaceReports, not
      // atomicReplace: the safety snapshot was already taken above, before
      // the taxonomy/asset swaps.
      try {
        await Storage.replaceReports(validReports);
      } catch (e) {
        this.showToast('Failed to restore session: ' + (e.message || 'unknown error') +
          '. Your previous data was backed up first — you can restore it from the welcome screen.', 'error');
        await this.loadBackups();
        return false;
      }

      // Restored data may predate the current schema (older sentence
      // indices, missing sectionBreaks, two-array findings, etc.). Run the same
      // migration path init uses so the session is current before it loads.
      await this._runMigrationIfNeeded();

      // The restore snapshotted the prior state — keep the recovery list fresh.
      await this.loadBackups();
      await this._loadSession();
      let msg = `Restored ${validReports.length} report(s)`;
      if (skipped > 0) msg += ` (${skipped} invalid entries skipped)`;
      if (taxonomyRestored) {
        this.showToast(`${msg}, including the taxonomy.`, 'success');
      } else if ((this.taxonomy || []).length === 0) {
        // v1 (or a v2 without a taxonomy block) and none loaded: findings search
        // won't work until the user uploads the matching taxonomy CSV.
        this.showToast(`${msg}. This file has no taxonomy — upload the matching taxonomy CSV to search findings.`, 'info');
      } else {
        this.showToast(msg, 'success');
      }
      this.queuedExtractions = [];
      this.extractionsImported = this._reportsContainImportedExtractions(validReports);
      return true;
    },

    async exportCurrentReportJson() {
      if (!this.report) {
        this.showToast('No report loaded to export.', 'info');
        return;
      }
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
      // Loud on an empty store instead of silently downloading `[]` — one of
      // the two closed mechanisms for the unreproduced Chrome "export did
      // nothing" report (the other is the object-URL revoke race below).
      if (reports.length === 0) {
        this.showToast('0 reports found in storage — check Stats → Storage.', 'error');
        return;
      }
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
      // Empty store → loud error (distinct from "reports exist but no findings").
      if (reports.length === 0) {
        this.showToast('0 reports found in storage — check Stats → Storage.', 'error');
        return;
      }
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

    humanizeName(name) {
      if (!name) return '';
      return name.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());
    },

    async handleTaxonomyUpload(file) {
      if (!file) return false;
      if (file.size > MAX_CSV_SIZE) {
        this.showToast('Taxonomy CSV exceeds 10 MB limit', 'error');
        return false;
      }
      const text = await file.text();
      const findings = this._parseTaxonomyCsv(text);
      if (findings.length === 0) {
        this.showToast('No valid findings found in CSV. Expected columns: id, name, category, synonyms', 'error');
        return false;
      }

      // Decide what to do with any loaded reports. Count findings across ALL
      // reports (any status). Shape-agnostic so this survives the findings[]
      // unification (C1): count the single array if present, else the two
      // legacy arrays.
      const findingCount = (r) => Array.isArray(r.findings)
        ? r.findings.length
        : (r.validated_findings || []).length + (r.llm_extractions || []).length;

      const reportCount = await Storage.getReportCount();
      let reports = [];
      let annotationCount = 0;
      if (reportCount > 0) {
        reports = await Storage.exportAllReports();
        annotationCount = reports.reduce((n, r) => n + findingCount(r), 0);
        if (annotationCount > 0) {
          // Annotations exist: snapshot first (so the wipe is recoverable), then
          // confirm. The zero-annotation path below skips both — swapping the
          // taxonomy after uploading the wrong one shouldn't cost the reports.
          await Storage.backupNow('before-taxonomy-switch');
          await this.loadBackups();
          const ok = await this.confirmDialog(
            `Switching taxonomy will clear all ${reportCount} loaded report(s) and their annotations.`,
            'A backup was just taken — you can restore it from the welcome screen. Export your session too for a portable copy.'
          );
          if (!ok) return false;
          await this.clearAllData();
        }
      }

      const examType = deriveExamType(file.name);
      this.taxonomy = findings;
      this.examType = examType;
      await Storage.saveTaxonomy(examType, file.name, findings, false);

      // A plain-CSV taxonomy carries no attribute schema, so any previously
      // loaded .idm bundle's attributes/companion assets must stop governing —
      // otherwise the new taxonomy's findings render under the old bundle's
      // vocabulary. Revert to the repo default. (The annotation>0 path above
      // already did this via clearAllData; re-running is idempotent.)
      await Storage.clearBundleAssets();
      await this._resetAttributesToDefault();

      // Zero-annotation swap kept the reports — restamp their taxonomyVersion to
      // the new taxonomy's examType:loadedAt so exports carry correct provenance
      // (export reads the per-report stamp, not the active taxonomy).
      if (reportCount > 0 && annotationCount === 0) {
        const taxMeta = await Storage.loadTaxonomy();
        const taxonomyVersion = taxMeta ? `${taxMeta.examType}:${taxMeta.loadedAt}` : '';
        for (const r of reports) r.taxonomyVersion = taxonomyVersion;
        await Storage.importReports(reports);
        this.recordIds = await Storage.listReportIds();
        this.totalCount = this.recordIds.length;
      }

      this.showToast(`Loaded ${findings.length} findings for ${examType}`, 'success');
      return true;
    },

    // --- Annotation Stats ---

    async getAnnotationStats() {
      const reports = await Storage.exportAllReports();
      let totalFindings = 0, fromLlm = 0, humanAdded = 0, modified = 0, custom = 0;
      let flaggedFindings = 0, hedgedAxes = 0;
      const customNames = new Set();

      for (const report of reports) {
        for (const f of (report.findings || [])) {
          if (f.status !== 'validated') continue;
          totalFindings++;
          if (f.origin === 'llm') fromLlm++;
          if (f.origin === 'human_added') humanAdded++;
          if (f.was_modified) modified++;
          if (f.is_custom) { custom++; customNames.add(f.finding_name); }
          if (f.flagged) flaggedFindings++;
          hedgedAxes += Object.keys(f.confidence || {}).length;
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
        flagged_reports: reports.filter(r => r.flagged).length,
        flagged_findings: flaggedFindings,
        hedged_axes: hedgedAxes,
        // Distinct custom-finding names — the feedback channel to the
        // workbench taxonomy (repeated customs = missing taxonomy entries).
        custom_finding_names: [...customNames].sort(),
        validation_progress: reports.length > 0
          ? (reports.filter(r => r.validated).length / reports.length)
          : 0,
      };
    },

    async showStats() {
      this._stats = await this.getAnnotationStats();
      this._storageInfo = await Storage.storageInfo();
      window.dispatchEvent(new CustomEvent('open-stats'));
    },

    // Human-readable byte size for the Stats → Storage line. Null → ''.
    formatBytes(n) {
      if (n == null) return '';
      if (n < 1024) return `${n} B`;
      const units = ['KB', 'MB', 'GB'];
      let v = n / 1024, i = 0;
      while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
      return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
    },

    copyCustomFindingNames() {
      const names = (this._stats && this._stats.custom_finding_names) || [];
      this._copyText(names.join('\n'), 'Copied custom finding names');
    },

    async exportStats() {
      const stats = await this.getAnnotationStats();
      this._downloadJson(stats, 'annotation-stats.json');
    },

    // --- Rolling backups (safety-net recovery) ---

    async loadBackups() {
      this.backups = await Storage.listBackups();
    },

    // Restore a snapshot taken before a destructive op. Reloads taxonomy +
    // session so the UI reflects the restored state. The restore itself is
    // backed up first (atomicReplace snapshots), so it's undoable.
    async restoreFromBackup(id) {
      const b = await Storage.restoreBackup(id);
      if (!b) {
        // The clicked entry was pruned since the list was rendered (only the
        // 3 newest snapshots are kept). Nothing was changed — refresh the
        // list so it shows what's actually restorable.
        await this.loadBackups();
        this.showToast('That backup is no longer available — the list has been refreshed with your current backups.', 'error');
        return;
      }
      const stored = await Storage.loadTaxonomy();
      if (stored) { this.taxonomy = stored.findings; this.examType = stored.examType; }
      // The restore swapped the persisted bundle assets to the backup's own —
      // re-init the in-memory schema to match (bundle schema if the backup
      // carried one, else the repo default).
      const restoredAttrs = await Storage.getDataAsset('attributes');
      if (restoredAttrs && restoredAttrs.payload) {
        this.attributeConfig = restoredAttrs.payload;
        Schema.init(restoredAttrs.payload);
      } else {
        await this._resetAttributesToDefault();
      }
      await this._runMigrationIfNeeded();
      await this.loadBackups();
      await this._loadSession();
      this.queuedExtractions = [];
      this.extractionsImported = this._reportsContainImportedExtractions(b.reports || []);
      this.showToast(`Restored ${b.reports?.length || 0} report(s) from a backup.`, 'success');
    },

    // Plain-language timestamp for the backup list ("Jul 3, 12:56 PM").
    formatBackupTime(iso) {
      const d = new Date(iso);
      return isNaN(d) ? iso : d.toLocaleString(undefined, {
        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
      });
    },

    // --- Clear data ---

    async clearAllData() {
      await Storage.clearAllReports();
      // The clear just took a 'before-clear' snapshot (and may have pruned
      // the oldest) — refresh the welcome screen's recovery list so the user
      // lands on entries that actually exist.
      await this.loadBackups();
      // A bundle's persisted attribute schema (and companion assets) must not
      // outlive "delete ALL data" — otherwise the next taxonomy would still be
      // governed by the wiped bundle's vocabulary. Reverts the in-memory Schema
      // to the repo default so the current session reflects the clear too.
      await Storage.clearDataAssets();
      await this._resetAttributesToDefault();
      this.recordIds = [];
      this.totalCount = 0;
      this.validatedCount = 0;
      this.validatedIds = new Set();
      this.report = null;
      this.currentView = 'welcome';
      this._saveFailed = false;
      this._resetSetupProgress();
    },

    async startFresh() {
      await this.clearAllData();
      await Storage.clearTaxonomy();
      this.taxonomy = [];
      this.examType = '';
      this.dropResults = [];
      await this.loadBackups();
      this.showToast('Started fresh. Previous work was backed up first when there was data to preserve.', 'success');
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
      // Annotatable attributes only — presence gets its own explicit column and
      // confidence its own JSON column, so neither metadata key belongs in the
      // per-attribute canonical loop.
      const canonicalKeys = Schema.findingAttributeKeys();

      const makeRow = (f, status) => {
        const attrs = f.attributes || {};
        const idx = f.source_sentence_idx;
        const matchedSentenceText = (idx && idx > 0 && idx <= sentences.length)
          ? Sentences.splitSentenceHeader(sentences[idx - 1])[1]
          : '';

        // Compute section header for the matched sentence by walking
        // sectionBreaks (each entry: { before: sentencesLength, header, sub }).
        // Subheader breaks (empty "Header: none" sections) are skipped — the
        // sentence's own subheader travels in its prefix; this column carries
        // the enclosing large section (HEAD:, CERVICAL SPINE:) only.
        let section = '';
        if (idx && Array.isArray(report.sectionBreaks)) {
          for (const sb of report.sectionBreaks) {
            if (Sentences.isSubBreak(sb)) continue;
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
        // Presence gets its own explicit column (no longer emitted by the
        // canonical loop, which now excludes metadata keys).
        row.presence = attrs.presence || '';
        // Derived 3-class projection for consumers who don't join `confidence`:
        // uncertain := presence hedged, else the raw polarity (row.presence).
        row.presence_3class = (f.confidence && f.confidence.presence === 'hedged')
          ? 'uncertain'
          : row.presence;
        for (const key of canonicalKeys) {
          const val = attrs[key];
          row[key] = Array.isArray(val) ? val.join('; ') : (val || '');
        }
        row.custom_attributes = Object.keys(customAttrs).length
          ? JSON.stringify(customAttrs)
          : '{}';
        // Per-finding hedge map (single JSON column, mirrors custom_attributes:
        // '{}' when no axis is hedged) + per-finding flag.
        row.confidence = Object.keys(f.confidence || {}).length ? JSON.stringify(f.confidence) : '{}';
        row.flagged = f.flagged || false;
        row.flag_reason = f.flag_reason || '';
        row.reject_reason = f.reject_reason || '';
        row.report_validated = report.validated || false;
        row.report_validated_at = report.validated_at || '';
        // Whole-exam flag, repeated per row (like report_validated).
        row.report_flagged = report.flagged || false;
        row.report_flag_reason = report.flag_reason || '';
        return row;
      };

      // One row per finding, status column carrying validated | pending |
      // rejected. Rejected findings are preserved as training signal (a human
      // said "not this"). Validated findings whose source_sentence_idx no longer
      // points at a real sentence (e.g. an impression grade demoted to null by
      // migration) are skipped — no ground-truth anchor, so they'd pollute the
      // export; they stay visible in the Unassigned Validated recovery list.
      for (const f of (report.findings || [])) {
        if (f.status === 'validated') {
          if (!this._isSentenceAnchor(f.source_sentence_idx, sentences.length)) continue;
          rows.push(makeRow(f, 'validated'));
        } else if (f.status === 'pending') {
          rows.push(makeRow(f, 'pending'));
        } else if (f.status === 'rejected') {
          rows.push(makeRow(f, 'rejected'));
        }
      }

      // Flagged report with zero findings — sentinel row. An annotator flags an
      // exam precisely because it was un-annotatable (wrong heading, mismap),
      // which commonly means no validated findings; without this the exam flag
      // would silently drop from the training CSV for exactly those exams. Emit
      // one row carrying the report-level fields, all finding columns blank, so
      // the CSV schema stays stable and the flag survives.
      if (rows.length === 0 && report.flagged) {
        // makeRow with an empty finding blanks every finding column and derives
        // custom_attributes/confidence/flagged and the report-level fields from
        // report.flagged (true here) — so the sentinel stays in lockstep with the
        // row schema instead of re-listing every column by hand. finding_name is
        // the one field makeRow doesn't default, so pass it explicitly blank.
        rows.push(makeRow({ finding_name: '' }, 'report_flagged'));
      }
      return rows;
    },

    async _saveCurrentReport() {
      if (!this.report) return;
      // Strip Alpine reactive proxies before IndexedDB storage
      const plainStr = JSON.stringify(this.report);
      const plain = JSON.parse(plainStr);
      const rid = plain.record_id;
      try {
        await Storage.savePlainReport(plain);
      } catch (e) {
        // A real save failure is the only unload hazard: warn on close so the
        // user can export before losing this edit.
        this._saveFailed = true;
        this.showToast(`Could not save changes: ${e?.name || 'error'}. Export your session to preserve edits.`, 'error');
        return;
      }
      // Success: every action auto-saves, so a clean save clears any prior
      // failure flag — closing the tab is genuinely safe again.
      this._saveFailed = false;
      // Undo bookkeeping: the state this write replaced becomes undoable;
      // any new mutation invalidates the single-level redo.
      const prior = this._lastSavedState[rid];
      if (prior && prior !== plainStr) {
        UndoRing.push(this._undo[rid] ||= [], prior);
        delete this._redo[rid];
      }
      this._lastSavedState[rid] = plainStr;
    },

    _downloadJson(data, filename) {
      // Strip transient runtime annotations (_matchError, _globalIdx,
      // _validation_errors, ...) — recomputed on load, not part of the export
      // contract. KEEP the review flags: _needsReview / _polarityReview are set
      // at migration, persisted, and NOT recomputable after export (a restored
      // report is already at the current schema, so migration won't re-derive
      // them). Stripping them would silently drop the "review this" signal
      // across a session round-trip.
      const KEEP = new Set(['_needsReview', '_polarityReview']);
      const json = JSON.stringify(data, (k, v) => (k.startsWith('_') && !KEEP.has(k)) ? undefined : v, 2);
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
      // Revoke after 60s, not 1s: on a slow disk / large export, Chrome can
      // still be reading the blob when a 1s revoke fires, producing a silent
      // zero-byte or failed download. 60s is comfortably past the read.
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    },

    // Tiered display times: quick reassurance reads fast; errors linger.
    showToast(message, type = 'info') {
      const DURATION = { success: 2500, info: 4000, error: 7000 };
      this.toastMessage = message;
      this.toastType = type;
      this.toastVisible = true;
      if (this._toastTimerId) clearTimeout(this._toastTimerId);
      this._toastTimerId = setTimeout(() => { this.toastVisible = false; }, DURATION[type] || 4000);
    },

    dismissToast() {
      if (this._toastTimerId) clearTimeout(this._toastTimerId);
      this._toastTimerId = null;
      this.toastVisible = false;
    },

    // Dismissible notice banner for migration/import summaries.
    showNotice(message) {
      this._notice = message;
    },

    // Styled confirm dialog (replaces native confirm()). Resolves true on
    // confirm, false on cancel. `detail` is an optional reassurance line
    // (e.g. "A backup was just taken — restore it from the welcome screen.").
    confirmDialog(message, detail = '') {
      return new Promise((resolve) => {
        this._confirm = { message, detail, resolve };
      });
    },

    _confirmAnswer(val) {
      const c = this._confirm;
      this._confirm = null;
      if (c) c.resolve(val);
    },

    // --- Attribute helpers ---

    // Attribute rows to render (presence is rendered separately as row 1).
    // Includes empty-valued keys so a just-added or cleared row stays visible
    // (removal is only via removeAttribute), sorted into canonical order
    // (attributeConfig key order), with the per-axis hedge state attached.
    getSetAttributes(finding) {
      const attrs = finding.attributes || {};
      // Canonical order = annotatable-attribute order (excludes presence +
      // confidence metadata). Custom attrs (indexOf === -1) rank last.
      const order = Schema.findingAttributeKeys();
      const rank = k => { const i = order.indexOf(k); return i === -1 ? order.length : i; };
      return Object.keys(attrs)
        .filter(k => k !== 'presence' && k !== 'confidence')
        .sort((a, b) => rank(a) - rank(b))
        .map(k => ({
          key: k,
          value: attrs[k],
          hedged: !!(finding.confidence && finding.confidence[k] === 'hedged'),
        }));
    },

    // Resolved cluster tags for a finding's taxonomy entry (taxonomy.json
    // `clusters`, inherited down parent_id at generation time). Returns null
    // for a custom / unmatched finding — "clusters unknown", which leaves
    // cluster-gated axes ungated rather than hiding them.
    findingClusters(finding) {
      const t = Taxonomy.findByName(finding.finding_name || '', this.taxonomy);
      return t ? (t.clusters || []) : null;
    },

    // The "+ attribute" picker lists only attributes not already present.
    // Filter by KEY PRESENCE (`k in attrs`), not truthiness — otherwise a
    // just-added empty-valued row would still appear here and the same
    // attribute could be added twice.
    getAvailableAttributes(finding) {
      const attrs = finding.attributes || {};
      // findingAttributeKeys already excludes the metadata keys (presence has
      // its own row; confidence is a system-managed per-axis hedge map, not a
      // user-addable attribute). Offer only annotatable attrs not already set,
      // gated per finding: cluster-owned axes (e.g. the device cluster's
      // tip_location/position_status) appear only for findings whose taxonomy
      // entry carries the owning cluster. Already-set values always render in
      // getSetAttributes regardless — the gate governs offering, never display.
      const clusters = this.findingClusters(finding);
      return Schema.findingAttributeKeys()
        .filter(k => !(k in attrs))
        .filter(k => Schema.axisVisibleFor(k, clusters))
        .map(k => ({ key: k, ...this.attributeConfig[k] }));
    },

    // Visible "+ attribute" picker label: the attribute name plus an inline
    // hint of what it holds, derived from attributeConfig so the value lists
    // never drift from the data. Short enums (≤4) list their values; longer
    // ordinal enums show a first→last range; booleans read yes/no; free-text/
    // array attrs read "free text". Makes `extent` discoverable as the home for
    // a qualitative size like "small". Visible text, not a <option title> —
    // option tooltips are unreliable across browsers.
    attrPickerLabel(item) {
      const name = item.key.replace(/_/g, ' ');
      const vals = (Array.isArray(item.values) ? item.values : []).map(v => v.replace(/_/g, ' '));
      // The value hint sits in brackets after the name (a plain em dash between
      // them read as visual clutter). Short enums (≤4) list values; longer
      // ordinal enums show a first→last range; booleans read yes/no.
      if (item.type === 'enum' && vals.length > 0) {
        return vals.length <= 4
          ? `${name} (${vals.join(', ')})`
          : `${name} (${vals[0]} … ${vals[vals.length - 1]})`;
      }
      if (item.type === 'boolean') return `${name} (yes / no)`;
      return `${name} (free text)`;
    },

    // Curated plain-language placeholder per free-text attribute (radiologist-
    // facing, not the ontology `description` which is too long/technical for a
    // 150px field). Generic "type…" fallback for anything uncurated.
    attrPlaceholder(key) {
      const hints = {
        size: 'e.g. 3.2 cm',
        anatomic_site: 'e.g. left lower lobe',
        insertion_site: 'e.g. right internal jugular',
        tip_location: 'e.g. cavoatrial junction',
        features: 'comma-separated: e.g. spiculated, calcified',
      };
      return hints[key] || 'type…';
    },

    formatAttrValue(value) {
      if (Array.isArray(value)) return value.join(', ');
      return String(value);
    },

    // The cycle/dropdown value list for an attribute's hybrid control. Non-empty
    // for enum + boolean attributes (which get the cycle+▾ control), empty for
    // free-text/array attributes (which get a plain <input>). Presence has its
    // own dropdown-only control and isn't routed through here.
    attrCycleValues(key) {
      return Schema.enumValues(key);
    },

    // Presence-driven color classes, keyed on polarity (present=green,
    // absent=orange), with a softer wash for the hedged variants; gray when
    // unset. All take the finding so they can read confidence.presence.
    presenceCellClass(finding) {
      const p = ((finding && finding.attributes) || {}).presence;
      const hedged = !!(finding && finding.confidence && finding.confidence.presence === 'hedged');
      if (p === 'present') return hedged ? 'bg-green-50 text-green-700 border-green-200' : 'bg-green-100 text-green-800 border-green-200';
      if (p === 'absent') return hedged ? 'bg-orange-50 text-orange-700 border-orange-200' : 'bg-orange-100 text-orange-800 border-orange-200';
      return 'bg-gray-100 text-gray-700 border-gray-200';
    },
    // Neutral tint for the edit-card standalone certainty glyph: presence is
    // meant to carry NO color on the card (owner call) — the header carries the
    // presence tint instead. The glyph still conveys certainty by SHAPE (filled
    // disc → present, ring → absent), just in gray.
    presenceCellTintClass(_finding) {
      return 'text-gray-400';
    },
    // Color division of labor (owner-tuned): the card HEADER carries the
    // presence tint (green = present, orange = absent), the presence control
    // itself is neutral (static classes in the template), and the panel wrap +
    // card border stay neutral — one tinted surface per card, no green-on-green
    // stacking against the (neutral) validated panel.
    headerTintClass(finding) {
      const p = ((finding && finding.attributes) || {}).presence;
      if (p === 'present') return 'bg-green-50 border-green-100';
      if (p === 'absent') return 'bg-orange-50 border-orange-100';
      return 'bg-gray-50 border-gray-100';
    },
    cardBorderClass(_finding) {
      return 'border-gray-200';
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

  // Snapshot undo / redo: Ctrl+Z / Ctrl+Shift+Z (Cmd on macOS).
  if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
    e.preventDefault();
    if (e.shiftKey) app.redoLastUndo();
    else app.undoLastChange();
    return;
  }

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
    case 'A': {
      e.preventDefault();
      const target = app.pendingFindings[0] || app.unassignedFindings[0];
      if (target) {
        const wasUnassigned = !target.source_sentence_idx;
        const name = app.humanizeName(target.finding_name);
        app.acceptFinding(target._globalIdx).then(() => {
          // Accepting an unassigned finding silently anchors it to the
          // selected sentence — say where it went.
          if (wasUnassigned && app.selectedSentenceIdx) {
            app.showToast(`Accepted ${name} → sentence ${app.selectedSentenceIdx}`, 'success');
          }
        });
      }
      break;
    }
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
        app.cyclePresence(app.validatedFindings[0]._globalIdx);
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

// beforeunload warning. Fires ONLY on a real save failure (_saveFailed) — every
// action auto-saves, so a normal session has nothing unsaved and closing the tab
// is safe (the guidelines say so).
window.addEventListener('beforeunload', (e) => {
  const app = Alpine.store('app');
  if (app && app._saveFailed) {
    e.preventDefault();
    e.returnValue = '';
  }
});
