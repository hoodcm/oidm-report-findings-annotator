/**
 * Dexie.js IndexedDB storage layer for report data.
 */

const db = new Dexie('AnnotationDB');

db.version(1).stores({
  reports: 'record_id'
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
  }
};

window.Storage = Storage;
