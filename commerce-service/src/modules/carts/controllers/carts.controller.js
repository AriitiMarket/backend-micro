const cartService = require('../services/carts.service');
const { ok, created } = require('../../../shared/utils/response');

async function addToCart(req, res, next) {
  try {
    const cart = await cartService.addItem(req.user.id, req.body);
    return created(res, { cart });
  } catch (err) {
    return next(err);
  }
}

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

module.exports = { addToCart, getCart, updateCartItem, removeCartItem, clearCart };
