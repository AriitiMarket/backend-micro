const OrderPriority = require('../models/OrderPriority');
const { isValidObjectId } = require('../../../shared/utils/mongoId');

class OrderPriorityRepository {
  create(data, options = {}) {
    const { session } = options;
    const doc = new OrderPriority(data);
    return session ? doc.save({ session }) : doc.save();
  }

  findByOrderId(orderId) {
    return OrderPriority.findOne({ orderId: String(orderId) });
  }

  find(query = {}) {
    const { filter = {} } = query;
    return OrderPriority.find(filter).sort({ level: -1, markedAt: -1 });
  }

  update(id, data, options = {}) {
    const { session } = options;
    let q = OrderPriority.findByIdAndUpdate(id, data, { new: true });
    if (session) q = q.session(session);
    return q.exec();
  }

  delete(id) {
    return OrderPriority.findByIdAndDelete(id);
  }

  findByPriority(priorities = []) {
    return OrderPriority.find({ priority: { $in: priorities } }).sort({ markedAt: -1 });
  }

  async getStats() {
    const counts = await OrderPriority.aggregate([
      { $group: { _id: '$priority', count: { $sum: 1 } } },
    ]);

    const byPriority = {
      NORMAL: 0,
      HIGH: 0,
      VIP: 0,
      URGENT: 0,
    };

    counts.forEach(c => {
      byPriority[c._id] = c.count;
    });

    const total = Object.values(byPriority).reduce((a, b) => a + b, 0);
    return { total, byPriority };
  }
}

module.exports = new OrderPriorityRepository();
