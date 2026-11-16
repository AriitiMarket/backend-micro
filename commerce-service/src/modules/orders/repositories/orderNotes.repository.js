/**
 * ORDER NOTES REPOSITORY
 * Reuses patterns from orders.repository.js and returns.repository.js
 */

const OrderNote = require('../models/OrderNote');
const { isValidObjectId } = require('../../../shared/utils/mongoId');

class OrderNotesRepository {
  create(data, options = {}) {
    const { session } = options;
    const doc = new OrderNote(data);
    return session ? doc.save({ session }) : doc.save();
  }

  findById(id, options = {}) {
    if (!isValidObjectId(id)) return Promise.resolve(null);
    const { session } = options;
    let query = OrderNote.findById(id);
    if (session) query = query.session(session);
    return query.exec();
  }

  find(query = {}, options = {}) {
    const {
      filter = {},
      limit = 50,
      offset = 0,
      sort = { createdAt: -1 },
      session,
    } = query;

    let q = OrderNote.find(filter);
    if (session) q = q.session(session);
    return q.sort(sort).skip(offset).limit(limit).exec();
  }

  update(id, data, options = {}) {
    const { session } = options;
    let query = OrderNote.findByIdAndUpdate(
      id,
      data,
      { new: true, runValidators: true }
    );
    if (session) query = query.session(session);
    return query.exec();
  }

  countByFilter(filter = {}, options = {}) {
    const { session } = options;
    let query = OrderNote.countDocuments(filter);
    if (session) query = query.session(session);
    return query.exec();
  }

  delete(id, options = {}) {
    const { session } = options;
    let query = OrderNote.findByIdAndDelete(id);
    if (session) query = query.session(session);
    return query.exec();
  }
}

module.exports = new OrderNotesRepository();
