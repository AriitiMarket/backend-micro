const Category = require('../models/Categories');

class CategoryRepository {
  create(data) { return Category.create(data); }

  findAll(filter = {}) {
    const query = {};
    if (filter.type) query.type = filter.type;
    if (filter.status) query.status = filter.status;
    return Category.find(query).sort({ sortOrder: 1, createdAt: -1 });
  }

  findActiveByType(type) {
    return Category.find({ type, status: 'active' }).sort({ sortOrder: 1, createdAt: -1 });
  }

  findById(id) { return Category.findById(id); }

  findBySlug(slug) { return Category.findOne({ slug }); }

  findByTitle(title) { return Category.findOne({ title }); }

  findByTitleAndType(title, type) { return Category.findOne({ title, type }); }

  findByIdAndUpdate(id, data) { return Category.findByIdAndUpdate(id, data, { new: true }); }

  deleteById(id) { return Category.findByIdAndDelete(id); }

  count(filter = {}) { return Category.countDocuments(filter); }

  countActiveByType(type) { return Category.countDocuments({ type, status: 'active' }); }
}

module.exports = new CategoryRepository();
