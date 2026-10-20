/**
 * Gateway authorization — the SINGLE decision point for privileged access.
 *
 * Why here: every service previously made its own coarse `authorize('ADMIN')`
 * call, so permission granularity existed only inside the Identity Service and an
 * admin console session could reach any admin endpoint with any admin token. The
 * gateway is the only publicly reachable component and already verifies the
 * token, so it is the one place that can decide *whether* a caller may use a route
 * before the request is proxied.
 *
 * Decision inputs are the signed token's own claims:
 *   permissions : ['*'] for an admin with no RBAC assignment, otherwise the union
 *                 of the admin roles' permission keys (Identity's
 *                 resolveAdminAuthorization).
 *   admin_scope : the jurisdiction the admin is confined to.
 *
 * Rules:
 *   * a path with no entry in ROUTE_PERMISSIONS is untouched, so the public
 *     surface (auth, catalog, buyer/seller flows) is unaffected;
 *   * a mapped path requires a valid token (401) AND the permission (403);
 *   * read methods need `.view`, write methods need `.manage` (falling back to
 *     `.view` for read-only resources);
 *   * most-specific prefix wins, so the list is ordered;
 *   * /internal/* is skipped here — it is gated by the cluster credential
 *     (requireInternalToken) because services carry no user token.
 *
 * What this does NOT do (deliberately): it does not forward permissions or scope
 * to services as headers. Services enforce the coarse role and the scope they are
 * handed; the decision stays here.
 */
const authenticate = require('./authenticate');
const { WILDCARD, readPermissions } = require('./authenticate');
const { checkJurisdiction } = require('./jurisdiction');

/**
 * Transitional compatibility: a token minted before the permission claim existed
 * has no `permissions` at all. Such an ADMIN token is allowed so an in-flight
 * session is not broken mid-deploy, but a token that HAS the claim is always
 * enforced. Flip to false once one access-token lifetime has passed.
 */
const ALLOW_LEGACY_ADMIN_TOKENS = false;

/**
 * Route prefix -> required permission keys.
 * Keys come from the canonical catalog seeded by Identity
 * (identity-service/src/config/database.js).
 *
 * ORDER MATTERS: the first matching prefix wins, so specific paths precede their
 * broader parents.
 */
