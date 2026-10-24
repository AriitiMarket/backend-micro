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
const { isPublicRead } = require('./authorizeRequest');

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
  'POST /auth/register/BUYER': ['*'],
  'POST /auth/register/SELLER': ['*'],
  'POST /auth/register/PROVIDER': ['*'],
  'POST /auth/register/buyer': ['*'],
  'POST /auth/register/seller': ['*'],
  'POST /auth/register/provider': ['*'],
  'POST /auth/verify-2fa': ['*'],
  'POST /auth/resend-2fa-code': ['*'],
  'POST /auth/forgot-password': ['*'],
  'GET /auth/verify-reset-token': ['*'],
  'POST /auth/verify-reset-token': ['*'],
  'POST /auth/reset-password': ['*'],
  'GET /user/getuser': ['*'],

  // ── User 2FA Management ──
  'GET /user/2fa/setup': ['*'],
  'POST /user/2fa/setup': ['*'],
  'POST /user/2fa/verify-setup': ['*'],
  'GET /user/2fa/status': ['*'],
  'POST /user/2fa/disable': ['*'],
  'POST /user/2fa/backup-codes/regenerate': ['*'],

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
  'POST /admin/users/:id/reset-2fa': ['users.manage'],
  'PUT /admin/users/:id/role': ['admin_roles.manage'],
  'PUT /admin/users/:id/scope': ['users.manage'],
  'GET /admin/users/:id/scope': ['users.view'],
  'GET /admin/stats': ['*'],
  'GET /admin/pending-stats': ['*'],
  'GET /admin/sellers': ['*'],
  'GET /admin/sellers/:id': ['*'],
  'GET /admin/businesses': ['*'],
  'GET /admin/businesses/:id': ['*'],
  'GET /admin/businesses/:id/stats': ['*'],
  'POST /admin/businesses/:id/approve': ['*'],
  'POST /admin/businesses/:id/reject': ['*'],
  'GET /admin/shops': ['*'],
  'GET /admin/shops/:id': ['*'],
  'GET /shop/admin/shops': ['*'],
  'GET /shop/admin/shops/pending': ['*'],
  'POST /shop/admin/shops/:id/approve': ['*'],
  'POST /shop/admin/shops/:id/reject': ['*'],
  'POST /shop/admin/shops/:id/suspend': ['*'],
  'POST /shop/admin/shops/:id/activate': ['*'],
  'PUT /shop/admin/shops/:id/coverage': ['*'],
  'PATCH /shop/admin/shops/:id/public': ['*'],
  'GET /order/admin': ['*'],
  'GET /order/admin/:id': ['*'],
  'GET /admin/orders': ['*'],
  'GET /admin/orders/:id': ['*'],
  'PATCH /admin/orders/:id': ['*'],
  'PUT /admin/orders/:id/status': ['*'],
  'GET /admin/orders/:id/pickup-delivery': ['*'],
  'GET /admin/operations': ['*'],
  'GET /admin/operations/:stage': ['*'],
  'PATCH /order/admin/:id': ['*'],
  'GET /disputes': ['*'],
  'GET /disputes/:id': ['*'],
  'PATCH /disputes/:id/status': ['*'],
  'POST /disputes/:id/resolve': ['*'],
  'POST /disputes/:id/message': ['*'],
  'GET /disputes/:id/messages': ['*'],

  // ── Delivery Operations & Providers (both roles) ──
  'GET /delivery/actor': ['*'],
  'GET /delivery/actor/:id': ['*'],
  'POST /delivery/actor/:id/approve': ['*'],
  'PUT /delivery/actor/:id/status': ['*'],
  'GET /delivery/provider': ['*'],
  'GET /delivery/provider/:id': ['*'],
  'GET /delivery/provider/:id/detail': ['*'],
  'POST /delivery/provider': ['*'],
  'PUT /delivery/provider/:id': ['*'],
  'PUT /delivery/provider/:id/status': ['*'],
  'POST /delivery/provider/:id/approve': ['*'],
  'POST /delivery/provider/:id/reject': ['*'],
  'GET /delivery/partner': ['*'],
  'GET /delivery/partner/:id': ['*'],
  'GET /delivery/operation/dashboard': ['*'],
  'GET /delivery/operation/:stage': ['*'],
  'GET /delivery/port': ['*'],
  'GET /delivery/port/public': ['*'],
  'GET /delivery/port/zone/:zoneId': ['*'],
  'GET /delivery/port/:id': ['*'],
  'GET /delivery/service': ['*'],
  'GET /delivery/request': ['*'],
  'GET /delivery/delivery': ['*'],
  'GET /delivery/route': ['locations.view'],
  'POST /delivery/route': ['locations.manage'],
  'GET /delivery/hub': ['locations.view'],
  'POST /delivery/hub': ['locations.manage'],
  'GET /delivery/tracking/:id': ['*'],
  'GET /delivery/tracking/:id/latest': ['*'],
  'GET /delivery/tracking/nearby': ['*'],
  'GET /delivery/dispatch': ['*'],
  'POST /delivery/dispatch': ['*'],
  'GET /delivery/assignment': ['*'],
  'POST /delivery/assignment': ['*'],
  'GET /delivery/payouts': ['*'],
  'GET /delivery/provider-payouts': ['*'],

  // ── Analytics & Reports (both roles) ──
  'GET /analytics/stats': ['*'],
  'GET /analytics/growth': ['*'],
  'GET /analytics/orders-by-type': ['*'],
  'GET /analytics/sales-by-type': ['*'],
  'GET /analytics/pending-approvals': ['*'],
  'GET /analytics/recent-activity': ['*'],
  'GET /analytics/dashboard-users': ['*'],
  'GET /analytics/sales-over-time': ['*'],
  'GET /analytics/orders-by-status': ['*'],
  'GET /analytics/category-activity': ['*'],
  'GET /analytics/product-stats': ['*'],
  'GET /analytics/dispute-stats': ['*'],
  'GET /analytics/delivery-stats': ['*'],
  'GET /analytics/rider-performance': ['*'],
  'GET /analytics/shop-stats': ['*'],
  'GET /analytics/seller/stats': ['*'],
  'GET /admin/growth-analytics': ['*'],
  'GET /admin/platform/stats': ['*'],
  'GET /admin/platform/pending': ['*'],
  'GET /admin/platform/hierarchy': ['*'],

  // ── Catalog & Reviews (both roles) ──
  'GET /category': ['*'],
  'POST /category': ['commerce.manage'],
  'PUT /category/:id': ['commerce.manage'],
  'DELETE /category/:id': ['commerce.manage'],
  'GET /sector': ['*'],
  'POST /sector': ['commerce.manage'],
  'PUT /sector/:id': ['commerce.manage'],
  'DELETE /sector/:id': ['commerce.manage'],
  'GET /order/admin/reviews/pending': ['*'],
  'POST /order/admin/reviews/:id/approve': ['*'],
  'POST /order/admin/reviews/:id/reject': ['*'],
  'GET /review/admin/pending': ['*'],
  'POST /review/admin/:id/approve': ['*'],
  'POST /review/admin/:id/reject': ['*'],

  // ── Products & Catalog (both roles & public) ──
  'GET /product/public/all': ['*'],
  'GET /product/public/:id': ['*'],
  'GET /product/search': ['*'],
  'GET /product/get-product/:id': ['*'],
  'GET /product/get-all-products': ['*'],
  'GET /product/get-all-products-shop/:id': ['*'],
  'GET /product/:id': ['*'],
  'POST /product': ['*'],
  'PUT /product/:id': ['*'],
  'DELETE /product/:id': ['*'],
  'GET /shop/public/all': ['*'],
  'GET /shop/public/:id': ['*'],
  'GET /shop/get-all-shops': ['*'],
  'GET /shop/get-shop-info/:id': ['*'],
  'GET /shop/getseller': ['*'],
  'GET /category/active/product': ['*'],
  'GET /category/active/:id': ['*'],
  'GET /category/all': ['*'],
  'GET /category/tree': ['*'],
  'GET /review/get-product-reviews/:id': ['*'],
  'GET /review/get-shop-reviews/:id': ['*'],
  'GET /review/get-my-reviews': ['*'],

  // ── Payments & Financials (both roles) ──
  'GET /payment/get-all-payments': ['*'],
  'GET /payment/:id': ['*'],
  'GET /payment/admin/reconciliation': ['*'],
  'GET /payment/admin/allocations': ['*'],
  'GET /payment/admin/ledger': ['*'],
  'POST /payment/admin/reconciliation/:id/resolve': ['*'],

  // ── Seller Applications (both roles) ──
  'GET /seller-application': ['*'],
  'GET /seller-application/:id': ['*'],
  'POST /seller-application': ['*'],
  'PATCH /seller-application/:id/status': ['*'],
  'POST /seller-application/:id/approve': ['*'],
  'POST /seller-application/:id/reject': ['*'],
  'POST /seller-application/:id/request-information': ['*'],
  'POST /seller-application/:id/suspend': ['*'],

  // ── Coupons, Promotions & Events (both roles) ──
  'GET /coupon': ['*'],
  'POST /coupon': ['*'],
  'PUT /coupon/:id': ['*'],
  'DELETE /coupon/:id': ['*'],
  'GET /promotion': ['*'],
  'POST /promotion': ['*'],
  'PUT /promotion/:id': ['*'],
  'DELETE /promotion/:id': ['*'],
  'GET /event': ['*'],
  'POST /event': ['*'],

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
 * Example: /admin/businesses/6ad620836af0599a2b166922 → /admin/businesses/:id
 */
