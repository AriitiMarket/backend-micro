/**
 * ORDER HOLD REPOSITORY
 * Reuses pattern from orderNotes.repository.js
 */

const OrderHold = require('../models/OrderHold');
const { isValidObjectId } = require('../../../shared/utils/mongoId');

class OrderHoldRepository {
  create(data, options = {}) {
    const { session } = options;
    const doc = new OrderHold(data);
    return session ? doc.save({ session }) : doc.save();
  }

  findById(id, options = {}) {
    if (!isValidObjectId(id)) return Promise.resolve(null);
    const { session } = options;
    let query = OrderHold.findById(id);
    if (session) query = query.session(session);
    return query.exec();
  }

  findByOrderId(orderId) {
    return OrderHold.findOne({ orderId: String(orderId), releasedAt: null });
  }

  findAll(filter = {}) {
    return OrderHold.find(filter).sort({ heldAt: -1 });
  }

  findByRole(role, options = {}) {
    const { filter = {} } = options;
    return OrderHold.find({ holdByRole: role, ...filter }).sort({ heldAt: -1 });
  }

  update(id, data, options = {}) {
    const { session } = options;
    let query = OrderHold.findByIdAndUpdate(id, data, { new: true });
    if (session) query = query.session(session);
    return query.exec();
  }

  countByFilter(filter = {}) {
    return OrderHold.countDocuments(filter);
  }
}

module.exports = new OrderHoldRepository();
