/**
 * Permission Enforcement Middleware
 *
 * Validates that the authenticated admin has the required permissions
 * before allowing access to protected endpoints.
 *
 * Implements the 2-role system:
 * - SUPER_ADMIN: has all permissions (wildcard '*')
 * - OPERATIONS_ADMIN: restricted permissions (operations only)
 */

const env = require('../config/env');

/**
 * Maps endpoints to required permissions.
 * Format: "METHOD /path" → ['permission.key', ...]
 *
 * If an endpoint is not in this map, it is denied by default (fail-secure).
 */
const ENDPOINT_PERMISSIONS = {
  // ── Authentication (public, no permission required) ──
  // These endpoints are unauthenticated or for session management.
  // Wildcard '*' means "allow all" — either public access or just needs to be authenticated.
  'POST /auth/authorize': ['*'],
  'POST /auth/token': ['*'],
  'POST /auth/refresh': ['*'],
  'POST /auth/revoke': ['*'],
  'POST /auth/register': ['*'],
  'POST /auth/register/:role': ['*'],
  'GET /user/getuser': ['*'],

  // ── Admin Management (SUPER_ADMIN only) ──
  'GET /admin/admins': ['admin_roles.view'],
  'GET /admin/admins/:id': ['admin_roles.view'],
  'POST /admin/admins': ['admin_roles.manage'],
  'PUT /admin/admins/:id': ['admin_roles.manage'],
  'DELETE /admin/admins/:id': ['admin_roles.manage'],

  // ── Admin Roles & Permissions (SUPER_ADMIN only) ──
  'GET /admin/admin-roles': ['admin_roles.view'],
  'GET /admin/admin-roles/:id': ['admin_roles.view'],
  'POST /admin/admin-roles': ['admin_roles.manage'],
  'PUT /admin/admin-roles/:id': ['admin_roles.manage'],
  'DELETE /admin/admin-roles/:id': ['admin_roles.manage'],
  'GET /admin/permissions': ['*'],
  'GET /admin/permissions/by-module': ['*'],
  'GET /admin/user-roles': ['*'],
  'GET /admin/user-roles/:userId': ['admin_roles.view'],
  'GET /admin/roles': ['admin_roles.view'],
  'POST /admin/user-roles/:userId/:roleId': ['admin_roles.manage'],
  'DELETE /admin/user-roles/:userId/:roleId': ['admin_roles.manage'],

  // ── Audit Logs (SUPER_ADMIN only) ──
  'GET /admin/audit-logs': ['audit.view'],
  'GET /admin/audit-logs/:id': ['audit.view'],
  'GET /admin/audit-logs/filters': ['audit.view'],
  'GET /admin/audit-logs/stats': ['audit.view'],
  'DELETE /admin/audit-logs': ['audit.manage'],

  // ── Locations & Zones (SUPER_ADMIN only) ──
  'GET /delivery/location': ['locations.view'],
  'POST /delivery/location': ['locations.manage'],
  'GET /delivery/location/hierarchy': ['locations.view'],
  'GET /delivery/location/:id': ['locations.view'],
  'PUT /delivery/location/:id': ['locations.manage'],
  'PUT /delivery/location/:id/activate': ['locations.manage'],
  'PUT /delivery/location/:id/deactivate': ['locations.manage'],
  'GET /delivery/zone/location/:locationId': ['locations.view'],
  'POST /delivery/zone': ['locations.manage'],
  'GET /delivery/zone': ['locations.view'],

  // ── Platform Settings (SUPER_ADMIN only) ──
  'GET /settings/platform': ['platform_settings.view'],
  'PUT /settings/platform': ['platform_settings.manage'],
  'GET /settings/notifications': ['platform_settings.view'],
  'PUT /settings/notifications': ['platform_settings.manage'],
  'GET /settings/system': ['platform_settings.view'],
  'PUT /settings/system': ['platform_settings.manage'],

  // ── Users, Orders, Disputes (both roles) ──
  'GET /admin/users': ['*'],
  'GET /admin/users/:id': ['*'],
  'PUT /admin/users/:id/status': ['*'],
  'GET /admin/sellers': ['*'],
  'GET /admin/sellers/:id': ['*'],
  'GET /admin/businesses': ['*'],
  'GET /admin/businesses/:id': ['*'],
  'POST /admin/businesses/:id/approve': ['*'],
  'POST /admin/businesses/:id/reject': ['*'],
  'GET /admin/shops': ['*'],
  'GET /shop/admin/shops': ['*'],
  'GET /shop/admin/shops/pending': ['*'],
  'GET /order/admin': ['*'],
  'GET /order/admin/:id': ['*'],
  'GET /admin/orders': ['*'],
  'PATCH /order/admin/:id': ['*'],
  'GET /disputes': ['*'],
  'PATCH /disputes/:id/status': ['*'],

  // ── Delivery Operations (both roles) ──
  'GET /delivery/actor': ['*'],
  'GET /delivery/actor/:id': ['*'],
  'POST /delivery/actor/:id/approve': ['*'],
  'PUT /delivery/actor/:id/status': ['*'],
  'GET /delivery/operation/dashboard': ['*'],
  'GET /delivery/operation/:stage': ['*'],
  'GET /delivery/port': ['*'],
  'GET /delivery/service': ['*'],
  'GET /delivery/request': ['*'],
  'GET /delivery/delivery': ['*'],

  // ── Analytics & Reports (both roles) ──
  'GET /analytics/stats': ['*'],
  'GET /analytics/growth': ['*'],
  'GET /analytics/orders-by-type': ['*'],
  'GET /admin/growth-analytics': ['*'],
  'GET /admin/platform/stats': ['*'],
  'GET /admin/platform/pending': ['*'],
  'GET /admin/platform/hierarchy': ['*'],

  // ── Catalog (both roles) ──
  'GET /category': ['*'],
  'GET /sector': ['*'],
  'GET /order/admin/reviews/pending': ['*'],

  // ── Products & Catalog (both roles) ──
  'GET /product/get-all-products': ['*'],
  'GET /product/:id': ['*'],
  'POST /product': ['*'],
  'PUT /product/:id': ['*'],
  'DELETE /product/:id': ['*'],

  // ── Payments (both roles) ──
  'GET /payment/get-all-payments': ['*'],
  'GET /payment/:id': ['*'],

  // ── Seller Applications (both roles) ──
  'GET /seller-application': ['*'],
  'GET /seller-application/:id': ['*'],
  'POST /seller-application': ['*'],
  'PATCH /seller-application/:id/status': ['*'],

  // ── Requests (both roles) ──
  'GET /request/admin': ['*'],
  'GET /request/admin/:id': ['*'],
  'GET /request/admin/stats': ['*'],
  'POST /request': ['*'],
  'PATCH /request/:id/status': ['*'],

  // ── Notifications (both roles) ──
  'GET /admin/notifications': ['*'],
};

