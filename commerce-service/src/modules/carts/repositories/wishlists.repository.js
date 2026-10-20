const Wishlist = require('../models/Wishlists');
const { isValidObjectId } = require('../../../shared/utils/mongoId');

class WishlistRepository {
  async findByUser(userId) {
    return Wishlist.findOne({ userId }).lean();
  }

  async findItem(userId, productId) {
    if (!isValidObjectId(productId)) return null;
    const wishlist = await Wishlist.findOne({ userId, 'items.productId': String(productId) }).lean();
    if (!wishlist) return null;
    return wishlist.items.find((i) => String(i.productId) === String(productId)) || null;
  }

  async addItem(userId, item) {
    const normalized = {
      _id: String(item.productId),
      productId: String(item.productId),
      shopId: String(item.shopId || ''),
      name: String(item.name || ''),
      price: Number(item.price) || 0,
      originalPrice: Number(item.originalPrice) || 0,
      image: String(item.image || ''),
      shopName: String(item.shopName || ''),
      ratings: Number(item.ratings) || 0,
      stock: Number(item.stock) || 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const now = new Date();
    const snapshot = {
      'items.$.shopId': normalized.shopId,
      'items.$.name': normalized.name,
      'items.$.price': normalized.price,
      'items.$.originalPrice': normalized.originalPrice,
      'items.$.image': normalized.image,
      'items.$.shopName': normalized.shopName,
      'items.$.ratings': normalized.ratings,
      'items.$.stock': normalized.stock,
      'items.$.updatedAt': now,
      updatedAt: now,
    };

    // First update an existing line. The productId predicate makes the update
    // atomic, so simultaneous requests cannot overwrite a stale wishlist.
    const existing = await Wishlist.findOneAndUpdate(
      { userId, 'items.productId': normalized.productId },
      { $set: snapshot },
      { new: true }
    );
    if (existing) return existing;

    // The unique userId index arbitrates concurrent first writes. The `$ne`
    // predicate also prevents duplicate lines when two requests race.
    try {
      return await Wishlist.findOneAndUpdate(
        { userId, 'items.productId': { $ne: normalized.productId } },
        {
          $setOnInsert: { userId, createdAt: now },
          $push: { items: normalized },
          $set: { updatedAt: now },
        },
        { new: true, upsert: true, setDefaultsOnInsert: true }
      );
    } catch (err) {
      if (err.code !== 11000) throw err;
      // A parallel first write created the user's wishlist. Retry against the
      // now-existing row, either refreshing the same line or appending it.
      return this.addItem(userId, item);
    }
  }

  async removeItem(userId, productId) {
    if (!isValidObjectId(productId)) return null;
    return Wishlist.findOneAndUpdate(
      { userId, 'items.productId': String(productId) },
      { $pull: { items: { productId: String(productId) } }, $set: { updatedAt: new Date() } },
      { new: true }
    );
  }

  async clear(userId) {
    return Wishlist.findOneAndDelete({ userId });
  }
}

module.exports = new WishlistRepository();
