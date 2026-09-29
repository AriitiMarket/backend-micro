// Internal provider identity routes — called only by the Delivery Service over
// the private network when a provider application is approved. Guarded by the
// dedicated internal service token; never reachable by browsers.
const express = require('express');
const router = express.Router();
const providersController = require('../controllers/providers.controller');
const internalOnly = require('../middleware/internalOnly');

router.post('/internal/providers/grant-role', internalOnly, providersController.grantProviderRole);
router.post('/internal/providers/set-status', internalOnly, providersController.setProviderStatus);
router.post('/internal/providers/status', internalOnly, providersController.getProviderStatus);

module.exports = router;