const ROUTE_PERMISSIONS = [
  // ── Admin console: Commerce-owned (must precede the generic /admin entry) ──
  { prefix: '/admin/platform', view: 'dashboard.view' },
  { prefix: '/admin/growth-analytics', view: 'reports.view' },
  { prefix: '/admin/businesses', view: 'businesses.view', manage: 'businesses.manage' },
  { prefix: '/admin/shops', view: 'shops.view', manage: 'shops.manage' },
  { prefix: '/admin/orders', view: 'orders.view', manage: 'orders.manage' },
  { prefix: '/admin/operations', view: 'orders.view' },
  // Product/content moderation lives under Commerce and is the real consumer of
  // the commerce.* catalogue keys; without this rule they were ungrantable.
  { prefix: '/admin/reviews', view: 'commerce.view', manage: 'commerce.manage' },

  // ── Delivery-owned admin surface ───────────────────────────────────────────
  // The network-configuration half of Delivery (locations, zones, routes, hubs)
  // is governed by locations.*; everything operational (providers, deliveries,
  // assignments, dispatch, tracking) is governed by delivery.*. Both key sets
  // existed in the catalogue but had no route rule, so granting them changed
  // nothing — RBAC could not narrow Delivery at all. Specific prefixes must
  // precede the generic /delivery catch-all below (first match wins).
  { prefix: '/delivery/location', view: 'locations.view', manage: 'locations.manage' },
  { prefix: '/delivery/zone', view: 'locations.view', manage: 'locations.manage' },
  { prefix: '/delivery/route', view: 'locations.view', manage: 'locations.manage' },
  { prefix: '/delivery/hub', view: 'locations.view', manage: 'locations.manage' },
  { prefix: '/delivery/provider', view: 'delivery.view', manage: 'delivery.manage' },
  // Legacy alias for the renamed provider router — kept so an old client keeps
  // working while it is being redeployed.
  { prefix: '/delivery/partner', view: 'delivery.view', manage: 'delivery.manage' },
  { prefix: '/delivery/delivery', view: 'delivery.view', manage: 'delivery.manage' },
  { prefix: '/delivery/request', view: 'delivery.view', manage: 'delivery.manage' },
  { prefix: '/delivery/assignment', view: 'delivery.view', manage: 'delivery.manage' },
  { prefix: '/delivery/dispatch', view: 'delivery.view', manage: 'delivery.manage' },
  { prefix: '/delivery/operation', view: 'delivery.view', manage: 'delivery.manage' },
  { prefix: '/delivery/tracking', view: 'delivery.view', manage: 'delivery.manage' },
  // Catch-all for any future /delivery/* module.
  { prefix: '/delivery', view: 'delivery.view', manage: 'delivery.manage' },

  // ── Platform settings (Commerce-owned, admin-only) ──
  // These routers were authenticate-only behind an authorize('ADMIN') call, so
  // without a gateway rule no RBAC role could govern them either.
  { prefix: '/settings', view: 'platform_settings.view', manage: 'platform_settings.manage' },

  // ── Admin console: Identity-owned ──
  { prefix: '/admin/users', view: 'users.view', manage: 'users.manage' },
  { prefix: '/admin/sellers', view: 'businesses.view', manage: 'businesses.manage' },
  { prefix: '/admin/roles', view: 'admin_roles.view', manage: 'admin_roles.manage' },
  { prefix: '/admin/permissions', view: 'admin_roles.view' },
  { prefix: '/admin/audit-logs', view: 'audit.view', manage: 'audit.manage' },
  { prefix: '/admin/audit', view: 'audit.view', manage: 'audit.manage' },
  { prefix: '/admin/notifications', view: 'platform_settings.view', manage: 'platform_settings.manage' },

  // ── Admin sub-paths that live under otherwise-public prefixes ──
  { prefix: '/order/admin', view: 'orders.view', manage: 'orders.manage' },
  { prefix: '/shop/admin', view: 'shops.view', manage: 'shops.manage' },
  { prefix: '/disputes/admin', view: 'disputes.view', manage: 'disputes.manage' },
  // Admin-only mutations under otherwise public Commerce prefixes. Method
  // filters keep public catalog/taxonomy reads unauthenticated at the gateway.
  { prefix: '/product/bulk', methods: ['POST'], view: 'commerce.view', manage: 'commerce.manage' },
  { prefix: '/category', methods: ['POST', 'PUT', 'PATCH', 'DELETE'], view: 'commerce.view', manage: 'commerce.manage' },
  { prefix: '/sector', methods: ['POST', 'PUT', 'PATCH', 'DELETE'], view: 'commerce.view', manage: 'commerce.manage' },
  { prefix: '/payment/admin', view: 'commerce.view', manage: 'commerce.manage' },
  { prefix: '/payment/get-all-payments', view: 'commerce.view' },
  { prefix: '/payment/admin/reconciliation', view: 'commerce.view' },
  { prefix: '/request/admin/restrictions', methods: ['GET', 'POST', 'PUT', 'DELETE'], view: 'commerce.view', manage: 'commerce.manage' },

  // ── Reporting (admin-only router) ──
  { prefix: '/analytics', view: 'reports.view' },

  // ── Remaining Identity admin surface (catch-all, most general) ──
  { prefix: '/admin', view: 'dashboard.view', manage: 'dashboard.view' },
];

/** Segment-aware prefix match (mirrors routes.js). */
function matches(path, prefix) {
  return path === prefix || path.indexOf(prefix + '/') === 0;
}

/**
 * Prefixes shared between the ADMIN console and an actor workspace.
 *
 * The permission table above is the admin console's RBAC. Some Delivery routers
 * are used by BOTH an administrator (manage) and a delivery provider (do the
 * work): a provider calls /delivery/assignment, /delivery/dispatch/mine,
 * /delivery/delivery, /delivery/tracking and /delivery/partner/:id/online to run
 * their day, while an admin uses the same routers to oversee them.
 *
 * Applying the admin permission key to a provider token made every one of those
 * requests fail with `403 PERMISSION_DENIED: Missing permission: delivery.view`,
 * so the provider workspace could not load a single screen. For a NON-admin token
 * these paths are therefore left to the owning service's own role gate
 * (`authorize('PROVIDER')` / handlers scoped to the caller). An ADMIN token is
 * still held to the permission table, so RBAC for the console is unchanged.
 *
 * Admin-only delivery surfaces (/zone, /route, /hub, /operation) are
 * deliberately NOT listed here. `/delivery/location` is listed for READS only:
 * the customer address picker needs the location tree, and Delivery serves it
 * without an identity, so the service — not this table — is what governs writes.
 */
const ACTOR_SHARED_PREFIXES = [
  // Seller report data shares the /analytics namespace with the admin console.
  // Non-admin sellers are authorized by Commerce's SELLER route guard; admin
  // requests still require reports.view above.
  '/analytics',
  '/delivery/assignment',
  '/delivery/dispatch',
  '/delivery/delivery',
  '/delivery/tracking',
  '/delivery/provider',
  '/delivery/partner',
  '/delivery/request',
  // The location tree (hierarchy, search, one node) is the reference data every
  // actor needs to pick an address with, and Delivery serves it without an
  // identity on purpose. Without this entry the permission table below returned
  // `403 PERMISSION_DENIED: Missing permission: locations.view` for a BUYER
  // token, so the customer-facing address picker could never load — while the
  // service happily answered the same call. Only READS are shared: the service
  // still requires ADMIN for every location/zone write, so this entry does not
  // widen what a non-admin can change.
  '/delivery/location',
  // A delivery provider's own wallet and payout requests live on the
  // /delivery/provider-wallet router, whose /me paths are provider-facing
  // (Delivery gates them with authorize('PROVIDER')). The router also carries
  // the /admin review paths, so only the /me subtree is shared — the match is
  // segment-aware, so '/delivery/provider-wallet/admin' stays admin-gated.
  '/delivery/provider-wallet/me',
];

