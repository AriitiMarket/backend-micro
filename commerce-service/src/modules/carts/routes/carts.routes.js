const express = require('express');
const router = express.Router();
const cartController = require('../controllers/carts.controller');
const { authenticate } = require('../../../app/middleware/authenticate');

router.post('/', authenticate, cartController.addToCart);
router.get('/', authenticate, cartController.getCart);
router.put('/:productId', authenticate, cartController.updateCartItem);
router.delete('/:productId', authenticate, cartController.removeCartItem);
router.delete('/', authenticate, cartController.clearCart);

module.exports = router;
