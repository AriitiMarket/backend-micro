const express = require('express');
const router = express.Router();
const adminRolesController = require('../controllers/admin-roles.controller');
const authenticate = require('../middleware/authenticate');
const authorize = require('../middleware/authorize');
const requirePermission = require('../middleware/requirePermission');

// Role & permission management is the privilege-escalation surface, so it is the
// place where the permission gate matters most: an admin restricted to, say,
// disputes cannot grant itself more access.

// Permission management
router.get('/admin/permissions', authenticate, authorize('ADMIN'), requirePermission('admin_roles.view'), adminRolesController.listPermissions);
router.get('/admin/permissions/by-module', authenticate, authorize('ADMIN'), requirePermission('admin_roles.view'), adminRolesController.listPermissionsByModule);

// Role management
router.get('/admin/roles', authenticate, authorize('ADMIN'), requirePermission('admin_roles.view'), adminRolesController.listRoles);
router.get('/admin/roles/:id', authenticate, authorize('ADMIN'), requirePermission('admin_roles.view'), adminRolesController.getRole);
router.post('/admin/roles', authenticate, authorize('ADMIN'), requirePermission('admin_roles.manage'), adminRolesController.createRole);
router.put('/admin/roles/:id', authenticate, authorize('ADMIN'), requirePermission('admin_roles.manage'), adminRolesController.updateRole);
router.delete('/admin/roles/:id', authenticate, authorize('ADMIN'), requirePermission('admin_roles.manage'), adminRolesController.deleteRole);

// User-role assignments
router.get('/admin/user-roles', authenticate, authorize('ADMIN'), requirePermission('admin_roles.view'), adminRolesController.getAllUserRoles);
router.get('/admin/users/:userId/roles', authenticate, authorize('ADMIN'), requirePermission('admin_roles.view'), adminRolesController.getUserRoles);
router.get('/admin/users/:userId/permissions', authenticate, authorize('ADMIN'), requirePermission('admin_roles.view'), adminRolesController.getEffectivePermissions);
router.post('/admin/users/:userId/roles/:roleId', authenticate, authorize('ADMIN'), requirePermission('admin_roles.manage'), adminRolesController.assignRole);
router.delete('/admin/users/:userId/roles/:roleId', authenticate, authorize('ADMIN'), requirePermission('admin_roles.manage'), adminRolesController.removeRole);

module.exports = router;
