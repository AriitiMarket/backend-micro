const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/delivery-fulfillment.controller');
const { authenticate } = require('../../../app/middleware/authenticate');
const authorize = require('../../../app/middleware/authorize');

router.get('/order/:orderId', authenticate, authorize(['BUYER', 'SELLER', 'PROVIDER', 'ADMIN']), ctrl.getDeliveryByOrderId);
router.get('/', authenticate, authorize(['BUYER', 'SELLER', 'PROVIDER', 'ADMIN']), ctrl.getDeliveries);
router.get('/:id/history', authenticate, authorize(['BUYER', 'SELLER', 'PROVIDER', 'ADMIN']), ctrl.getDeliveryHistory);
router.get('/:id', authenticate, authorize(['BUYER', 'SELLER', 'PROVIDER', 'ADMIN']), ctrl.getDelivery);
router.post('/', authenticate, authorize('ADMIN'), ctrl.createDelivery);
router.put('/:id/status', authenticate, authorize('ADMIN'), ctrl.updateStatus);
router.put('/:id/assign', authenticate, authorize('ADMIN'), ctrl.assignDelivery);
router.post('/initiate', authenticate, authorize('ADMIN'), ctrl.createDelivery);

module.exports = router;
