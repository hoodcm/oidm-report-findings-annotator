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

const Storage = {
  async saveReport(report) {
    await db.reports.put(report);
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
    await db.reports.bulkPut(reports);
  },

  async getReportCount() {
    return await db.reports.count();
  },

  async atomicReplace(reports) {
    await db.transaction('rw', db.reports, async () => {
      await db.reports.clear();
      await db.reports.bulkPut(reports);
    });
  },

  // --- Taxonomy persistence ---

  async saveTaxonomy(examType, filename, findings, isDefault) {
    await db.taxonomyMeta.put({
      id: 1,
      examType,
      sourceFilename: filename,
      isDefault,
      findings,
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
