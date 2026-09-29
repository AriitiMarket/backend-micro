const Payment = require('../models/Payments');

class PaymentRepository {
  create(data) { return Payment.create(data); }
  findById(id) { return Payment.findById(id); }
  findByOrder(orderId) { return Payment.findOne({ orderId }); }
  findByUser(userId) { return Payment.find({ userId }); }
  findBySeller(sellerId) { return Payment.find({ sellerId }); }
  findAll(filter = {}) { return Payment.find(filter).sort({ createdAt: -1 }); }
  findByIdAndUpdate(id, data) { return Payment.findByIdAndUpdate(id, data, { new: true }); }
  findByIdAndDelete(id) { return Payment.findByIdAndDelete(id); }
}

module.exports = new PaymentRepository();
