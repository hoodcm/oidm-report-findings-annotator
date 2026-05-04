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

const Storage = {
  async saveReport(report) {
    await db.reports.put(plain(report));
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

  async getProgress() {
    const all = await db.reports.toArray();
    const total = all.length;
    const validated = all.filter(r => r.validated).length;
    return { validated, total };
  },

  async getValidatedIds() {
    const all = await db.reports.toArray();
    return all.filter(r => r.validated).map(r => r.record_id);
  },

  async clearAllReports() {
    await db.reports.clear();
  },

  async exportAllReports() {
    return await db.reports.toArray();
  },

  async importReports(reports) {
    await db.reports.bulkPut(reports.map(plain));
  },

  async getReportCount() {
    return await db.reports.count();
  },

  async atomicReplace(reports) {
    const cloned = reports.map(plain);
    await db.transaction('rw', db.reports, async () => {
      await db.reports.clear();
      await db.reports.bulkPut(cloned);
    });
  },

  // --- Taxonomy persistence ---

  async saveTaxonomy(examType, filename, findings, isDefault) {
    await db.taxonomyMeta.put({
      id: 1,
      examType,
      sourceFilename: filename,
      isDefault,
      findings: plain(findings),
      loadedAt: Date.now()
    });
  },

  async loadTaxonomy() {
    return await db.taxonomyMeta.get(1) || null;
  },

  async clearTaxonomy() {
    await db.taxonomyMeta.clear();
  }
};

window.Storage = Storage;
