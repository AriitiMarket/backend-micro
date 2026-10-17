const express = require('express');
const router = express.Router();
const controller = require('../controllers/adminPlatform.controller');
const { authenticate } = require('../../../app/middleware/authenticate');
const { authorize } = require('../../../app/middleware/authorize');

/**
 * Platform Admin Routes
 * All routes require an ADMIN account. The API Gateway applies the specific
 * RBAC permission: operational users may view daily operations, while only
 * users with businesses.manage can approve or reject businesses.
 */

// Platform Overview
router.get('/platform/stats', authenticate, authorize('ADMIN'), controller.getPlatformStats);
router.get('/platform/pending', authenticate, authorize('ADMIN'), controller.getPendingActions);
router.get('/platform/hierarchy', authenticate, authorize('ADMIN'), controller.getHierarchy);

// Hierarchical Exploration
router.get('/businesses', authenticate, authorize('ADMIN'), controller.getBusinesses);
router.get('/businesses/:applicationId', authenticate, authorize('ADMIN'), controller.getBusinessDetail);
router.get('/shops', authenticate, authorize('ADMIN'), controller.getShops);
router.get('/orders', authenticate, authorize('ADMIN'), controller.getOrders);

// Live operations — orders grouped by real (mapped) operational stage
router.get('/operations', authenticate, authorize('ADMIN'), controller.getOperationsOverview);
router.get('/operations/:stage', authenticate, authorize('ADMIN'), controller.getOperationsOrders);

// Business Management
router.post('/businesses/:applicationId/approve', authenticate, authorize('ADMIN'), controller.approveBusiness);
router.post('/businesses/:applicationId/reject', authenticate, authorize('ADMIN'), controller.rejectBusiness);

// Order Tracking
router.get('/orders/:orderId/pickup-delivery', authenticate, authorize('ADMIN'), controller.getOrderPickupDelivery);

// Analytics
router.get('/growth-analytics', authenticate, authorize('ADMIN'), controller.getGrowthAnalytics);

module.exports = router;
