const express = require('express');
const router = express.Router();
const allocationController = require('../controllers/allocation.controller');
const { authenticate } = require('../../../app/middleware/authenticate');
const { authorize } = require('../../../app/middleware/authorize');

// Seller: their own allocations only (ownership enforced in the controller).
router.get('/seller-allocations/:sellerId', authenticate, authorize('SELLER'), allocationController.getSellerAllocations);

// Admin: allocation audit & reporting (ADMIN only).
router.get('/admin/allocations', authenticate, authorize('ADMIN'), allocationController.getAdminAllocations);
router.get('/admin/allocations/:orderId', authenticate, authorize('ADMIN'), allocationController.getAdminOrderAllocations);
router.post('/admin/settlements/:allocationId', authenticate, authorize('ADMIN'), allocationController.settleAllocation);
router.post('/admin/allocations/:allocationId/refund', authenticate, authorize('ADMIN'), allocationController.refundAllocation);

module.exports = router;
