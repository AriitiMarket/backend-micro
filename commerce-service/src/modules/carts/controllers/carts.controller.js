// Buyer Cart Controller — handles shopping cart management, item quantities, and zone coverage validation.
'use strict';

const cartService = require('../services/carts.service');
const { ok, created } = require('../../../shared/utils/response');

/**
 * Retrieve the current buyer's shopping cart.
 * Returns an empty cart structure if none exists yet.
 * 
 * @param {import('express').Request} req - Express request with authenticated user (req.user.id)
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function getCart(req, res, next) {
  try {
    const cart = await cartService.getUserCart(req.user.id);
    return ok(res, {
      cart: cart || {
        userId: req.user.id,
        items: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * Update the quantity of a specific product in the buyer's cart.
 * 
 * @param {import('express').Request} req - Express request with params { productId } and body { quantity }
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function updateCartItem(req, res, next) {
  try {
    const { productId } = req.params;
    const parsedQuantity = parseInt(req.body.quantity, 10);
    const quantity = Number.isNaN(parsedQuantity) ? 1 : Math.max(0, parsedQuantity);

    const cart = await cartService.updateItemQuantity(req.user.id, productId, quantity);
    if (!cart) {
      return res.status(404).json({
        success: false,
        code: 'CART_ITEM_NOT_FOUND',
        message: 'Cart item not found',
        errors: [],
      });
    }
    return ok(res, { cart });
  } catch (err) {
    return next(err);
  }
}

/**
 * Remove an item completely from the buyer's cart.
 * 
 * @param {import('express').Request} req - Express request with params { productId }
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function removeCartItem(req, res, next) {
  try {
    const { productId } = req.params;
    const cart = await cartService.removeItem(req.user.id, productId);
    if (!cart) {
      return res.status(404).json({
        success: false,
        code: 'CART_ITEM_NOT_FOUND',
        message: 'Cart item not found',
        errors: [],
      });
    }
    return ok(res, { cart });
  } catch (err) {
    return next(err);
  }
}

/**
 * Remove all items from the buyer's shopping cart.
 * 
 * @param {import('express').Request} req - Express request with authenticated user
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function clearCart(req, res, next) {
  try {
    const cart = await cartService.clearCart(req.user.id);
    return ok(res, { cart });
  } catch (err) {
    return next(err);
  }
}

/**
 * Add an item to the buyer's cart with optional delivery zone context.
 * The item addition itself is not blocked; if a delivery zone is provided,
 * an advisory warning is returned when the shop cannot deliver to the selected zone.
 * 
 * @param {import('express').Request} req - Express request with body { productId, quantity, zoneId, zoneName }
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
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
 * Authoritative zone and stock availability validation for all items in the buyer's cart.
 * Read-only validation: never mutates cart items or alters chosen zones.
 * 
 * @param {import('express').Request} req - Express request with body { zoneId, zoneName }
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
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