/**
 * Normalize a request path to match the ENDPOINT_PERMISSIONS keys.
 * Converts dynamic segments like :id to :id for matching.
 *
 * Example: /admin/users/123 → /admin/users/:id
 */
function normalizePathForMatching(method, path) {
  // Remove query string
  const pathOnly = path.split('?')[0];

  // Replace UUIDs and numeric IDs with :id
  const normalized = pathOnly.replace(/\/[a-f0-9\-]{36}|\d+(?=\/|$)/g, ':id');

  return `${method} ${normalized}`;
}

/**
 * Check if user has the required permission.
 * - Wildcard '*' grants all permissions
 * - Otherwise check if the specific permission is in the user's list
 */
function hasPermission(userPermissions, requiredPermissions) {
  if (!Array.isArray(userPermissions)) return false;
  if (!Array.isArray(requiredPermissions)) return false;

  // Wildcard check (both for user and requirement)
  if (userPermissions.includes('*')) return true;
  if (requiredPermissions.includes('*')) return true;

  // Check if user has at least one of the required permissions
  return requiredPermissions.some(perm => userPermissions.includes(perm));
}

/**
 * Permission enforcement middleware.
 *
 * Applies to all /admin/* and /delivery/* endpoints that deal with admin operations.
 */
function enforcePermissions(req, res, next) {
  // Extract user info from request — the token carries admin authorization
  const token = req.token || {};
  const userPermissions = Array.isArray(token.permissions) ? token.permissions : [];

  // Construct the endpoint key
  const endpointKey = normalizePathForMatching(req.method, req.path);

  // Look up required permissions
  const requiredPermissions = ENDPOINT_PERMISSIONS[endpointKey];

  // If endpoint is not in the map, deny by default (fail-secure)
  if (!requiredPermissions) {
    if (env.nodeEnv === 'development') {
      console.warn(`[enforcePermissions] Unmapped endpoint: ${endpointKey}`);
    }

    return res.status(403).json({
      success: false,
      code: 'PERMISSION_UNCONFIGURED',
      message: 'Endpoint permissions not configured',
      endpoint: endpointKey,
    });
  }

  // Check if user has permission
  if (!hasPermission(userPermissions, requiredPermissions)) {
    if (env.nodeEnv === 'development') {
      console.warn(
        `[enforcePermissions] Access denied for ${token.sub} to ${endpointKey}. Required: ${requiredPermissions.join(', ')}, User has: ${userPermissions.join(', ')}`
      );
    }

    return res.status(403).json({
      success: false,
      code: 'INSUFFICIENT_PERMISSIONS',
      message: 'Insufficient permissions for this action',
      required: requiredPermissions,
      userHas: userPermissions,
    });
  }

  // Permission granted, proceed
  next();
}

module.exports = enforcePermissions;
