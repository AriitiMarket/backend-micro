const express = require('express');
const router = express.Router();
const wishlistController = require('../controllers/wishlists.controller');
const { authenticate } = require('../../../app/middleware/authenticate');

router.post('/', authenticate, wishlistController.addToWishlist);
router.get('/', authenticate, wishlistController.getWishlist);
router.get('/:productId', authenticate, wishlistController.checkWishlist);
router.delete('/:productId', authenticate, wishlistController.removeFromWishlist);
router.delete('/', authenticate, wishlistController.clearWishlist);

module.exports = router;