/** Is this path also part of an actor (non-admin) workspace? */
function isActorSharedPath(path) {
  return ACTOR_SHARED_PREFIXES.some((prefix) => matches(path, prefix));
}

/** Does this verified token belong to the admin console? */
function isAdminToken(payload) {
  if (!payload) return false;
  if (String(payload.role || '').toUpperCase() === 'ADMIN') return true;
  const capabilities = Array.isArray(payload.capabilities) ? payload.capabilities : [];
  return capabilities.map((c) => String(c).toUpperCase()).includes('ADMIN');
}

const READ_METHODS = ['GET', 'HEAD', 'OPTIONS'];

/**
 * Read-only reference data that the marketplace selector needs from anonymous
 * guests too: the location tree and the zones covering a location. These are
 * public facts (no operational configuration), so guests may read them without
 * a token — matching how public product/shop reads already work. Writes stay
 * fully gated.
 */
const PUBLIC_READ_PREFIXES = [
  '/delivery/zone/public',
  '/delivery/zone/fee-quote',
  '/delivery/zone/location/',
  '/delivery/location',
  '/delivery/location/',
];

/** Is this a public read of reference data (no auth required)? */
function isPublicRead(method, path) {
  return READ_METHODS.includes(String(method || '').toUpperCase())
    && PUBLIC_READ_PREFIXES.some((prefix) => path === prefix || path.indexOf(prefix) === 0);
}

/**
 * The permission a request needs, or null when the path is not privilege-gated.
 */
function requiredPermission(method, path) {
  // Public reference data: readable by anyone (guests included).
  if (isPublicRead(method, path)) return null;
  const verb = String(method || '').toUpperCase();
  const rule = ROUTE_PERMISSIONS.find((entry) => matches(path, entry.prefix)
    && (!entry.methods || entry.methods.includes(verb)));
  if (!rule) return null;
  const isRead = READ_METHODS.includes(verb);
  return (isRead ? rule.view : rule.manage || rule.view) || null;
}

function pathOf(req) {
  return String(req.url || req.path || req.originalUrl || '').split('?')[0];
}

async function authorizeRequest(req, res, next) {
  const path = pathOf(req);

  // Service-to-service traffic authenticates with the cluster credential.
  if (matches(path, '/internal')) return next();

  const required = requiredPermission(req.method, path);
  if (!required) return next();

  return authenticate(req, res, () => {
    // Actor workspaces share these prefixes with the admin console: for a
    // non-admin actor the owning service's own role gate is the authority.
    if (!isAdminToken(req.token) && isActorSharedPath(path)) return next();

    const permissions = readPermissions(req.token);
    const allowed = permissions.includes(WILDCARD) || permissions.includes(required);

    // No permission claim at all: only a legacy ADMIN token, and only while the
    // compatibility flag is on.
    const claimAbsent = !Array.isArray(req.token && req.token.permissions);
    const legacyAdmin =
      claimAbsent && ALLOW_LEGACY_ADMIN_TOKENS && req.token && req.token.role === 'ADMIN';

    if (!allowed && !legacyAdmin) {
      return res.status(403).json({
        success: false,
        code: 'PERMISSION_DENIED',
        message: `Missing permission: ${required}`,
        required,
        errors: [],
      });
    }

    // Permitted for this route — now confine it to the admin's jurisdiction.
    const jurisdiction = checkJurisdiction(req);
    if (!jurisdiction.ok) {
      return res.status(403).json({
        success: false,
        code: 'SCOPE_NOT_PERMITTED',
        message: `Outside your jurisdiction: ${jurisdiction.param}`,
        param: jurisdiction.param,
        value: jurisdiction.value,
        errors: [],
      });
    }
    if (jurisdiction.injectedUrl) req.url = jurisdiction.injectedUrl;

    return next();
  });
}

module.exports = authorizeRequest;
module.exports.authorizeRequest = authorizeRequest;
module.exports.ROUTE_PERMISSIONS = ROUTE_PERMISSIONS;
module.exports.ACTOR_SHARED_PREFIXES = ACTOR_SHARED_PREFIXES;
module.exports.isActorSharedPath = isActorSharedPath;
module.exports.requiredPermission = requiredPermission;
module.exports.ALLOW_LEGACY_ADMIN_TOKENS = ALLOW_LEGACY_ADMIN_TOKENS;
