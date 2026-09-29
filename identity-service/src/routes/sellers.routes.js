// Internal seller identity routes — called only by other backend services
// (Commerce, Delivery) over the private network. Every route requires the
// dedicated internal service token; none of them are reachable by browsers.
//
// Note: there is deliberately NO token minting here. Only the OAuth 2.1 token
// endpoint issues tokens (authorization_code + PKCE S256 / refresh rotation).
const express = require('express');
const router = express.Router();
const sellersController = require('../controllers/sellers.controller');
const internalOnly = require('../middleware/internalOnly');

router.post('/internal/sellers/create', internalOnly, sellersController.createSeller);
router.post('/internal/sellers/link-shop', internalOnly, sellersController.linkShopId);
router.post('/internal/sellers/grant-role', internalOnly, sellersController.grantSellerRole);
router.post('/internal/sellers/set-status', internalOnly, sellersController.setSellerStatus);
router.post('/internal/sellers/suspend', internalOnly, sellersController.suspendSeller);
router.post('/internal/sellers/reactivate', internalOnly, sellersController.reactivateSeller);
router.post('/internal/sellers/status', internalOnly, sellersController.getSellerStatus);
router.get('/internal/users/:id', internalOnly, sellersController.findUserById);

module.exports = router;
