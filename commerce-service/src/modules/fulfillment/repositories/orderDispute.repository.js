const OrderDispute = require('../models/OrderDispute');

class OrderDisputeRepository {
  create(data, options = {}) {
    const { session } = options;
    const doc = new OrderDispute(data);
    return session ? doc.save({ session }) : doc.save();
  }

  findById(id, options = {}) {
    const { session } = options;
    let q = OrderDispute.findById(id);
    if (session) q = q.session(session);
    return q.exec();
  }

  find(query = {}) {
    const { filter = {} } = query;
    return OrderDispute.find(filter).sort({ createdAt: -1 });
  }

  update(id, data, options = {}) {
    const { session } = options;
    let q = OrderDispute.findByIdAndUpdate(id, data, { new: true });
    if (session) q = q.session(session);
    return q.exec();
  }

  countByStatus(status) {
    return OrderDispute.countDocuments({ status });
  }
}

module.exports = new OrderDisputeRepository();
