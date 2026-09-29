// Audit client — sends audit log entries from delivery-service to
// identity-service.
//
// Fire-and-forget by design: an audit write must never fail or delay the user
// action it describes. The call is bounded by a timeout, and a rejection is
// logged instead of raised.
//
// It goes DIRECTLY to Identity over the private network (IDENTITY_SERVICE_URL)
// using the shared internal client, so the caller is attributed as `delivery`
// rather than `gateway`, and every dependency in the platform shares one
// timeout/trace/logging policy.
const { createInternalClient } = require('../internal-client');
const { services } = require('../../app/config/services');

const client = createInternalClient({
  name: services.self,
  baseUrl: services.identity.url,
  timeoutMs: parseInt(process.env.AUDIT_CALL_TIMEOUT_MS, 10) || 5000,
  maxRetries: 0, // audit writes are fire-and-forget: never retried
});

const ACTIONS = {
  LOCATION_CREATED: 'LOCATION_CREATED',
  LOCATION_UPDATED: 'LOCATION_UPDATED',
  LOCATION_ACTIVATED: 'LOCATION_ACTIVATED',
  LOCATION_DEACTIVATED: 'LOCATION_DEACTIVATED',
  ZONE_CREATED: 'ZONE_CREATED',
  ZONE_UPDATED: 'ZONE_UPDATED',
  ZONE_LOCATION_ADDED: 'ZONE_LOCATION_ADDED',
  ZONE_LOCATION_REMOVED: 'ZONE_LOCATION_REMOVED',
  RIDER_CREATED: 'RIDER_CREATED',
  RIDER_UPDATED: 'RIDER_UPDATED',
  RIDER_STATUS_CHANGED: 'RIDER_STATUS_CHANGED',
  RIDER_APPROVED: 'RIDER_APPROVED',
  DELIVERY_CREATED: 'DELIVERY_CREATED',
  DELIVERY_STATUS_CHANGED: 'DELIVERY_STATUS_CHANGED',
  DELIVERY_ASSIGNED: 'DELIVERY_ASSIGNED',
  DELIVERY_REASSIGNED: 'DELIVERY_REASSIGNED',
  DELIVERY_INITIATED: 'DELIVERY_INITIATED',
  ROUTE_CREATED: 'ROUTE_CREATED',
  ROUTE_UPDATED: 'ROUTE_UPDATED',
  DELIVERY_SERVICE_CREATED: 'DELIVERY_SERVICE_CREATED',
  DELIVERY_SERVICE_UPDATED: 'DELIVERY_SERVICE_UPDATED',
  DELIVERY_SERVICE_DELETED: 'DELIVERY_SERVICE_DELETED',
  HUB_CREATED: 'HUB_CREATED',
  HUB_UPDATED: 'HUB_UPDATED',
  BULK_ACTIVATED: 'BULK_ACTIVATED',
  BULK_DEACTIVATED: 'BULK_DEACTIVATED',
  SECTOR_ENABLED: 'SECTOR_ENABLED',
  SECTOR_DISABLED: 'SECTOR_DISABLED',
  SECTOR_AVAILABILITY_CHANGED: 'SECTOR_AVAILABILITY_CHANGED',
  SECTOR_AVAILABILITY_REMOVED: 'SECTOR_AVAILABILITY_REMOVED',
};

const LEVELS = { INFO: 'INFO', WARNING: 'WARNING', CRITICAL: 'CRITICAL' };

async function sendAudit(opts) {
  const {
    action, level = LEVELS.INFO, adminId = null, adminName = null,
    module: audModule = 'delivery', targetEntity = null, targetId = null,
    previousValue = null, newValue = null, reason = null, details = {}, ipAddress = null,
  } = opts;

  const res = await client.request('POST', '/internal/audit-log', {
    body: {
      action, level, adminId, adminName, module: audModule,
      targetEntity, targetId, previousValue, newValue, reason, details, ipAddress,
    },
  });

  if (!res.ok) {
    // Never thrown: an audit failure must not fail the business action it
    // describes. The internal client has already logged the call itself.
    console.error('[AUDIT] send failed:', res.status, res.error || res.code);
  }
  return null;
}

function getAdminFromReq(req) {
  return {
    adminId: (req && req.user && (req.user.id || req.user.sub)) || null,
    adminName: (req && req.user && (req.user.name || req.user.email)) || 'Admin',
    ipAddress: (req && (req.ip || (req.headers && req.headers['x-forwarded-for']))) || null,
  };
}

// The actor behind a request — recorded on every delivery lifecycle event so
// history answers "who did this" (user id, display name, role) without the
// domain layer ever reading the HTTP request itself.
function getActorFromReq(req) {
  const { adminId, adminName, ipAddress } = getAdminFromReq(req);
  return {
    actor: {
      id: adminId,
      name: adminName,
      role: (req && req.user && req.user.role) || null,
    },
    adminId,
    adminName,
    ipAddress,
  };
}

module.exports = { ACTIONS, LEVELS, sendAudit, getAdminFromReq, getActorFromReq };
