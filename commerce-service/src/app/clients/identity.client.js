// Commerce Service -> Identity Service client.
//
// DIRECT internal call over the private network (IDENTITY_SERVICE_URL), not via
// the API Gateway: service-to-service traffic must not re-enter the public edge.
//
// Every path here is on Identity's `/internal/*` surface, which is guarded by
// the cluster credential (per-service secrets, `x-internal-service` naming the
// caller) and never by a user JWT. User identity is carried separately in
// gateway-injected headers, and a service call deliberately has none.
const { createInternalClient } = require('../../shared/internal-client');
const { services } = require('../config/services');

const client = createInternalClient({
  name: services.self,
  baseUrl: services.identity.url,
  timeoutMs: parseInt(process.env.IDENTITY_CALL_TIMEOUT_MS, 10) || 5000,
  maxRetries: 1, // idempotent reads only; writes are never retried
});

function toResult(res) {
  return {
    status: res.status,
    // Kept for the historical `setSellerStatus` contract, which answered with
    // `statusCode` while every other method answered with `status`.
    statusCode: res.status,
    body: res.body,
    ok: res.ok,
    code: res.code,
    requestId: res.requestId,
  };
}

async function get(path, options) {
  return toResult(await client.requestOrThrow('GET', path, options));
}

async function post(path, body, options) {
  return toResult(await client.requestOrThrow('POST', path, Object.assign({}, options, { body })));
}

/**
 * Link a shop to its owner's identity row (`users.shop_id`).
 *
 * Identity reads `userId` — the payload used to be sent as `{ ownerId, ... }`,
 * so the update ran against an undefined id and the link was silently lost
 * (the callers swallow this as non-fatal).
 */
async function linkShopId(ownerId, shopId) {
  return post('/internal/sellers/link-shop', { userId: ownerId, shopId });
}

async function findUser(id) {
  return get('/internal/users/' + encodeURIComponent(String(id)));
}

/**
 * Display lookup for a whole page of ids in ONE call.
 *
 * Admin lists (shops, orders, products) carry foreign keys that must render as
 * names, never as uuids. A per-row `findUser` turned a 50-row page into 50
 * sequential service calls; this is the batch twin of `findUser`.
 *
 * A degraded Identity degrades to an EMPTY result, never to a failed list: an
 * admin page that shows ids it cannot look up still works, one that 500s does not.
 */
async function findUsersByIds(ids = []) {
  try {
    return await post('/internal/users/by-ids', { ids: ids.slice(0, 200) });
  } catch (err) {
    console.error('[identityClient] batch user lookup warning:', err.message);
    return null;
  }
}

/**
 * Free-text directory search (name / email / phone).
 *
 * Lets an admin's search box on a Commerce list reach the people behind it:
 * the term is resolved to matching accounts first, then folded into the query
 * alongside the list's own fields. Degrades to "no people match" on failure.
 */
async function searchUsers(term, limit = 25) {
  try {
    return await post('/internal/users/search', { term, limit });
  } catch (err) {
    console.error('[identityClient] directory search warning:', err.message);
    return null;
  }
}

/** Display rows for a successful batch/search call, or [] on any failure. */
function displayUsers(result) {
  if (!result || !result.ok || !result.body) return [];
  return Array.isArray(result.body.users) ? result.body.users : [];
}

/** `[{id, ...}]` → `Map<id, row>` with normalised string keys. */
function indexById(rows = []) {
  const map = new Map();
  for (const row of rows) {
    if (row && (row.id || row._id)) map.set(String(row.id || row._id), row);
  }
  return map;
}

/** Resolve an identity by email — used by the admin shop list's owner filter. */
async function findUserByEmail(email) {
  return get('/internal/users/by-email/' + encodeURIComponent(String(email)));
}

async function grantSellerRole(userId) {
  return post('/internal/sellers/grant-role', { userId });
}

/** Suspend a seller account (admin action) — syncs status to Identity. */
async function suspendSeller(userId) {
  return post('/internal/sellers/suspend', { userId });
}

/** Reactivate a suspended seller account (admin action). */
async function reactivateSeller(userId) {
  return post('/internal/sellers/reactivate', { userId });
}

/** Read the seller status held by Identity. */
async function getSellerStatus(userId) {
  return post('/internal/sellers/status', { userId });
}

/** Set seller status to APPROVED, PENDING, REJECTED, SUSPENDED or ACTIVE. */
async function setSellerStatus(userId, status) {
  return post('/internal/sellers/set-status', { userId, status });
}

/** Check membership status for a specific role (SELLER, PROVIDER, ...). */
async function checkMembershipStatus(userId, role) {
  return get('/internal/users/' + encodeURIComponent(String(userId)) + '/membership/' + encodeURIComponent(String(role)));
}

/**
 * Mark the seller onboarding wizard complete.
 *
 * Relayed the moment a seller SUBMITS their application: it tells Identity the
 * applicant finished the store setup, so the abandoned-application sweep will not
 * reclaim their PENDING membership. Idempotent, and it never grants a role.
 */
async function markOnboardingComplete(userId) {
  return post('/internal/onboarding/SELLER/complete', { userId });
}

/**
 * Platform user aggregates for the admin dashboard. Internal route: the cluster
 * credential is required, a user identity is not.
 */
async function countUsers() {
  return get('/internal/users/count');
}

module.exports = {
  identityClient: {
    linkShopId,
    findUser,
    findUsersByIds,
    searchUsers,
    displayUsers,
    indexById,
    findUserByEmail,
    grantSellerRole,
    suspendSeller,
    reactivateSeller,
    getSellerStatus,
    setSellerStatus,
    checkMembershipStatus,
    markOnboardingComplete,
    countUsers,
  },
  // Exposed for health checks and diagnostics.
  identityClientInternals: client,
};
