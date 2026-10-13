/**
 * Report generation and export service
 * CSV, PDF export and scheduled reports
 */

const json2csv = require('json2csv').parse;
const fs = require('fs').promises;
const path = require('path');

class ReportService {
  constructor(reportsDir = './reports') {
    this.reportsDir = reportsDir;
  }

  /**
   * Generate and export CSV report
   */
  async exportToCSV(data, filename) {
    try {
      const csv = json2csv(data);
      const filepath = path.join(this.reportsDir, `${filename}.csv`);
      await fs.writeFile(filepath, csv);
      return { success: true, filepath, filename: `${filename}.csv` };
    } catch (error) {
      throw new Error(`CSV export failed: ${error.message}`);
    }
  }

  /**
   * Generate PDF report (JSON format for now, integrate with pdfkit if needed)
   */
  async exportToPDF(data, title, filename) {
    try {
      const report = {
        title,
        generatedAt: new Date(),
        data
      };

      const filepath = path.join(this.reportsDir, `${filename}.json`);
      await fs.writeFile(filepath, JSON.stringify(report, null, 2));
      return { success: true, filepath, filename: `${filename}.json` };
    } catch (error) {
      throw new Error(`PDF export failed: ${error.message}`);
    }
  }

  /**
   * Create scheduled report template
   */
  createScheduledReport(config) {
    return {
      id: this._generateId(),
      name: config.name,
      type: config.type, // daily, weekly, monthly
      schedule: this._parseSchedule(config.type),
      metrics: config.metrics || ['revenue', 'orders', 'sellers'],
      recipients: config.recipients,
      format: config.format || 'csv', // csv, pdf, email
      active: true,
      createdAt: new Date(),
      nextRun: this._calculateNextRun(config.type)
    };
  }

  /**
   * Execute scheduled report
   */
  async executeScheduledReport(report, analyticsData) {
    const filename = `${report.name}-${Date.now()}`;

    let result;
    if (report.format === 'csv') {
      result = await this.exportToCSV(analyticsData, filename);
    } else if (report.format === 'pdf') {
      result = await this.exportToPDF(analyticsData, report.name, filename);
    }

    return {
      reportId: report.id,
      filename: result.filename,
      generatedAt: new Date(),
      recipients: report.recipients,
      status: 'COMPLETED'
    };
  }

  /**
   * Get report history
   */
  async getReportHistory(days = 30) {
    try {
      const files = await fs.readdir(this.reportsDir);
      const reports = [];

      for (const file of files) {
        const stats = await fs.stat(path.join(this.reportsDir, file));
        const ageMs = Date.now() - stats.mtime.getTime();
        const ageDays = ageMs / (1000 * 60 * 60 * 24);

        if (ageDays <= days) {
          reports.push({
            filename: file,
            generatedAt: stats.mtime,
            size: stats.size
          });
        }
      }

      return reports.sort((a, b) => b.generatedAt - a.generatedAt);
    } catch (error) {
      return [];
    }
  }

  // Helpers

  _generateId() {
    return `report-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  _parseSchedule(type) {
    const schedules = {
      'daily': '0 6 * * *', // 6 AM daily
      'weekly': '0 6 * * 1', // 6 AM Monday
      'monthly': '0 6 1 * *' // 6 AM first day of month
    };
    return schedules[type];
  }

  _calculateNextRun(type) {
    const now = new Date();
    const next = new Date();

    if (type === 'daily') {
      next.setDate(next.getDate() + 1);
      next.setHours(6, 0, 0, 0);
    } else if (type === 'weekly') {
      const daysUntilMonday = (1 - now.getDay() + 7) % 7;
      next.setDate(next.getDate() + daysUntilMonday);
      next.setHours(6, 0, 0, 0);
    } else if (type === 'monthly') {
      next.setMonth(next.getMonth() + 1);
      next.setDate(1);
      next.setHours(6, 0, 0, 0);
    }

    return next;
  }
}

module.exports = ReportService;
