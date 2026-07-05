/**
 * .idm bundle reader (Imaging Data Model file).
 *
 * An .idm is a standard zip with a manifest.json at its root — the
 * imaging-findings-workbench's packaging for a taxonomy and its companion
 * data products, so users load one file instead of several. Manifest
 * contract (spec v1, shared with the workbench exporter):
 *
 *   {
 *     "format": "oidm-idm",
 *     "format_version": 1,
 *     "name": "...",                    // human-readable bundle name
 *     "exam_type": "CXR",               // display label for the taxonomy
 *     "generated_by": "...",
 *     "generated_at": "ISO-8601",
 *     "contents": {                     // every entry optional; values are
 *       "taxonomy": "taxonomy.json",    //   file paths inside the zip
 *       "attributes": "attributes.json",
 *       "normality_mappings": "normality-mappings.json",
 *       "actionability_rules": "actionability-rules.json"
 *     }
 *   }
 *
 * Known contents entries are routed to their consumers (taxonomy store,
 * Schema); unknown entries are stored in the dataAssets table, not consumed —
 * a newer workbench can ship more than this version understands without
 * breaking the load. The test producer is tests/fixtures/sample.idm
 * (regenerable via tests/fixtures/make-idm.js) until the workbench exporter
 * exists.
 */

const IdmLoader = {
  FORMAT: 'oidm-idm',
  FORMAT_VERSION: 1,

  /**
   * Validate a parsed manifest object. Pure — returns
   * { ok, errors: [plain-language strings] }; never throws.
   */
  validateManifest(manifest) {
    const errors = [];
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      return { ok: false, errors: ['the bundle\'s manifest.json isn\'t in the expected form'] };
    }
    if (manifest.format !== this.FORMAT) {
      errors.push(`this doesn't look like an imaging data model bundle (format is ${JSON.stringify(manifest.format ?? null)}, expected "${this.FORMAT}")`);
    }
    if (!Number.isInteger(manifest.format_version)) {
      errors.push('the bundle has no format_version number');
    } else if (manifest.format_version > this.FORMAT_VERSION) {
      errors.push(`this bundle was made for a newer version of the tool (bundle version ${manifest.format_version}, this app reads version ${this.FORMAT_VERSION})`);
    } else if (manifest.format_version < 1) {
      errors.push(`format_version ${manifest.format_version} isn't a valid bundle version`);
    }
    if (manifest.contents != null && (typeof manifest.contents !== 'object' || Array.isArray(manifest.contents))) {
      errors.push('the bundle\'s contents list isn\'t in the expected form');
    }
    return { ok: errors.length === 0, errors };
  },

  /**
   * Unzip bundle bytes and validate the manifest. Pure (no storage, no UI) —
   * throws an Error with a plain-language message on any structural problem.
   * Returns { manifest, entries } where entries maps zip paths → Uint8Array.
   */
  parseBundle(bytes) {
    let entries;
    try {
      entries = fflate.unzipSync(bytes);
    } catch {
      throw new Error('the file could not be opened as a bundle (not a readable zip)');
    }
    if (Object.keys(entries).length === 0) {
      throw new Error('the bundle is empty');
    }
    if (!entries['manifest.json']) {
      throw new Error('the bundle has no manifest.json at its root');
    }
    let manifest;
    try {
      manifest = JSON.parse(fflate.strFromU8(entries['manifest.json']));
    } catch {
      throw new Error('the bundle\'s manifest.json could not be read');
    }
    const v = this.validateManifest(manifest);
    if (!v.ok) throw new Error(v.errors.join('; '));
    return { manifest, entries };
  },

  // Read one contents entry as parsed JSON; throws plain-language on problems.
  _readJsonEntry(entries, name, path) {
    const raw = entries[path];
    if (!raw) throw new Error(`the manifest lists ${name} at "${path}" but that file isn't in the bundle`);
    try {
      return JSON.parse(fflate.strFromU8(raw));
    } catch {
      throw new Error(`the bundle's ${name} file could not be read as JSON`);
    }
  },

  // Normalize a bundled taxonomy (JSON array) to the same post-parse shape
  // _parseTaxonomyCsv produces for bare-CSV drops.
  _normalizeTaxonomy(parsed) {
    if (!Array.isArray(parsed)) throw new Error('the bundle\'s taxonomy isn\'t a list of findings');
    const findings = parsed.map(row => ({
      id: row.id,
      name: row.name,
      category: row.category,
      parent_id: row.parent_id || null,
      synonyms: Array.isArray(row.synonyms)
        ? row.synonyms
        : (row.synonyms ? String(row.synonyms).split(',').map(s => s.trim()).filter(Boolean) : []),
      finding_type: row.finding_type || null,
    })).filter(f => f.id && f.name);
    if (findings.length === 0) throw new Error('the bundle\'s taxonomy has no usable findings (each needs an id and a name)');
    return findings;
  },

  /**
   * Load a bundle into the app. `app` is the Alpine store (passed in so this
   * module stays constructible without Alpine). Returns true on success;
   * shows a toast and returns false on failure or user cancel.
   */
  async load(file, app) {
    let manifest, entries;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      ({ manifest, entries } = this.parseBundle(bytes));
    } catch (e) {
      app.showToast(`Couldn't load ${file.name}: ${e.message}`, 'error');
      return false;
    }

    const contents = manifest.contents || {};
    // The provenance stamp both versions share: exam type + when the
    // workbench generated the bundle (falls back to load time).
    const generatedMs = Date.parse(manifest.generated_at) || Date.now();
    const examType = manifest.exam_type || manifest.name || 'Bundle';
    const versionStamp = `${examType}:${generatedMs}`;

    // Parse everything BEFORE touching storage, so a malformed entry can't
    // leave a half-loaded bundle.
    let findings = null, attributeConfig = null;
    const assets = [];
    try {
      if (contents.taxonomy) {
        findings = this._normalizeTaxonomy(this._readJsonEntry(entries, 'taxonomy', contents.taxonomy));
      }
      if (contents.attributes) {
        attributeConfig = this._readJsonEntry(entries, 'attributes', contents.attributes);
      }
      for (const [name, path] of Object.entries(contents)) {
        if (name === 'taxonomy' || name === 'attributes') continue;
        const raw = entries[path];
        if (!raw) throw new Error(`the manifest lists ${name} at "${path}" but that file isn't in the bundle`);
        // Known payloads (normality_mappings, actionability_rules) are JSON;
        // unknown entries are stored as text, unconsumed, for forward compat.
        let payload;
        try {
          payload = JSON.parse(fflate.strFromU8(raw));
        } catch {
          payload = fflate.strFromU8(raw);
        }
        assets.push({ name, payload, version: versionStamp, source: file.name });
      }
    } catch (e) {
      app.showToast(`Couldn't load ${file.name}: ${e.message}`, 'error');
      return false;
    }

    // Same reports-loaded guard as a taxonomy CSV upload: swapping the
    // taxonomy under annotated reports snapshots a backup and asks first;
    // an annotation-free swap keeps the reports (restamped below).
    const findingCount = (r) => Array.isArray(r.findings)
      ? r.findings.length
      : (r.validated_findings || []).length + (r.llm_extractions || []).length;
    const reportCount = await Storage.getReportCount();
    let reports = [];
    let annotationCount = 0;
    if (findings && reportCount > 0) {
      reports = await Storage.exportAllReports();
      annotationCount = reports.reduce((n, r) => n + findingCount(r), 0);
      if (annotationCount > 0) {
        await Storage.backupNow('before-idm-load');
        await app.loadBackups();
        const ok = await app.confirmDialog(
          `Loading this bundle switches the taxonomy, which will clear all ${reportCount} loaded report(s) and their annotations.`,
          'A backup was just taken — you can restore it from the welcome screen. Export your session too for a portable copy.'
        );
        if (!ok) return false;
        await app.clearAllData();
      }
    }

    // Clear the PRIOR bundle's assets before writing this one's, so a bundle
    // that omits an entry the previous one carried doesn't leave stale,
    // mismatched companion data behind (the new taxonomy paired with the old
    // bundle's normality/actionability payloads). Preserves schema_meta. (The
    // annotation>0 path already wiped everything via clearAllData; idempotent.)
    await Storage.clearBundleAssets();

    // Commit, in dependency order.
    const loaded = [];
    if (findings) {
      // saveTaxonomyMeta (verbatim put) rather than saveTaxonomy: the bundle's
      // generated_at is the version stamp, not the local load time, and
      // sourceFilename stays null so loadTaxonomy's filename re-derivation
      // can't overwrite the manifest's exam_type label.
      await Storage.saveTaxonomyMeta({
        examType,
        sourceFilename: null,
        sourceBundle: file.name,
        isDefault: false,
        findings,
        loadedAt: generatedMs,
      });
      app.taxonomy = findings;
      app.examType = examType;
      loaded.push(`taxonomy (${findings.length} findings)`);
    }
    if (attributeConfig) {
      // The bundle's schema — not the repo default — governs the session:
      // persist it so init() restores it on every reload.
      await Storage.saveDataAsset({ name: 'attributes', payload: attributeConfig, version: versionStamp, source: file.name });
      // Warn (not block) when stored findings carry vocabulary the incoming
      // schema doesn't accept — same migration-awareness as any schema change.
      const all = reportCount > 0 && annotationCount > 0 ? [] : await Storage.exportAllReports();
      let offVocab = 0;
      for (const r of all) {
        for (const f of r.findings || []) {
          for (const [k, v] of Object.entries(f.attributes || {})) {
            const cfg = attributeConfig[k];
            if (!cfg || cfg.type !== 'enum') continue;
            const allowed = (cfg.values || []).map(s => String(s).toLowerCase());
            const els = Array.isArray(v) ? v : [v];
            if (els.some(el => el !== '' && el != null && !allowed.includes(String(el).toLowerCase()))) offVocab++;
          }
        }
      }
      Schema.init(attributeConfig);
      app.attributeConfig = attributeConfig;
      loaded.push('attribute definitions');
      if (offVocab > 0) {
        app.showToast(`${offVocab} stored finding(s) use values the bundle's attribute definitions don't include — review them before exporting.`, 'info');
      }
    } else if (findings) {
      // This bundle ships a taxonomy but no attribute definitions, and we just
      // cleared any prior bundle's — so the repo default governs. Re-init the
      // in-memory schema to match (init would do this on the next reload; do it
      // now so the current session is consistent).
      await app._resetAttributesToDefault();
    }
    for (const asset of assets) {
      await Storage.saveDataAsset(asset);
    }
    if (assets.length) loaded.push(`${assets.length} data asset(s)`);

    // Annotation-free swap kept the reports — restamp their provenance to the
    // bundle's taxonomy version (mirrors handleTaxonomyUpload).
    if (findings && reportCount > 0 && annotationCount === 0) {
      for (const r of reports) r.taxonomyVersion = versionStamp;
      await Storage.importReports(reports);
      app.recordIds = await Storage.listReportIds();
      app.totalCount = app.recordIds.length;
    }

    app.showToast(`Loaded ${manifest.name || file.name}: ${loaded.join(', ') || 'no known contents'}`, 'success');
    return true;
  },
};

window.IdmLoader = IdmLoader;
