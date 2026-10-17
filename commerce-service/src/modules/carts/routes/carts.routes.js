const express = require('express');
const router = express.Router();
const cartController = require('../controllers/carts.controller');
const { authenticate } = require('../../../app/middleware/authenticate');

router.post('/', authenticate, cartController.addToCart);
// Zone + availability validation for the WHOLE cart — must precede
// `/:productId` style routes in intent (it is its own POST path, so no
// parameterized POST exists to shadow it).
router.post('/validate', authenticate, cartController.validateCartForZone);
router.get('/', authenticate, cartController.getCart);
router.put('/:productId', authenticate, cartController.updateCartItem);
router.delete('/:productId', authenticate, cartController.removeCartItem);
router.delete('/', authenticate, cartController.clearCart);

module.exports = router;
