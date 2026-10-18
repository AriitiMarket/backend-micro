const orderDisputeService = require('../services/orderDispute.service');

class OrderDisputeController {
  async createDispute(req, res) {
    try {
      const { orderId, reason, evidence } = req.body;
      const userId = req.user?._id;
      const role = req.user?.role;

      const result = await orderDisputeService.createDispute(orderId, reason, evidence, { userId, role });
      res.status(201).json({ success: true, data: result });
    } catch (err) {
      res.status(err.statusCode || 500).json({ success: false, message: err.message });
    }
  }

  async updateDispute(req, res) {
    try {
      const { disputeId } = req.params;
      const { status, resolution } = req.body;
      const userId = req.user?._id;

      const result = await orderDisputeService.updateDispute(disputeId, status, resolution, { userId });
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      res.status(err.statusCode || 500).json({ success: false, message: err.message });
    }
  }

  async getDispute(req, res) {
    try {
      const { disputeId } = req.params;
      const result = await orderDisputeService.getDispute(disputeId);
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      res.status(err.statusCode || 500).json({ success: false, message: err.message });
    }
  }

  async getSellerDisputes(req, res) {
    try {
      const sellerId = req.user?._id;
      const { status } = req.query;
      const result = await orderDisputeService.getSellerDisputes(sellerId, status);
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      res.status(err.statusCode || 500).json({ success: false, message: err.message });
    }
  }

  async getOpenDisputes(req, res) {
    try {
      const result = await orderDisputeService.getOpenDisputes();
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      res.status(err.statusCode || 500).json({ success: false, message: err.message });
    }
  }
}

module.exports = new OrderDisputeController();
