const OrderSLA = require('../models/OrderSLA');
const { isValidObjectId } = require('../../../shared/utils/mongoId');

class OrderSLARepository {
  create(data, options = {}) {
    const { session } = options;
    const doc = new OrderSLA(data);
    return session ? doc.save({ session }) : doc.save();
  }

  findByOrderId(orderId) {
    return OrderSLA.findOne({ orderId: String(orderId) }).sort({ createdAt: -1 });
  }

  /**
   * Filtered read used by the breach list.
   *
   * `filter` is the Mongo filter, `sort` the ordering and `limit`/`skip` the
   * window. The default ordering moved from `deadline` to `breachedAt` so the
   * dashboard shows the most RECENT breach first — a breach recorded an hour
   * ago outranks one recorded last week, whatever deadline each had.
   */
  find(query = {}) {
    const { filter = {}, sort = { breachedAt: -1, deadline: 1 }, limit = 0, skip = 0 } = query;
    let cursor = OrderSLA.find(filter).sort(sort);
    if (skip) cursor = cursor.skip(skip);
    if (limit) cursor = cursor.limit(limit);
    return cursor;
  }

  count(filter = {}) {
    return OrderSLA.countDocuments(filter);
  }

  /**
   * Flag every SLA whose deadline has passed and that is not yet marked
   * breached.
   *
   * The breach is stamped with the DEADLINE — the moment the service level was
   * actually missed — not with the moment this sweep happened to run, so a
   * breach noticed an hour late is still reported as having happened at the
   * deadline. Source is AUTO so a hand-recorded breach stays distinguishable.
   */
  markOverdue(now = new Date()) {
    // The aggregation-pipeline form of updateMany is required here: it is the
    // only way to set a field to the VALUE of another field on the same
    // document. The classic update document would store the literal string
    // "$deadline" instead of the deadline itself.
    return OrderSLA.updateMany(
      { breached: false, deadline: { $lt: now } },
      [
        {
          $set: {
            breached: true,
            breachedAt: '$deadline',
            breachSource: 'AUTO',
            breachReason: 'Deadline exceeded',
          },
        },
      ]
    );
  }

  update(id, data, options = {}) {
    const { session } = options;
    if (!isValidObjectId(id)) return Promise.resolve(null);
    let q = OrderSLA.findByIdAndUpdate(id, data, { new: true });
    if (session) q = q.session(session);
    return q.exec();
  }
}

module.exports = new OrderSLARepository();
