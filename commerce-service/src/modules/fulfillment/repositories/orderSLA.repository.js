const OrderSLA = require('../models/OrderSLA');

class OrderSLARepository {
  create(data, options = {}) {
    const { session } = options;
    const doc = new OrderSLA(data);
    return session ? doc.save({ session }) : doc.save();
  }

  findByOrderId(orderId) {
    return OrderSLA.findOne({ orderId: String(orderId) }).sort({ createdAt: -1 });
  }

  find(query = {}) {
    const { filter = {} } = query;
    return OrderSLA.find(filter).sort({ deadline: 1 });
  }

  update(id, data, options = {}) {
    const { session } = options;
    let q = OrderSLA.findByIdAndUpdate(id, data, { new: true });
    if (session) q = q.session(session);
    return q.exec();
  }
}

module.exports = new OrderSLARepository();
