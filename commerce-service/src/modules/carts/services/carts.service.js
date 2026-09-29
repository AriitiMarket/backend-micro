const cartRepository = require('../repositories/carts.repository');
const productRepository = require('../../catalog/repositories/products.repository');
const { isProductPubliclyVisible } = require('../../../shared/utils/productVisibility');
const { isValidObjectId } = require('../../../shared/utils/mongoId');

// Client-facing cart failures must be 4xx, not 500: the errorHandler only
// maps statusCode/status, so a bare `new Error(...)` became INTERNAL_SERVER_ERROR.
class CartError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

class CartService {
  async addItem(userId, item) {
    const productId = String(item.productId || item._id);
    if (!isValidObjectId(productId)) {
      throw new CartError('Invalid product ID', 400);
    }

    const qty = Number(item.quantity);
    if (!Number.isFinite(qty) || qty < 1) {
      throw new CartError('Quantity must be at least 1', 400);
    }

    const product = await productRepository.findById(productId);
    if (!product) {
      throw new CartError('Product not found', 404);
    }

    const visible = await isProductPubliclyVisible(product);
    if (!visible) {
      throw new CartError('Product is no longer available', 400);
    }

    const available = (Number(product.stock) || 0) - (Number(product.reserved) || 0);
    if (available < qty) {
      throw new CartError(`Only ${available} items available in stock`, 400);
    }

    const cartItem = {
      _id: String(item._id || new (require('mongoose').Types.ObjectId)()),
      productId,
      shopId: String(product.shopId || product.shop?._id || ''),
      name: product.name,
      price: Number(product.discountPrice) || 0,
      quantity: qty,
    };

    return cartRepository.addItem(userId, cartItem);
  }

  async getUserCart(userId) {
    return cartRepository.findByUser(userId);
  }

  async updateItemQuantity(userId, productId, quantity) {
    if (!isValidObjectId(productId)) {
      throw new CartError('Invalid product ID', 400);
    }
    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty < 1) {
      throw new CartError('Quantity must be at least 1', 400);
    }
    const product = await productRepository.findById(productId);
    if (!product) {
      throw new CartError('Product not found', 404);
    }
    const available = (Number(product.stock) || 0) - (Number(product.reserved) || 0);
    if (available < qty) {
      throw new CartError(`Only ${available} items available in stock`, 400);
    }
    return cartRepository.updateItemQuantity(userId, productId, qty);
  }

  async removeItem(userId, productId) {
    if (!isValidObjectId(productId)) {
      throw new CartError('Invalid product ID', 400);
    }
    return cartRepository.removeItem(userId, productId);
  }

  async clearCart(userId) {
    return cartRepository.clear(userId);
  }
}

module.exports = new CartService();
