const commissionLedgerService = require('../services/commissionLedger.service');

class CommissionLedgerController {
  async logCommission(req, res, next) {
    try {
      const { orderId, sellerId, grossSubtotal, shippingFee, taxAmount, discountAmount, commissionRate, platformCommission, netPayable, allocationId, reason, metadata } = req.body;

      if (!orderId || !sellerId || !platformCommission) {
        return res.status(400).json({ error: 'orderId, sellerId, platformCommission required' });
      }

      const entry = await commissionLedgerService.logCommission(
        orderId,
        sellerId,
        {
          grossSubtotal,
          shippingFee,
          taxAmount,
          discountAmount,
          commissionRate,
          platformCommission,
          netPayable,
          allocationId,
          reason,
          metadata,
        }
      );

      res.status(201).json(entry);
    } catch (err) {
      next(err);
    }
  }

  async getCommissionHistory(req, res, next) {
    try {
      const { sellerId } = req.params;
      const { limit = 50, offset = 0, startDate, endDate } = req.query;

      const history = await commissionLedgerService.getCommissionHistory(sellerId, {
        limit: Math.min(parseInt(limit), 100),
        offset: parseInt(offset),
        startDate,
        endDate,
      });

      res.json({
        sellerId,
        history,
        limit: parseInt(limit),
        offset: parseInt(offset),
      });
    } catch (err) {
      next(err);
    }
  }

  async getTotalCommissionForPeriod(req, res, next) {
    try {
      const { sellerId } = req.params;
      const { startDate, endDate } = req.query;

      const totals = await commissionLedgerService.getTotalCommissionForPeriod(sellerId, {
        startDate,
        endDate,
      });

      res.json(totals);
    } catch (err) {
      next(err);
    }
  }

  async auditCommissions(req, res, next) {
    try {
      const { sellerId } = req.params;
      const { startDate, endDate } = req.query;

      const audit = await commissionLedgerService.auditCommissions(sellerId, {
        startDate,
        endDate,
      });

      res.json(audit);
    } catch (err) {
      next(err);
    }
  }

  async getCommissionByReason(req, res, next) {
    try {
      const { sellerId } = req.params;

      const breakdown = await commissionLedgerService.getCommissionByReason(sellerId);

      res.json({
        sellerId,
        breakdown,
      });
    } catch (err) {
      next(err);
    }
  }
}

module.exports = new CommissionLedgerController();
