const paymentLedgerService = require('../services/paymentLedger.service');

class PaymentLedgerController {
  async logPaymentChange(req, res, next) {
    try {
      const { paymentId, oldStatus, newStatus, reason, transactionId, providerResponse } = req.body;

      if (!paymentId || !oldStatus || !newStatus) {
        return res.status(400).json({ error: 'paymentId, oldStatus, newStatus required' });
      }

      const entry = await paymentLedgerService.logPaymentChange(
        paymentId,
        oldStatus,
        newStatus,
        {
          userId: req.user?.id,
          reason,
          transactionId,
          providerResponse,
        }
      );

      res.status(201).json(entry);
    } catch (err) {
      next(err);
    }
  }

  async getPaymentHistory(req, res, next) {
    try {
      const { paymentId } = req.params;
      const { limit = 50, offset = 0 } = req.query;

      const history = await paymentLedgerService.getPaymentHistory(paymentId, {
        limit: Math.min(parseInt(limit), 100),
        offset: parseInt(offset),
      });

      res.json({
        paymentId,
        history,
        limit: parseInt(limit),
        offset: parseInt(offset),
      });
    } catch (err) {
      next(err);
    }
  }

  async auditPayment(req, res, next) {
    try {
      const { paymentId } = req.params;

      const audit = await paymentLedgerService.auditPayment(paymentId);

      res.json(audit);
    } catch (err) {
      next(err);
    }
  }

  async getFailedPayments(req, res, next) {
    try {
      const { days = 7, limit = 50, offset = 0 } = req.query;

      const failed = await paymentLedgerService.getFailedPayments({
        days: parseInt(days),
        limit: Math.min(parseInt(limit), 100),
        offset: parseInt(offset),
      });

      res.json({
        failed,
        total: failed.length,
      });
    } catch (err) {
      next(err);
    }
  }

  async getLedgerStats(req, res, next) {
    try {
      const { startDate, endDate } = req.query;

      const stats = await paymentLedgerService.getLedgerStats({
        startDate,
        endDate,
      });

      res.json(stats);
    } catch (err) {
      next(err);
    }
  }
}

module.exports = new PaymentLedgerController();
