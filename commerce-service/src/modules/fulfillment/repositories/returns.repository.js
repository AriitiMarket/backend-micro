/**
 * Returns Repository
 * Handles CRUD operations for returns collection
 */

const mongoose = require('mongoose');

class ReturnsRepository {
  constructor(returnsModel) {
    this.model = returnsModel;
  }

  /**
   * Create new return
   */
  async create(data, options = {}) {
    const { session } = options;
    const doc = new this.model(data);
    if (session) {
      await doc.save({ session });
    } else {
      await doc.save();
    }
    return doc;
  }

  /**
   * Find by ID
   */
  async findById(id, options = {}) {
    const { session } = options;
    const query = this.model.findById(id);
    if (session) {
      query.session(session);
    }
    return query.exec();
  }

  /**
   * Find with filters
   */
  async find(query = {}, options = {}) {
    const {
      filter = {},
      limit = 50,
      offset = 0,
      sort = { createdAt: -1 },
      session,
    } = query;

    let q = this.model.find(filter);
    if (session) {
      q = q.session(session);
    }
    return q.sort(sort).skip(offset).limit(limit).exec();
  }

  /**
   * Update return
   */
  async update(id, data, options = {}) {
    const { session } = options;
    const query = this.model.findByIdAndUpdate(id, data, {
      new: true,
      runValidators: true,
    });
    if (session) {
      query.session(session);
    }
    return query.exec();
  }

  /**
   * Delete return
   */
  async delete(id, options = {}) {
    const { session } = options;
    const query = this.model.findByIdAndDelete(id);
    if (session) {
      query.session(session);
    }
    return query.exec();
  }

  /**
   * Count returns by filter
   */
  async countByFilter(filter = {}, options = {}) {
    const { session } = options;
    let query = this.model.countDocuments(filter);
    if (session) {
      query = query.session(session);
    }
    return query.exec();
  }

  /**
   * Aggregate returns
   */
  async aggregate(pipeline = [], options = {}) {
    const { session } = options;
    let agg = this.model.aggregate(pipeline);
    if (session) {
      agg = agg.session(session);
    }
    return agg.exec();
  }
}

module.exports = ReturnsRepository;
