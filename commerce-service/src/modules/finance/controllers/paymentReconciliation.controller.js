const paymentReconciliationService = require('../services/paymentReconciliation.service');

class PaymentReconciliationController {
  async reconcile(req, res) {
    try {
      const { provider, transactions } = req.body;
      const result = await paymentReconciliationService.reconcileWithProvider(provider, transactions);
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      res.status(err.statusCode || 500).json({ success: false, message: err.message });
    }
  }

  async getReport(req, res) {
    try {
      const { period } = req.query;
      const result = await paymentReconciliationService.getReconciliationReport(period);
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      res.status(err.statusCode || 500).json({ success: false, message: err.message });
    }
  }

  async flagDiscrepancy(req, res) {
    try {
      const { paymentId, reason } = req.body;
      const result = await paymentReconciliationService.flagDiscrepancy(paymentId, reason);
      res.status(201).json({ success: true, data: result });
    } catch (err) {
      res.status(err.statusCode || 500).json({ success: false, message: err.message });
    }
  }

  async resolveDiscrepancy(req, res) {
    try {
      const { paymentId, action } = req.body;
      const result = await paymentReconciliationService.resolveDiscrepancy(paymentId, action);
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      res.status(err.statusCode || 500).json({ success: false, message: err.message });
    }
  }
}

module.exports = new PaymentReconciliationController();
