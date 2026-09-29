const wishlistService = require('../services/wishlists.service');
const { ok } = require('../../../shared/utils/response');

function emptyWishlist(userId) {
  return { userId, items: [], createdAt: new Date(), updatedAt: new Date() };
}

async function addToWishlist(req, res, next) {
  try {
    const wishlist = await wishlistService.addItem(req.user.id, req.body);
    return ok(res, { wishlist });
  } catch (err) {
    return next(err);
  }
}

async function getWishlist(req, res, next) {
  try {
    const wishlist = await wishlistService.getUserWishlist(req.user.id);
    return ok(res, { wishlist: wishlist || emptyWishlist(req.user.id) });
  } catch (err) {
    return next(err);
  }
}

async function checkWishlist(req, res, next) {
  try {
    const { wishlisted } = await wishlistService.isWishlisted(req.user.id, req.params.productId);
    return ok(res, { wishlisted });
  } catch (err) {
    return next(err);
  }
}

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

async function clearWishlist(req, res, next) {
  try {
    await wishlistService.clearWishlist(req.user.id);
    return ok(res, { wishlist: emptyWishlist(req.user.id) });
  } catch (err) {
    return next(err);
  }
}

module.exports = { addToWishlist, getWishlist, checkWishlist, removeFromWishlist, clearWishlist };
