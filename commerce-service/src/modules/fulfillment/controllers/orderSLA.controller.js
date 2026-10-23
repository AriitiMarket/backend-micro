const orderSLAService = require('../services/orderSLA.service');
const { isAdmin } = require('../../../shared/utils/roles');

class OrderSLAController {
  async setSLA(req, res) {
    try {
      const { orderId, stateName, durationHours } = req.body;
      const userId = req.user?.id || req.user?._id;

      const result = await orderSLAService.setSLA(
        orderId,
        stateName,
        durationHours,
        { userId, actor: req.user }
      );
      res.status(201).json({ success: true, data: result });
    } catch (err) {
      res.status(err.statusCode || 500).json({ success: false, message: err.message });
    }
  }

  /**
   * PUSH IN a breach against an order.
   *
   * Body: { orderId, reason, stateName?, durationHours?, deadline? }
   */
  async createBreach(req, res) {
    try {
      const { orderId, reason, stateName, durationHours, deadline } = req.body || {};
      const userId = req.user?.id || req.user?._id;

      if (!orderId) {
        return res.status(400).json({
          success: false,
          message: 'orderId is required',
        });
      }

      const result = await orderSLAService.createBreach(
        orderId,
        { reason, stateName, durationHours, deadline },
        { userId, actor: req.user }
      );
      res.status(201).json({ success: true, data: result });
    } catch (err) {
      res.status(err.statusCode || 500).json({ success: false, message: err.message });
    }
  }

  async checkCompliance(req, res) {
    try {
      const { orderId } = req.params;
      const result = await orderSLAService.checkSLACompliance(orderId, {
        actor: req.user,
      });
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      res.status(err.statusCode || 500).json({ success: false, message: err.message });
    }
  }

  async getStatus(req, res) {
    try {
      const { orderId } = req.params;
      const result = await orderSLAService.getSLAStatus(orderId, {
        actor: req.user,
      });
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      res.status(err.statusCode || 500).json({ success: false, message: err.message });
    }
  }

  async getBreaches(req, res) {
    try {
      const userId = req.user?.id || req.user?._id;
      const { period, limit, skip } = req.query;

      // An admin sees the whole platform; a seller sees only the breaches on
      // their OWN orders. The seller id used to be read from `req.user._id`,
      // which the gateway never sets (it sets `id`), so the scope was always
      // undefined and every caller saw every seller's breaches.
      const result = await orderSLAService.getSLABreaches(userId, period, {
        scopeToSeller: !isAdmin(req.user),
        limit: Number(limit) || 0,
        skip: Number(skip) || 0,
      });
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      res.status(err.statusCode || 500).json({ success: false, message: err.message });
    }
  }
}

module.exports = new OrderSLAController();
