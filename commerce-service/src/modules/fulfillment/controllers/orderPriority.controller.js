const orderPriorityService = require('../services/orderPriority.service');

class OrderPriorityController {
  async setPriority(req, res) {
    try {
      const { orderId, priority, reason } = req.body;
      const userId = req.user?.id || req.user?._id || req.user?.sub || 'SYSTEM';

      const result = await orderPriorityService.setPriority(orderId, priority, reason, { userId });
      res.status(201).json({ success: true, data: result });
    } catch (err) {
      res.status(err.statusCode || 500).json({ success: false, message: err.message });
    }
  }

  async getPriority(req, res) {
    try {
      const { orderId } = req.params;
      const result = await orderPriorityService.getPriority(orderId);
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      res.status(err.statusCode || 500).json({ success: false, message: err.message });
    }
  }

  async getVIPOrders(req, res) {
    try {
      const result = await orderPriorityService.getVIPOrders();
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      res.status(err.statusCode || 500).json({ success: false, message: err.message });
    }
  }

  async resetPriority(req, res) {
    try {
      const { orderId } = req.params;
      const userId = req.user?.id || req.user?._id || req.user?.sub || 'SYSTEM';

      const result = await orderPriorityService.resetPriority(orderId, { userId });
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      res.status(err.statusCode || 500).json({ success: false, message: err.message });
    }
  }

  async getPriorityStats(req, res) {
    try {
      const result = await orderPriorityService.getPriorityStats();
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      res.status(err.statusCode || 500).json({ success: false, message: err.message });
    }
  }
}

module.exports = new OrderPriorityController();
