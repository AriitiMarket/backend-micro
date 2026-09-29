const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/assignmentBatches.controller');
const { authenticate } = require('../../../app/middleware/authenticate');
const authorize = require('../../../app/middleware/authorize');

/**
 * Multi-order assignment workflow:
 *   admin  -> ready orders -> batch assign -> (reassign / cancel)
 *   rider  -> accept/reject -> pickup per seller -> transit -> deliver per order
 *
 * Note: `/batches/...` paths are declared before the bare `/:id` style routes
 * so they are not swallowed by a parameter match.
 */

// --- Admin ---
router.get('/ready-orders', authenticate, authorize('ADMIN'), ctrl.listReadyOrders);
router.get('/batches', authenticate, authorize('ADMIN'), ctrl.listBatchAssignments);
router.post('/batches', authenticate, authorize('ADMIN'), ctrl.createBatchAssignment);
router.get('/batches/:id', authenticate, authorize('ADMIN'), ctrl.getBatchAssignment);
router.post('/batches/:id/reassign', authenticate, authorize('ADMIN'), ctrl.reassignBatchAssignment);
router.post('/batches/:id/cancel', authenticate, authorize('ADMIN'), ctrl.cancelBatchAssignment);

// --- Rider ---
router.get('/mine', authenticate, ctrl.listMyAssignments);
router.post('/batches/:id/respond', authenticate, ctrl.respondToBatch);
router.post('/batches/:id/pickup/start', authenticate, ctrl.startPickup);
router.post('/batches/:id/pickup/:sellerId/confirm', authenticate, ctrl.confirmPickup);
router.post('/batches/:id/transit/start', authenticate, ctrl.startTransit);
router.post('/batches/:id/orders/:orderId/deliver', authenticate, ctrl.confirmDelivery);

module.exports = router;