const express = require('express');
const router = express.Router();
const allocationController = require('../controllers/allocation.controller');
const { authenticate } = require('../../../app/middleware/authenticate');
const { authorize } = require('../../../app/middleware/authorize');

// Seller: their own allocations only (ownership enforced in the controller).
router.get('/seller-allocations/:sellerId', authenticate, authorize('SELLER'), allocationController.getSellerAllocations);

// Create / refresh seller-level allocations for a confirmed order.
// Idempotent: safe to call repeatedly (e.g. after a confirmed payment from any
// rail). Ownership is enforced in the controller (buyer / owning seller / admin).
router.post('/allocate/:orderId', authenticate, allocationController.allocateOrder);

// Admin: allocation audit & reporting (ADMIN only).
router.get('/admin/allocations', authenticate, authorize('ADMIN'), allocationController.getAdminAllocations);
router.get('/admin/allocations/:orderId', authenticate, authorize('ADMIN'), allocationController.getAdminOrderAllocations);
router.post('/admin/settlements/:allocationId', authenticate, authorize('ADMIN'), allocationController.settleAllocation);
router.post('/admin/allocations/:allocationId/refund', authenticate, authorize('ADMIN'), allocationController.refundAllocation);

module.exports = router;
