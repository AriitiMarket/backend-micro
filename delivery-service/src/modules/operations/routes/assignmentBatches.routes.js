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
// Batch DETAIL is also the rider's own screen (it lists, then opens one). A
// provider may therefore read it — the controller proves the batch is theirs
// before answering, so this does not expose anybody else's work.
router.get('/batches/:id', authenticate, authorize(['ADMIN', 'PROVIDER']), ctrl.getBatchAssignment);
router.post('/batches/:id/reassign', authenticate, authorize('ADMIN'), ctrl.reassignBatchAssignment);
router.post('/batches/:id/cancel', authenticate, authorize('ADMIN'), ctrl.cancelBatchAssignment);

// --- Rider ---
router.get('/mine', authenticate, authorize('PROVIDER'), ctrl.listMyAssignments);
router.post('/batches/:id/respond', authenticate, authorize('PROVIDER'), ctrl.respondToBatch);
router.post('/batches/:id/pickup/start', authenticate, authorize('PROVIDER'), ctrl.startPickup);
router.post('/batches/:id/pickup/:sellerId/confirm', authenticate, authorize('PROVIDER'), ctrl.confirmPickup);
router.post('/batches/:id/transit/start', authenticate, authorize('PROVIDER'), ctrl.startTransit);
router.post('/batches/:id/orders/:orderId/deliver', authenticate, authorize('PROVIDER'), ctrl.confirmDelivery);

module.exports = router;