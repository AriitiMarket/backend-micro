const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/operations.controller');
const { authenticate } = require('../../../app/middleware/authenticate');
const authorize = require('../../../app/middleware/authorize');

// SELLER is scoped to its own deliveries in the controller (MVP §26).
router.get('/dashboard', authenticate, authorize(['ADMIN', 'SELLER']), ctrl.getDashboard);
router.get('/stats', authenticate, authorize('ADMIN'), ctrl.getDeliveryStats);
router.get('/recent', authenticate, authorize('ADMIN'), ctrl.getRecentDeliveries);
router.get('/expansion/:locationId', authenticate, authorize('ADMIN'), ctrl.getExpansionStatus);
router.post('/expansion/:locationId/activate', authenticate, authorize('ADMIN'), ctrl.bulkActivate);
router.post('/expansion/:locationId/deactivate', authenticate, authorize('ADMIN'), ctrl.bulkDeactivate);

module.exports = router;
