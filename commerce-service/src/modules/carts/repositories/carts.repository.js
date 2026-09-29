const Cart = require('../models/Carts');
const { isValidObjectId } = require('../../../shared/utils/mongoId');

class CartRepository {
  async findByUser(userId) {
    return Cart.findOne({ userId }).lean();
  }

  async findCartItem(userId, productId) {
    if (!isValidObjectId(productId)) return null;
    const cart = await Cart.findOne({ userId, 'items.productId': productId }).lean();
    if (!cart) return null;
    const item = cart.items.find((i) => String(i.productId) === String(productId));
    return item || null;
  }

  async addItem(userId, item) {
    const qty = Number(item.quantity);
    if (!Number.isFinite(qty) || qty < 1) return null;

    const normalized = {
      _id: item._id || String(new (require('mongoose').Types.ObjectId)()),
      productId: String(item.productId),
      shopId: String(item.shopId),
      name: String(item.name || ''),
      price: Number(item.price) || 0,
      quantity: qty,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const cart = await Cart.findOne({ userId });
    if (!cart) {
      return Cart.create({ userId, items: [normalized], createdAt: new Date(), updatedAt: new Date() });
    }

    const idx = cart.items.findIndex((i) => String(i.productId) === String(item.productId));
    if (idx >= 0) {
      cart.items[idx].quantity += qty;
      cart.items[idx].updatedAt = new Date();
    } else {
      cart.items.push(normalized);
    }
    cart.updatedAt = new Date();
    return cart.save();
  }

  async updateItemQuantity(userId, productId, quantity) {
    const qty = Number(quantity);
    if (qty < 1) return null;

    const cart = await Cart.findOne({ userId });
    if (!cart) return null;

    const idx = cart.items.findIndex((i) => String(i.productId) === String(productId));
    if (idx < 0) return null;

    cart.items[idx].quantity = qty;
    cart.items[idx].updatedAt = new Date();
    cart.updatedAt = new Date();
    return cart.save();
  }

  async removeItem(userId, productId) {
    const cart = await Cart.findOne({ userId });
    if (!cart) return null;

    const idx = cart.items.findIndex((i) => String(i.productId) === String(productId));
    if (idx < 0) return null;

    cart.items.splice(idx, 1);
    cart.updatedAt = new Date();
    return cart.save();
  }

  async clear(userId) {
    return Cart.findOneAndDelete({ userId });
  }
}

module.exports = new CartRepository();
