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

    const wishlist = await Wishlist.findOne({ userId });
    if (!wishlist) {
      return Wishlist.create({ userId, items: [normalized], createdAt: new Date(), updatedAt: new Date() });
    }

    const idx = wishlist.items.findIndex((i) => String(i.productId) === normalized.productId);
    if (idx >= 0) {
      // Already wishlisted — refresh the display snapshot, never duplicate.
      const existing = wishlist.items[idx];
      existing.name = normalized.name;
      existing.price = normalized.price;
      existing.originalPrice = normalized.originalPrice;
      existing.image = normalized.image;
      existing.shopName = normalized.shopName;
      existing.ratings = normalized.ratings;
      existing.stock = normalized.stock;
      existing.updatedAt = new Date();
    } else {
      wishlist.items.push(normalized);
    }
    wishlist.updatedAt = new Date();
    return wishlist.save();
  }

  async removeItem(userId, productId) {
    if (!isValidObjectId(productId)) return null;
    const wishlist = await Wishlist.findOne({ userId });
    if (!wishlist) return null;

    const idx = wishlist.items.findIndex((i) => String(i.productId) === String(productId));
    if (idx < 0) return null;

    wishlist.items.splice(idx, 1);
    wishlist.updatedAt = new Date();
    return wishlist.save();
  }

  async clear(userId) {
    return Wishlist.findOneAndDelete({ userId });
  }
}

module.exports = new WishlistRepository();
