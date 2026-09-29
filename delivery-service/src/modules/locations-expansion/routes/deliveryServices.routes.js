const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/deliveryServices.controller');
const { authenticate } = require('../../../app/middleware/authenticate');
const authorize = require('../../../app/middleware/authorize');

// Delivery service catalog — name/code, type, fees, capacity, coverage.
router.get('/', authenticate, authorize('ADMIN'), ctrl.getServices);
router.get('/:id', authenticate, authorize('ADMIN'), ctrl.getService);
router.post('/', authenticate, authorize('ADMIN'), ctrl.createService);
router.put('/:id', authenticate, authorize('ADMIN'), ctrl.updateService);
router.delete('/:id', authenticate, authorize('ADMIN'), ctrl.deleteService);

module.exports = router;
