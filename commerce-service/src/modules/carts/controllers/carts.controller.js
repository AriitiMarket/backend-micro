const cartService = require('../services/carts.service');
const { ok, created } = require('../../../shared/utils/response');

async function getCart(req, res, next) {
  try {
    const cart = await cartService.getUserCart(req.user.id);
    return ok(res, { cart: cart || { userId: req.user.id, items: [], createdAt: new Date(), updatedAt: new Date() } });
  } catch (err) {
    return next(err);
  }
}

async function updateCartItem(req, res, next) {
  try {
    const { productId } = req.params;
    const { quantity } = req.body;
    const cart = await cartService.updateItemQuantity(req.user.id, productId, quantity);
    if (!cart) {
      return res.status(404).json({ success: false, code: 'CART_ITEM_NOT_FOUND', message: 'Cart item not found', errors: [] });
    }
    return ok(res, { cart });
  } catch (err) {
    return next(err);
  }
}

async function removeCartItem(req, res, next) {
  try {
    const { productId } = req.params;
    const cart = await cartService.removeItem(req.user.id, productId);
    if (!cart) {
      return res.status(404).json({ success: false, code: 'CART_ITEM_NOT_FOUND', message: 'Cart item not found', errors: [] });
    }
    return ok(res, { cart });
  } catch (err) {
    return next(err);
  }
}

async function clearCart(req, res, next) {
  try {
    const cart = await cartService.clearCart(req.user.id);
    return ok(res, { cart });
  } catch (err) {
    return next(err);
  }
}

/**
 * Add-to-cart with an OPTIONAL zone context. The add itself is never blocked
 * (a browsing cart may hold anything), but when the buyer has a delivery zone
 * selected the response carries a `warning` for an incompatible shop — same
 * codes as /cart/validate, so the UI explains the conflict immediately.
 */
async function addToCartWithZone(req, res, next) {
  try {
    const cart = await cartService.addItem(req.user.id, req.body);
    let warning = null;
    const zoneId = (req.body && req.body.zoneId) || (req.headers['x-delivery-zone'] || '');
    if (zoneId) {
      warning = await cartService.coverageWarningForItem(
        (req.body && (req.body.productId || req.body._id)) || '',
        zoneId,
        (req.body && req.body.zoneName) || ''
      );
    }
    if (warning) return created(res, { cart, warning });
    return created(res, { cart });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /cart/validate — authoritative zone + availability validation of the
 * whole cart for the buyer's currently selected zone ({ zoneId, zoneName }).
 * Read-only: never mutates the cart, so changing location and re-checking is
 * always safe (Rule: never silently remove items or change the order zone).
 */
async function validateCartForZone(req, res, next) {
  try {
    const result = await cartService.validateForZone(req.user.id, req.body || {});
    return ok(res, result);
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  addToCart: addToCartWithZone,
  getCart,
  updateCartItem,
  removeCartItem,
  clearCart,
  validateCartForZone,
};
