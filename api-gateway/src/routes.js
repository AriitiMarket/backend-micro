// Gateway dispatch table — the single source of truth for which service owns
// which public path.
//
// Design notes:
//   * Matching is segment-aware: a prefix matches the exact path and any
//     sub-path, so `/product` matches `/product` and `/product/x` but NOT
//     `/products`. Prefix collisions are therefore impossible.
//   * Every entry declares the owning service, mirroring the service's own
//     mount points — change a route in a service and change it here.
const express = require('express');
const router = express.Router();
const identityProxy = require('./proxies/identity.proxy');
const commerceProxy = require('./proxies/commerce.proxy');
const uploadsProxy = require('./proxies/uploads.proxy');
const deliveryProxy = require('./proxies/delivery.proxy');
const requireInternalToken = require('./middleware/requireInternalToken');

// Segment-aware prefix match: exact path, or path followed by a '/'.
function matches(path, prefix) {
  return path === prefix || path.indexOf(prefix + '/') === 0;
}

const ROUTES = [
  // Media — served from whichever service holds the file.
  { service: 'uploads', prefix: '/uploads' },

  // OIDC discovery + JWKS (Identity Service is the issuer).
  { service: 'identity', prefix: '/.well-known' },

  // Identity Service: auth, users, agents, addresses, admin console.
  { service: 'identity', prefix: '/auth' },
  { service: 'identity', prefix: '/user' },
  { service: 'identity', prefix: '/agent' },
  { service: 'identity', prefix: '/address' },

  // Admin console — Commerce-owned sub-prefixes. These MUST be listed before
  // the generic '/admin' identity entry: the match is first-wins, and the
  // platform hierarchy / businesses / shops / orders / analytics sub-resources
  // are owned by the Commerce Service (see commerce app.js mounts), while the
  // remaining /admin/* resources (users, roles, permissions, audit, sellers,
  // notifications) stay with Identity.
  //
  // NOTE: there is deliberately no '/admin/hierarchy' entry — that path was
  // never implemented; the canonical Commerce path is '/admin/platform/hierarchy'.
  { service: 'commerce', prefix: '/admin/platform' },
  { service: 'commerce', prefix: '/admin/businesses' },
  { service: 'commerce', prefix: '/admin/shops' },
  { service: 'commerce', prefix: '/admin/orders' },
  { service: 'commerce', prefix: '/admin/operations' },
  { service: 'commerce', prefix: '/admin/growth-analytics' },

  // Identity Service: remaining admin console resources.
  { service: 'identity', prefix: '/admin' },

  // Commerce Service.
  { service: 'commerce', prefix: '/shop' },
  { service: 'commerce', prefix: '/metrics' },
  { service: 'commerce', prefix: '/product' },
  { service: 'commerce', prefix: '/category' },
  { service: 'commerce', prefix: '/order' },
  { service: 'commerce', prefix: '/cart' },
  { service: 'commerce', prefix: '/wishlist' },
  { service: 'commerce', prefix: '/coupon' },
  { service: 'commerce', prefix: '/review' },
  { service: 'commerce', prefix: '/promotion' },
  { service: 'commerce', prefix: '/request' },
  { service: 'commerce', prefix: '/event' },
  { service: 'commerce', prefix: '/conversation' },
  { service: 'commerce', prefix: '/message' },
  { service: 'commerce', prefix: '/payment' },
  { service: 'commerce', prefix: '/subscription' },
  { service: 'commerce', prefix: '/sector' },
  { service: 'commerce', prefix: '/seller-application' },
  { service: 'commerce', prefix: '/disputes' },
  { service: 'commerce', prefix: '/analytics' },
  { service: 'commerce', prefix: '/settings' },
  { service: 'commerce', prefix: '/wallet' },
  { service: 'commerce', prefix: '/payout' },
  // Standalone image upload (multipart) — must not collide with the media
  // serving prefix '/uploads' above.
  { service: 'commerce', prefix: '/media' },
  // Returns/refunds. The commerce service mounts `returnsRoutes` at '/return'
  // (see commerce-service/src/app/app.js), but the prefix was missing here —
  // every /return request was answered with 404 at the edge, so the seller
  // returns dashboard and the buyer return request flow could never load.
  { service: 'commerce', prefix: '/return' },

  // Phase-1 fulfillment & financial sub-resources. These are mounted at the
  // commerce service root (see commerce-service/src/app/app.js) and are NOT
  // covered by the generic '/order', '/payment', '/disputes' prefixes above —
  // the segment-aware matcher requires an exact path or a '/' boundary, so
  // '/order-notes' would otherwise miss '/order' and 404 at the edge.
  { service: 'commerce', prefix: '/order-notes' },
  { service: 'commerce', prefix: '/order-hold' },
  { service: 'commerce', prefix: '/order-priority' },
  { service: 'commerce', prefix: '/order-sla' },
  { service: 'commerce', prefix: '/order-export' },
  { service: 'commerce', prefix: '/order-dispute' },
  { service: 'commerce', prefix: '/payment-ledger' },
  { service: 'commerce', prefix: '/payment-reconciliation' },
  { service: 'commerce', prefix: '/commission-ledger' },

  // Delivery Service.
  { service: 'delivery', prefix: '/delivery' },
  // Provider on-boarding (apply -> admin review) doubles as the provider role
  // provisioning entry point. Commerce owns the seller equivalent
  // (/seller-application), so Delivery owns this one.
  { service: 'delivery', prefix: '/provider-application' },
];

