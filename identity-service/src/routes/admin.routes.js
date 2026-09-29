const express = require('express');
const router = express.Router();
const adminController = require('../controllers/admin.controller');
const notificationsController = require('../controllers/notifications.controller');
const authenticate = require('../middleware/authenticate');
const authorize = require('../middleware/authorize');
const requirePermission = require('../middleware/requirePermission');

// User management.
// The role gate (`authorize('ADMIN')`) is coarse and always applied first; the
// permission gate then narrows it for admins that have an explicit RBAC role
// assignment. An admin with the wildcard (which includes every admin that has no
// assignment yet) passes unchanged.
router.get('/admin/users', authenticate, authorize('ADMIN'), requirePermission('users.view'), adminController.listUsers);
router.get('/admin/users/:id', authenticate, authorize('ADMIN'), requirePermission('users.view'), adminController.getUser);
router.put('/admin/users/:id/role', authenticate, authorize('ADMIN'), requirePermission('users.manage'), adminController.setRole);
router.put('/admin/users/:id/status', authenticate, authorize('ADMIN'), requirePermission('users.manage'), adminController.setUserStatus);
router.put('/admin/users/:id/scope', authenticate, authorize('ADMIN'), requirePermission('users.manage'), adminController.setAdminScope);
router.get('/admin/users/:id/scope', authenticate, authorize('ADMIN'), requirePermission('users.view'), adminController.getAdminScope);

// Seller management (list sellers with status). Sellers are businesses in the
// platform model, so this is the `businesses.view` surface.
router.get('/admin/sellers', authenticate, authorize('ADMIN'), requirePermission('businesses.view'), adminController.listSellers);
router.get('/admin/sellers/:id', authenticate, authorize('ADMIN'), requirePermission('businesses.view'), adminController.getSeller);

// Dashboard stats (used for admin dashboard aggregation)
router.get('/admin/stats', authenticate, authorize('ADMIN'), requirePermission('dashboard.view'), adminController.getDashboardStats);

// Pending approvals stats
router.get('/admin/pending-stats', authenticate, authorize('ADMIN'), requirePermission('dashboard.view'), adminController.getPendingStats);

// Notifications
router.get('/admin/notifications', authenticate, authorize('ADMIN'), requirePermission('dashboard.view'), notificationsController.listNotifications);

module.exports = router;
