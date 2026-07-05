/**
 * Dexie.js IndexedDB storage layer for report data.
 */

const db = new Dexie('AnnotationDB');

db.version(1).stores({
  reports: 'record_id'
});

db.version(2).stores({
  reports: 'record_id',
  taxonomyMeta: 'id'
});

// v3: rolling safety-net backups. A snapshot (all reports + the taxonomy meta)
// is taken before every destructive replace/clear so an accidental wipe or a
// bad restore is recoverable. Only the last 3 are kept.
db.version(3).stores({
  reports: 'record_id',
  taxonomyMeta: 'id',
  backups: '++id, created_at'
});

// v4: (a) validated_at index on reports — validated IDs come straight off the
// index (records with a null/undefined validated_at are simply absent from
// it, which is exactly the unvalidated set), so init no longer scans the
// corpus; (b) dataAssets — payloads carried by an .idm bundle (attribute
// definitions, normality mappings, actionability rules, and any entries a
// newer workbench ships that this version doesn't consume), keyed by name.
db.version(4).stores({
  reports: 'record_id, validated_at',
  taxonomyMeta: 'id',
  backups: '++id, created_at',
  dataAssets: 'name'
}).upgrade(async (tx) => {
  // Backfill validated_at for reports validated BEFORE this field existed
  // (pre-v4 the app stored only `validated: true`). The v4 index is now the
  // sole source of truth for "validated" — a record with no validated_at is
  // absent from it — so without this backfill every already-validated report
  // would silently read as unvalidated after the upgrade. The epoch sentinel
  // matches the session-restore backfill in app.js restoreSession().
  await tx.table('reports').toCollection().modify(backfillValidatedAt);
});

// The v4 upgrade's per-report mutation, named + exported (Storage._backfillValidatedAt)
// so the migration contract is unit-testable — a fresh test DB opens straight
// at v4 and never runs the upgrade callback.
function backfillValidatedAt(report) {
  if (report.validated && !report.validated_at) report.validated_at = new Date(0).toISOString();
}

/**
 * Deep-clone for IndexedDB safety. Alpine.js wraps store data in reactive
 * Proxies; passing a Proxy to Dexie's `put` throws DataCloneError because
 * structuredClone can't serialize the Proxy. Stripping via JSON round-trip
 * is fine here because all our stored shapes are plain JSON-compatible
 * data (no Date/Map/Set in the persisted documents).
 */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

// Ask the browser to make IndexedDB persistent (exempt from eviction under
// storage pressure) on the first write of a session. Guarded so the request
// fires once. Best-effort: never throws, and a `false` result (browser
// declined) is fine — the data is still stored, just evictable.
let _persistRequested = false;
async function ensurePersisted() {
  if (_persistRequested) return;
  _persistRequested = true;
  try {
    if (navigator.storage && navigator.storage.persist) {
      await navigator.storage.persist();
    }
  } catch { /* older browsers / denied — non-fatal */ }
}

