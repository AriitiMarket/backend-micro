const orderHoldService = require('../services/orderHold.service');

class OrderHoldController {
  async holdOrder(req, res, next) {
    try {
      const userId = req.user?.id || req.user?._id;
      const { orderId, reason, holdByRole } = req.body;

      if (!orderId || !reason) {
        return res.status(400).json({ error: 'orderId and reason required' });
      }

      const hold = await orderHoldService.holdOrder(
        orderId,
        reason,
        holdByRole || 'ADMIN',
        userId
      );

      res.status(201).json(hold);
    } catch (err) {
      next(err);
    }
  }

  async getHoldStatus(req, res, next) {
    try {
      const { orderId } = req.params;

      const status = await orderHoldService.getHoldStatus(orderId);

      if (!status) {
        return res.status(404).json({ error: 'Order is not on hold' });
      }

      res.json(status);
    } catch (err) {
      next(err);
    }
  }

  async releaseHold(req, res, next) {
    try {
      const userId = req.user?.id || req.user?._id;
      const { orderId } = req.params;
      const { releaseReason } = req.body;

      const released = await orderHoldService.releaseHold(
        orderId,
        releaseReason || 'Released',
        userId
      );

      res.json(released);
    } catch (err) {
      next(err);
    }
  }

  async getHeldOrdersBySeller(req, res, next) {
    try {
      const sellerId = req.user?.id || req.user?._id;

      const orders = await orderHoldService.getHeldOrdersBySeller(sellerId);

      res.json({
        orders,
        total: orders.length,
      });
    } catch (err) {
      next(err);
    }
  }

  async getHoldHistory(req, res, next) {
    try {
      const { orderId } = req.params;

      const history = await orderHoldService.getHoldHistory(orderId);

      res.json({ history });
    } catch (err) {
      next(err);
    }
  }
}

module.exports = new OrderHoldController();