const INTERNAL_PREFIX = '/internal';

// Service-to-service routes. Every entry is gated by the cluster credential at
// the edge (requireInternalToken) before the request reaches any service — the
// downstream services additionally assert the same credential, so internal
// traffic can never be forged through the public API.
//
// First match wins, so the most specific prefix must come first.
const INTERNAL_ROUTES = [
  { service: 'delivery', prefix: '/internal/delivery' },
  { service: 'commerce', prefix: '/internal/commerce' },
  // Identity owns the remaining internal surface (/internal/users/*,
  // /internal/sellers/*, /internal/audit-log, ...).
  { service: 'identity', prefix: '/internal' },
];

// Kept for readability/tests: the catch-all internal target.
const INTERNAL_TARGET = 'identity';

// Resolves the service that owns an internal path (null when not internal).
function matchInternalTarget(path) {
  for (const route of INTERNAL_ROUTES) {
    if (matches(path, route.prefix)) return route.service;
  }
  return null;
}

function matchTarget(path) {
  for (const route of ROUTES) {
    if (matches(path, route.prefix)) return route.service;
  }
  return null;
}

function dispatch(target, req, res) {
  if (target === 'identity') return identityProxy(req, res);
  if (target === 'commerce') return commerceProxy(req, res);
  if (target === 'delivery') return deliveryProxy(req, res);
  if (target === 'uploads') return uploadsProxy(req, res);
  return null;
}

router.use((req, res) => {
  const path = (req.url || req.path || req.originalUrl).split('?')[0];

  // Internal API: require the cluster credential first, and only then permit
  // the internal headers to be forwarded downstream.
  if (matches(path, INTERNAL_PREFIX)) {
    const internalTarget = matchInternalTarget(path);
    return requireInternalToken(req, res, () => dispatch(internalTarget, req, res));
  }

  const target = matchTarget(path);
  if (!target) {
    return res.status(404).json({
      success: false,
      code: 'ROUTE_NOT_FOUND',
      message: 'Unhandled route: ' + req.method + ' ' + path,
      errors: [],
    });
  }

  // The proxy writes the response itself; nothing may follow this call.
  return dispatch(target, req, res);
});

module.exports = router;
module.exports.ROUTES = ROUTES;
module.exports.INTERNAL_ROUTES = INTERNAL_ROUTES;
module.exports.matchTarget = matchTarget;
module.exports.matchInternalTarget = matchInternalTarget;
module.exports.INTERNAL_TARGET = INTERNAL_TARGET;
