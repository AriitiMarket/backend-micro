const orderSLAService = require('../services/orderSLA.service');

class OrderSLAController {
  async setSLA(req, res) {
    try {
      const { orderId, stateName, durationHours } = req.body;
      const userId = req.user?._id;

      const result = await orderSLAService.setSLA(orderId, stateName, durationHours, { userId });
      res.status(201).json({ success: true, data: result });
    } catch (err) {
      res.status(err.statusCode || 500).json({ success: false, message: err.message });
    }
  }

  async checkCompliance(req, res) {
    try {
      const { orderId } = req.params;
      const result = await orderSLAService.checkSLACompliance(orderId);
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      res.status(err.statusCode || 500).json({ success: false, message: err.message });
    }
  }

  async getStatus(req, res) {
    try {
      const { orderId } = req.params;
      const result = await orderSLAService.getSLAStatus(orderId);
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      res.status(err.statusCode || 500).json({ success: false, message: err.message });
    }
  }

  async getBreaches(req, res) {
    try {
      const sellerId = req.user?._id;
      const { period } = req.query;
      const result = await orderSLAService.getSLABreaches(sellerId, period);
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      res.status(err.statusCode || 500).json({ success: false, message: err.message });
    }
  }
}

module.exports = new OrderSLAController();
