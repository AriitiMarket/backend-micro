const express = require('express');
const orderSLAController = require('../controllers/orderSLA.controller');
const { authenticate } = require('../../../app/middleware/authenticate');
const { authorize } = require('../../../app/middleware/authorize');

const router = express.Router();

// The static routes are registered BEFORE the `/:orderId/...` ones so the
// literal paths always win. `/seller/breaches` does not collide with
// `/:orderId/compliance` (the second segment has to be the literal
// "compliance"), but keeping the literals first means a future
// `/:orderId/breaches`-style route can never shadow them by accident.
router.get('/seller/breaches', authenticate, authorize(['SELLER', 'ADMIN']), orderSLAController.getBreaches);
router.post('/breaches', authenticate, authorize('ADMIN'), orderSLAController.createBreach);

router.post('/', authenticate, authorize(['SELLER', 'ADMIN']), orderSLAController.setSLA);
router.get('/:orderId/compliance', authenticate, authorize(['BUYER', 'SELLER', 'ADMIN']), orderSLAController.checkCompliance);
router.get('/:orderId/status', authenticate, authorize(['BUYER', 'SELLER', 'ADMIN']), orderSLAController.getStatus);

module.exports = router;
