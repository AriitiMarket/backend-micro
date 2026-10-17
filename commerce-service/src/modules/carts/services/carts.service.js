const cartRepository = require('../repositories/carts.repository');
const productRepository = require('../../catalog/repositories/products.repository');
const shopRepository = require('../../selling/repositories/shops.repository');
const shopCoverageService = require('../../selling/services/shopCoverage.service');
const { isProductPubliclyVisible, availableUnits } = require('../../../shared/utils/productVisibility');
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

  /**
   * Immediate "conflict" answer for the moment a buyer adds an item while a
   * delivery zone is selected. Uses the same coverage verdict as cart
   * validation and checkout, so the toast, the cart banner and the backend
   * rejection can never disagree. Returns null when the item is fine (or when
   * no zone is selected — browsing carts are allowed to hold anything).
   */
  async coverageWarningForItem(productId, zoneId, zoneName = '') {
    const zone = String(zoneId || '').trim();
    if (!zone) return null;
    const product = await productRepository.findById(String(productId));
    if (!product) return null;
    const shopId = String(product.shopId || (product.shop && product.shop._id) || '');
    if (!shopId) {
      return {
        code: 'LOCATION_NOT_CONFIGURED',
        shopId: '',
        shopName: product.shop && product.shop.name ? product.shop.name : 'This shop',
        message: "This product's shop has no delivery coverage configured",
      };
    }
    const shop = await shopRepository.findById(shopId);
    const verdict = shopCoverageService.verdictForShop(shop, zone, zoneName);
    if (verdict.servesZone) return null;
    return { code: verdict.code, shopId, shopName: verdict.shopName, message: verdict.message };
  }

  /**
   * AUTHORITATIVE zone-aware cart validation (Rule A + Rule C). Revalidates
   * for the buyer's CURRENTLY SELECTED zone: the zone itself (Delivery is the
   * source of truth), every shop's coverage (LOCATION_NOT_CONFIGURED /
   * SHOP_NOT_SERVING_ZONE), product availability (PRODUCT_UNAVAILABLE /
   * INSUFFICIENT_STOCK) and current prices (`priceChanged` — checkout re-prices
   * server-side regardless). Nothing is ever removed from the cart here: the
   * response describes each item so the UI can offer remove / view shop /
   * change location while the buyer keeps the rest of the cart intact.
   */
  async validateForZone(userId, payload = {}) {
    const zoneId = String(payload.zoneId || '').trim();
    const requestedName = String(payload.zoneName || '').trim();
    const cart = await cartRepository.findByUser(userId);
    const cartItems = (cart && cart.items) || [];

    if (!cartItems.length) {
      return { valid: true, zone: null, items: [], issues: [] };
    }

    // Fail-closed response when the ZONE itself is unusable.
    const zoneFailure = (code, message) => ({
      valid: false,
      zone: zoneId ? { id: zoneId, name: requestedName, verified: false } : null,
      items: cartItems.map((item) => ({
        productId: item.productId || item._id,
        name: item.name,
        shopId: item.shopId || '',
        shopName: '',
        quantity: item.quantity || 1,
        price: item.price || 0,
        eligible: false,
        code,
        message,
        available: null,
        priceChanged: false,
        currentPrice: null,
      })),
      issues: [{ code, message }],
    });

    if (!zoneId) {
      return zoneFailure(
        'INVALID_DELIVERY_LOCATION',
        'No delivery zone selected — choose your city and delivery zone first'
      );
    }

    const { zone, authoritative } = await shopCoverageService.resolveZone(zoneId);
    if (authoritative && (!zone || !shopCoverageService.zoneOrderable(zone))) {
      return zoneFailure(
        'INVALID_DELIVERY_LOCATION',
        'The selected delivery zone is not available for delivery'
      );
    }
    const zoneName = (zone && zone.name) || requestedName;
    const zoneInfo = { id: zoneId, name: zoneName, verified: Boolean(authoritative && zone) };

    // Resolve every shop in the cart once.
    const shopIds = [...new Set(cartItems.map((item) => String(item.shopId || '')).filter(Boolean))];
    const shopDocs = await Promise.all(shopIds.map((id) => shopRepository.findById(id)));
    const shopMap = new Map();
    shopDocs.forEach((shop, index) => {
      if (shop) shopMap.set(shopIds[index], shop);
    });

    const items = [];
    for (const item of cartItems) {
      const productId = item.productId || item._id;
      const row = {
        productId,
        name: item.name,
        shopId: String(item.shopId || ''),
        shopName: (shopMap.get(String(item.shopId)) || {}).name || '',
        quantity: Number(item.quantity) || 1,
        price: Number(item.price) || 0,
        eligible: true,
        code: null,
        message: null,
        available: null,
        priceChanged: false,
        currentPrice: null,
      };

      const product = await productRepository.findById(productId);
      if (!product) {
        row.eligible = false;
        row.code = 'PRODUCT_UNAVAILABLE';
        row.message = `"${item.name}" is no longer available`;
      } else if (!(await isProductPubliclyVisible(product))) {
        row.eligible = false;
        row.code = 'PRODUCT_UNAVAILABLE';
        row.message = `"${product.name}" is no longer available`;
        row.available = availableUnits(product);
      } else {
        row.available = availableUnits(product);
        if (row.available < row.quantity) {
          row.eligible = false;
          row.code = 'INSUFFICIENT_STOCK';
          row.message = row.available <= 0
            ? `"${product.name}" is out of stock`
            : `Only ${row.available} of "${product.name}" left (you asked for ${row.quantity})`;
        }
        const currentPrice = Number(product.discountPrice) || 0;
        if (currentPrice && currentPrice !== row.price) {
          row.priceChanged = true;
          row.currentPrice = currentPrice;
        }
        // Zone check last: availability issues are reported per row as-is.
        if (row.eligible) {
          const verdict = shopCoverageService.verdictForShop(
            shopMap.get(row.shopId) || null,
            zoneId,
            zoneName
          );
          if (!verdict.servesZone) {
            row.eligible = false;
            row.code = verdict.code;
            row.message = verdict.message;
            if (!row.shopName) row.shopName = verdict.shopName;
          }
        }
      }
      items.push(row);
    }

    const failures = items.filter((row) => !row.eligible);
    const issues = [];
    if (failures.length) {
      const codes = [...new Set(failures.map((row) => row.code))];
      const mixedCart = failures.length < items.length
        && failures.some((row) => row.code === 'SHOP_NOT_SERVING_ZONE' || row.code === 'LOCATION_NOT_CONFIGURED');
      const code = mixedCart ? 'ZONE_MISMATCH' : codes[0];
      const shops = [...new Set(failures.filter((row) => row.shopName).map((row) => row.shopName))];
      issues.push({
        code,
        message: mixedCart
          ? `Some shops do not deliver to ${zoneName}: ${shops.join(', ')}. `
            + 'Remove those items, or check out the rest and start a separate order for them.'
          : failures[0].message,
        productIds: failures.map((row) => row.productId),
        shopIds: [...new Set(failures.map((row) => row.shopId).filter(Boolean))],
      });
    }

    return { valid: failures.length === 0, zone: zoneInfo, items, issues };
  }

  async clearCart(userId) {
    return cartRepository.clear(userId);
  }
}

module.exports = new CartService();
