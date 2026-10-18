const orderExportService = require('../services/orderExport.service');

class OrderExportController {
  async exportCSV(req, res) {
    try {
      const filters = req.query;
      const result = await orderExportService.exportOrdersAsCSV(filters);

      res.setHeader('Content-Type', result.mimeType);
      res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
      res.send(result.content);
    } catch (err) {
      res.status(err.statusCode || 500).json({ success: false, message: err.message });
    }
  }

  async exportPDF(req, res) {
    try {
      const filters = req.query;
      const result = await orderExportService.exportOrdersAsPDF(filters);

      res.setHeader('Content-Type', result.mimeType);
      res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
      res.json({ success: true, data: result.data });
    } catch (err) {
      res.status(err.statusCode || 500).json({ success: false, message: err.message });
    }
  }

  async exportJSON(req, res) {
    try {
      const { orderId } = req.params;
      const result = await orderExportService.exportSingleOrderAsJSON(orderId);

      res.setHeader('Content-Type', result.mimeType);
      res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
      res.send(result.content);
    } catch (err) {
      res.status(err.statusCode || 500).json({ success: false, message: err.message });
    }
  }
}

module.exports = new OrderExportController();