const Storage = {
  // Internal Dexie handle, exposed for schema-contract tests (index
  // introspection) — not an app-facing API.
  _db: db,

  // The v4 upgrade's per-report backfill, exposed for the migration contract
  // test (the upgrade callback itself can't run against a fresh test DB).
  _backfillValidatedAt: backfillValidatedAt,

  async saveReport(report) {
    await ensurePersisted();
    await db.reports.put(plain(report));
  },

  // Save a report the caller has ALREADY round-tripped to a plain, proxy-free
  // object (e.g. JSON.parse of a serialized snapshot). Skips saveReport's
  // defensive re-clone — one serialization instead of two on the hot per-edit
  // auto-save path, which is what the attribute-cycle click latency was.
  async savePlainReport(plainReport) {
    await ensurePersisted();
    await db.reports.put(plainReport);
  },

  // Persistence + usage snapshot for the Stats overlay's Storage line.
  // { persisted: bool, usage: bytes|null, quota: bytes|null }.
  async storageInfo() {
    let persisted = false;
    let usage = null;
    let quota = null;
    try {
      if (navigator.storage && navigator.storage.persisted) {
        persisted = await navigator.storage.persisted();
      }
      if (navigator.storage && navigator.storage.estimate) {
        const est = await navigator.storage.estimate();
        usage = est.usage ?? null;
        quota = est.quota ?? null;
      }
    } catch { /* non-fatal — overlay just omits the numbers */ }
    return { persisted, usage, quota };
  },

  async loadReport(recordId) {
    return await db.reports.get(recordId) || null;
  },

  async listReportIds() {
    const keys = await db.reports.orderBy('record_id').primaryKeys();
    return keys.sort();
  },

  async deleteReport(recordId) {
    await db.reports.delete(recordId);
  },

  // Validated IDs come straight off the v4 validated_at index: records with
  // a null/undefined validated_at are absent from the index, which is
  // exactly the unvalidated set (the app writes validated + validated_at
  // together). No full-table read — startup cost no longer grows with the
  // corpus.
  async getProgress() {
    const [total, validatedKeys] = await Promise.all([
      db.reports.count(),
      db.reports.orderBy('validated_at').primaryKeys(),
    ]);
    return { validated: validatedKeys.length, total };
  },

  async getValidatedIds() {
    return await db.reports.orderBy('validated_at').primaryKeys();
  },

  async clearAllReports() {
    await this.backupNow('before-clear');
    await db.reports.clear();
    // The recorded ID-column name (used to inject a real column name into
    // the LLM extraction prompt) is meaningless once there's no corpus.
    await db.dataAssets.delete('corpus_id_column');
  },

  // --- Rolling backups (safety net) ---

  // Snapshot current reports + taxonomy into the backups table, then prune to
  // the newest 3. No-ops when there is nothing to preserve (empty DB), so an
  // initial upload doesn't leave an empty snapshot. Never throws on the write
  // path's behalf — a backup failure must not block the primary operation.
  async backupNow(label) {
    const reports = await db.reports.toArray();
    const taxonomyMeta = (await db.taxonomyMeta.get(1)) || null;
    if (reports.length === 0 && !taxonomyMeta) return null;
    // Bundle assets ride along (minus the reserved schema_meta): a
    // bundle-governed session restored without its attribute schema would be
    // re-annotated under the wrong vocabulary.
    const dataAssets = (await db.dataAssets.toArray()).filter(a => a.name !== 'schema_meta');
    const created_at = new Date().toISOString();
    const id = await db.backups.add({ created_at, label: label || '', reports, taxonomyMeta, dataAssets });
    // Prune by primary key (monotonic ++id) so same-millisecond snapshots order
    // deterministically. Keep the 3 highest ids.
    const ids = await db.backups.orderBy('id').primaryKeys();
    if (ids.length > 3) await db.backups.bulkDelete(ids.slice(0, ids.length - 3));
    return id;
  },

  // Light metadata for the welcome recovery list (no heavy report bodies),
  // newest first.
  async listBackups() {
    const all = await db.backups.orderBy('id').reverse().toArray();
    return all.map(b => ({
      id: b.id,
      created_at: b.created_at,
      label: b.label || '',
      report_count: (b.reports || []).length,
      taxonomy: b.taxonomyMeta ? b.taxonomyMeta.examType : null,
    }));
  },

  // Restore a snapshot: put its taxonomy back (verbatim, preserving loadedAt),
  // then atomically replace reports. atomicReplace snapshots the pre-restore
  // state first, so restoring is itself undoable. Returns the backup or null.
  async restoreBackup(id) {
    const b = await db.backups.get(id);
    if (!b) return null;
    if (b.taxonomyMeta) await db.taxonomyMeta.put(plain(b.taxonomyMeta));
    // The restored corpus is governed by the assets captured WITH it — not by
    // whatever bundle is loaded now. Older backups carry no dataAssets array;
    // for those the clear alone is right (repo default governs).
    await this.clearBundleAssets();
    for (const asset of (b.dataAssets || [])) {
      if (asset && asset.name) await db.dataAssets.put(plain(asset));
    }
    // A backup taken before v4 can hold validated reports without a
    // validated_at — backfill so they don't drop out of the validated index.
    const reports = (b.reports || []).map(r => {
      const copy = plain(r);
      backfillValidatedAt(copy);
      return copy;
    });
    await this.atomicReplace(reports);
    return b;
  },

  async clearBackups() {
    await db.backups.clear();
  },

  async exportAllReports() {
    return await db.reports.toArray();
  },

  async importReports(reports) {
    await ensurePersisted();
    await db.reports.bulkPut(reports.map(plain));
  },

  async getReportCount() {
    return await db.reports.count();
  },

  async atomicReplace(reports) {
    await ensurePersisted();
    await this.backupNow('before-replace');
    const cloned = reports.map(plain);
    await db.transaction('rw', db.reports, async () => {
      await db.reports.clear();
      await db.reports.bulkPut(cloned);
    });
  },

  // --- Taxonomy persistence ---

  async saveTaxonomy(examType, filename, findings, isDefault) {
    await ensurePersisted();
    await db.taxonomyMeta.put({
      id: 1,
      examType,
      sourceFilename: filename,
      isDefault,
      findings: plain(findings),
      loadedAt: Date.now()
    });
  },

  // Put a taxonomyMeta record VERBATIM (preserving its original loadedAt),
  // unlike saveTaxonomy which mints a fresh loadedAt. Used by the v2 session
  // restore so taxonomyVersion (examType:loadedAt) stays stable across machines.
  async saveTaxonomyMeta(record) {
    await ensurePersisted();
    await db.taxonomyMeta.put({ ...plain(record), id: 1 });
  },

  async loadTaxonomy() {
    const rec = await db.taxonomyMeta.get(1);
    if (!rec) return null;
    // Re-derive examType from sourceFilename on every read so the display
    // label stays in sync with the deriveExamType allowlist (e.g. records
    // saved under an older derivation that produced "Ct Head" now surface
    // as "CT Head" without forcing the user to re-upload the CSV).
    if (rec.sourceFilename && typeof deriveExamType === 'function') {
      rec.examType = deriveExamType(rec.sourceFilename);
    }
    return rec;
  },

  async clearTaxonomy() {
    await db.taxonomyMeta.clear();
  },

  // --- Bundle data assets (.idm payloads) ---

  // An asset is { name, payload, version, source }; `name` is the key
  // ('attributes', 'normality_mappings', ...). Assets ride along with
  // session export/restore so a bundle-governed session moves machines.
  async saveDataAsset(asset) {
    await ensurePersisted();
    await db.dataAssets.put(plain(asset));
  },

  async getDataAsset(name) {
    return await db.dataAssets.get(name) || null;
  },

  async listDataAssets() {
    return await db.dataAssets.toArray();
  },

  async clearDataAssets() {
    await db.dataAssets.clear();
  },

  // Single source of truth for "which attribute schema governs right now":
  // a persisted .idm 'attributes' asset wins over the repo default. Used by
  // both app.js init and the LLM-extractions playbook page, so the playbook
  // never drifts from what the annotator itself would render (D5). Returns
  // null on failure (e.g. the default fetch 404s) rather than throwing —
  // callers decide how to degrade.
  async resolveAttributeConfig(defaultConfigPath) {
    try {
      const persisted = await this.getDataAsset('attributes');
      if (persisted && persisted.payload) return persisted.payload;
      const r = await fetch(defaultConfigPath);
      if (!r.ok) throw new Error('attributes');
      return await r.json();
    } catch {
      return null;
    }
  },

  // Clear bundle-provided assets (attributes + normality/actionability + any
  // forward-compat entries a newer workbench ships) while PRESERVING the
  // reserved 'schema_meta' record init compares, and 'corpus_id_column'
  // (report-corpus metadata, not bundle-governed — a taxonomy swap must not
  // erase which CSV column the loaded reports' record_id came from). Used
  // when the governing data set changes out from under a bundle — a plain
  // taxonomy swap, or loading a new .idm that omits an entry the previous
  // one carried.
  async clearBundleAssets() {
    const RESERVED = new Set(['schema_meta', 'corpus_id_column']);
    const names = await db.dataAssets.orderBy('name').primaryKeys();
    const bundle = names.filter(n => !RESERVED.has(n));
    if (bundle.length) await db.dataAssets.bulkDelete(bundle);
  }
};

window.Storage = Storage;
