const wishlistRepository = require('../repositories/wishlists.repository');
const productRepository = require('../../catalog/repositories/products.repository');
const { isProductPubliclyVisible } = require('../../../shared/utils/productVisibility');
const { isValidObjectId } = require('../../../shared/utils/mongoId');

// statusCode + code are read by the global errorHandler, so these surface as
// clean 4xx responses instead of 500 INTERNAL_SERVER_ERROR.
function httpError(statusCode, code, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

function firstImage(product) {
  if (Array.isArray(product.images) && product.images.length) return product.images[0];
  return product.image || product.image_Url || product.thumbnail || '';
}

class WishlistService {
  async addItem(userId, item = {}) {
    const productId = String(item.productId || item._id || '');
    if (!isValidObjectId(productId)) {
      throw httpError(400, 'INVALID_PRODUCT_ID', 'Invalid product ID');
    }

    const product = await productRepository.findById(productId);
    if (!product) {
      throw httpError(404, 'PRODUCT_NOT_FOUND', 'Product not found');
    }

    const visible = await isProductPubliclyVisible(product);
    if (!visible) {
      throw httpError(404, 'PRODUCT_UNAVAILABLE', 'Product is no longer available');
    }

    // Authoritative display snapshot from the product document — a tampered
    // client payload cannot inject its own name or price.
    return wishlistRepository.addItem(userId, {
      _id: productId,
      productId,
      shopId: String(product.shopId || product.shop?._id || ''),
      name: product.name,
      price: Number(product.discountPrice) || 0,
      originalPrice: Number(product.originalPrice) || 0,
      image: firstImage(product),
      shopName: String(product.shop?.name || ''),
      ratings: Number(product.ratings) || 0,
      stock: Number(product.stock) || 0,
    });
  }

  async getUserWishlist(userId) {
    return wishlistRepository.findByUser(userId);
  }

  async isWishlisted(userId, productId) {
    if (!isValidObjectId(productId)) {
      throw httpError(400, 'INVALID_PRODUCT_ID', 'Invalid product ID');
    }
    const item = await wishlistRepository.findItem(userId, productId);
    return { wishlisted: Boolean(item), item: item || null };
  }

  async removeItem(userId, productId) {
    if (!isValidObjectId(productId)) {
      throw httpError(400, 'INVALID_PRODUCT_ID', 'Invalid product ID');
    }
    return wishlistRepository.removeItem(userId, productId);
  }

  async clearWishlist(userId) {
    return wishlistRepository.clear(userId);
  }
}

module.exports = new WishlistService();