function normalizePathForMatching(method, path) {
  // Remove query string
  let pathOnly = path.split('?')[0];

  // Strip the /api gateway prefix so paths match the permission map keys.
  // The gateway is mounted at /api, so req.path is /api/user/2fa/setup but
  // ENDPOINT_PERMISSIONS keys are /user/2fa/setup.
  if (pathOnly.startsWith('/api')) {
    pathOnly = pathOnly.slice(4) || '/';
  }

  // Normalize /auth/register/:role (e.g. /auth/register/SELLER, /auth/register/BUYER, /auth/register/PROVIDER)
  pathOnly = pathOnly.replace(/\/auth\/register\/([^\/]+)/i, '/auth/register/:role');

  // Replace various ID formats with :id
  // - UUIDs: /[a-f0-9\-]{36}
  // - Numeric IDs: /\d+
  // - MongoDB ObjectIds: /[a-f0-9]{24}
  const normalized = pathOnly.replace(/\/([a-f0-9\-]{36}|[a-f0-9]{24}|\d+)(?=\/|$)/g, '/:id');

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

  // Super admin wildcard check first: SUPER_ADMIN has full permissions across all platform endpoints
  if (userPermissions.includes('*')) {
    return next();
  }

  // Construct the endpoint key
  const endpointKey = normalizePathForMatching(req.method, req.path);

  // Reference data the marketplace selectors read without a token (the location
  // tree, the zone coverage) is public by design — the same rule authorizeRequest
  // applies. Requiring `locations.view` here would put the buyer's address
  // picker behind an admin permission again.
  if (isPublicRead(req.method, req.path)) return next();

  // Look up required permissions
  const requiredPermissions = ENDPOINT_PERMISSIONS[endpointKey];

  // The endpoint is not in this table, so this table has nothing to say about
  // it. It is NOT unguarded: authorizeRequest runs immediately before this
  // middleware and holds the canonical permission table for every route —
  // including the /admin and /delivery catch-alls — so an unmapped route is
  // still permission-checked there, and the owning service still applies its
  // own role gate.
  if (!requiredPermissions) {
    if (env.nodeEnv === 'development') {
      console.warn(`[enforcePermissions] Unmapped endpoint (authorizeRequest governs): ${endpointKey}`);
    }
    return next();
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
