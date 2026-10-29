// Buyer Wishlist Controller — manages buyer saved favorite items and collections.
'use strict';

const wishlistService = require('../services/wishlists.service');
const { ok } = require('../../../shared/utils/response');

/**
 * Generate a consistent fallback empty wishlist structure for a user.
 * 
 * @param {string} userId - The buyer's ID
 * @returns {object} Empty wishlist payload
 */
function emptyWishlist(userId) {
  return {
    userId,
    items: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/**
 * Add a product or variant to the authenticated buyer's wishlist.
 * 
 * @param {import('express').Request} req - Express request with req.user.id and req.body item details
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function addToWishlist(req, res, next) {
  try {
    const wishlist = await wishlistService.addItem(req.user.id, req.body || {});
    return ok(res, { wishlist });
  } catch (err) {
    return next(err);
  }
}

/**
 * Retrieve the current authenticated buyer's wishlist.
 * Returns an empty wishlist structure if no wishlist has been created yet.
 * 
 * @param {import('express').Request} req - Express request with authenticated req.user.id
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function getWishlist(req, res, next) {
  try {
    const wishlist = await wishlistService.getUserWishlist(req.user.id);
    return ok(res, { wishlist: wishlist || emptyWishlist(req.user.id) });
  } catch (err) {
    return next(err);
  }
}

/**
 * Check whether a specific product is currently saved in the buyer's wishlist.
 * 
 * @param {import('express').Request} req - Express request with params { productId }
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function checkWishlist(req, res, next) {
  try {
    const { wishlisted } = await wishlistService.isWishlisted(req.user.id, req.params.productId);
    return ok(res, { wishlisted: Boolean(wishlisted) });
  } catch (err) {
    return next(err);
  }
}

/**
 * Remove a specific product from the authenticated buyer's wishlist.
 * Returns 404 with structured error envelope if the item is not present.
 * 
 * @param {import('express').Request} req - Express request with params { productId }
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function removeFromWishlist(req, res, next) {
  try {
    const wishlist = await wishlistService.removeItem(req.user.id, req.params.productId);
    if (!wishlist) {
      return res.status(404).json({
        success: false,
        code: 'WISHLIST_ITEM_NOT_FOUND',
        message: 'Wishlist item not found',
        errors: [],
      });
    }
    return ok(res, { wishlist });
  } catch (err) {
    return next(err);
  }
}

/**
 * Clear all items from the authenticated buyer's wishlist.
 * 
 * @param {import('express').Request} req - Express request with req.user.id
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next error handler
 */
async function clearWishlist(req, res, next) {
  try {
    await wishlistService.clearWishlist(req.user.id);
    return ok(res, { wishlist: emptyWishlist(req.user.id) });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  addToWishlist,
  getWishlist,
  checkWishlist,
  removeFromWishlist,
  clearWishlist,
};

