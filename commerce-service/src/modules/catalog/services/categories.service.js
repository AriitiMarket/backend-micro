const categoryRepository = require('../repositories/categories.repository');
const { countPublicProductsByCategory } = require('../repositories/products.public.repository');

class CategoryService {
  create(data) { return categoryRepository.create(data); }

  getAll(filter) { return categoryRepository.findAll(filter); }

  getActiveByType(type) { return categoryRepository.findActiveByType(type); }

  getById(id) { return categoryRepository.findById(id); }

  getBySlug(slug) { return categoryRepository.findBySlug(slug); }

  /**
   * Update a category.
   *
   * A title is the FOREIGN KEY products reference ("title-as-FFK"), so renaming
   * a category must follow through to every product (and event) that points at
   * the old title. Without the cascade a rename silently orphans the catalog:
   * products keep a title no Category row backs, the storefront category chips
   * stop matching them, and `categoryValidator` starts rejecting writes to a
   * title the seller can still see in their own edit form.
   *
   * Returns the updated category plus `cascadedProducts`/`cascadedEvents` so the
   * admin console can report what the rename touched.
   */
  async update(id, data) {
    const existing = await categoryRepository.findById(id);
    if (!existing) {
      const err = new Error('Category not found');
      err.statusCode = 404;
      throw err;
    }

    const nextTitle = data && data.title !== undefined && data.title !== null
      ? String(data.title).trim()
      : null;
    const renamed = Boolean(nextTitle) && nextTitle !== existing.title;

    const category = await categoryRepository.findByIdAndUpdate(id, data);
    if (!renamed || !category) return category;

    const cascade = await this.syncReferences(existing.title, category);
    return {
      ...category.toObject(),
      previousTitle: existing.title,
      cascadedProducts: cascade.products,
      cascadedEvents: cascade.events,
    };
  }

  /**
   * Re-point every Product/Event that still carries `oldTitle` at the renamed
   * category (`category` title + the optional `categoryId` FK).
   */
  async syncReferences(oldTitle, category) {
    const mongoose = require('mongoose');
    const models = mongoose.models;
    const categoryId = String(category._id || category.id);
    const result = { products: 0, events: 0 };

    for (const [modelName, key] of [['Product', 'products'], ['Event', 'events']]) {
      const model = models[modelName];
      if (!model) continue;
      const res = await model.updateMany(
        { category: oldTitle },
        { $set: { category: category.title, categoryId } }
      );
      result[key] = res.modifiedCount || res.matchedCount || 0;
    }

    return result;
  }

  async toggleStatus(id) {
    const category = await categoryRepository.findById(id);
    if (!category) throw new Error('Category not found');
    const newStatus = category.status === 'active' ? 'inactive' : 'active';
    return categoryRepository.findByIdAndUpdate(id, { status: newStatus });
  }

  /**
   * Delete a category — REFERENCE PROTECTED.
   *
   * Products reference categories by `title` (title-as-FFK), so deleting a
   * category that products still use silently orphans them: the product keeps
   * the title string but no Category row backs it, the admin category list no
   * longer shows a filter that works, and `categoryValidator` starts rejecting
   * (or, if the collection empties, silently accepting) product writes.
   *
   * Refuse the delete while any product/event still points at the title.
   */
  async remove(id) {
    const category = await categoryRepository.findById(id);
    if (!category) throw new Error('Category not found');

    const mongoose = require('mongoose');
    const models = mongoose.models;
    let inUse = 0;
    for (const modelName of ['Product', 'Event']) {
      const model = models[modelName];
      if (!model) continue;
      inUse += await model.countDocuments({ category: category.title });
    }
    if (inUse > 0) {
      const err = new Error(
        `Cannot delete category "${category.title}": ${inUse} product(s)/event(s) still use it. Reassign them first.`
      );
      err.statusCode = 409;
      throw err;
    }

    return categoryRepository.deleteById(id);
  }

  async count(filter) { return categoryRepository.count(filter); }

  async getAllWithProductCount(filter) {
    const categories = await categoryRepository.findAll(filter);
    const mongoose = require('mongoose');
    const Product = mongoose.model('Product');
    const counts = await Product.aggregate([
      { $group: { _id: '$category', count: { $sum: 1 } } },
    ]);
    const countMap = {};
    counts.forEach((c) => { countMap[c._id] = c.count; });
    return categories.map((cat) => ({
      ...cat.toObject(),
      productCount: countMap[cat.title] || 0,
    }));
  }

  /**
   * Active categories with the product count the STOREFRONT must show.
   *
   * The count uses the public visibility gates (products.public.repository), not
   * a raw `countDocuments`: the chip and the list behind it have to agree, or a
   * buyer clicks "Fashion (9)" and lands on 4 products.
   */
  async getActiveByTypeWithProductCount(type) {
    const categories = await categoryRepository.findActiveByType(type);
    const countMap = await countPublicProductsByCategory();
    return categories.map((cat) => ({
      ...cat.toObject(),
      productCount: countMap.get(cat.title) || 0,
    }));
  }
}

module.exports = new CategoryService();
