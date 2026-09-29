const express = require('express');
const router = express.Router();
const controller = require('../controllers/analytics.controller');
const { authenticate } = require('../../../app/middleware/authenticate');
const { authorize } = require('../../../app/middleware/authorize');

// Core analytics
router.get('/analytics/stats', authenticate, authorize('ADMIN'), controller.getStats);
router.get('/analytics/growth', authenticate, authorize('ADMIN'), controller.getUsersGrowth);
router.get('/analytics/orders-by-type', authenticate, authorize('ADMIN'), controller.getOrdersByType);
router.get('/analytics/sales-by-type', authenticate, authorize('ADMIN'), controller.getSalesByType);
router.get('/analytics/dashboard-users', authenticate, authorize('ADMIN'), controller.getDashboardUsers);
router.get('/analytics/pending-approvals', authenticate, authorize('ADMIN'), controller.getPendingApprovals);
router.get('/analytics/recent-activity', authenticate, authorize('ADMIN'), controller.getRecentActivity);

// Extended reports
router.get('/analytics/sales-over-time', authenticate, authorize('ADMIN'), controller.getSalesOverTime);
router.get('/analytics/orders-by-status', authenticate, authorize('ADMIN'), controller.getOrdersByStatus);
router.get('/analytics/category-activity', authenticate, authorize('ADMIN'), controller.getCategoryActivity);
router.get('/analytics/product-stats', authenticate, authorize('ADMIN'), controller.getProductStats);
router.get('/analytics/dispute-stats', authenticate, authorize('ADMIN'), controller.getDisputeStats);
router.get('/analytics/delivery-stats', authenticate, authorize('ADMIN'), controller.getDeliveryStats);
router.get('/analytics/rider-performance', authenticate, authorize('ADMIN'), controller.getRiderPerformance);
router.get('/analytics/shop-stats', authenticate, authorize('ADMIN'), controller.getShopStats);

module.exports = router;
