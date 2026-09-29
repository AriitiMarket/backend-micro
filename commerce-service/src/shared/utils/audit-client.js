// Audit client — sends audit log entries from commerce-service to
// identity-service.
//
// Fire-and-forget by design: an audit write must never fail or delay the user
// action it describes. The call is bounded by a timeout, and a rejection is
// logged instead of raised.
//
// It goes DIRECTLY to Identity over the private network (IDENTITY_SERVICE_URL)
// using the shared internal client, so the caller is attributed as `commerce`
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
  SHOP_APPROVED: 'SHOP_APPROVED',
  SHOP_REJECTED: 'SHOP_REJECTED',
  SHOP_SUSPENDED: 'SHOP_SUSPENDED',
  SHOP_PUBLIC_UPDATED: 'SHOP_PUBLIC_UPDATED',
  SELLER_APPLICATION_APPROVED: 'SELLER_APPLICATION_APPROVED',
  SELLER_APPLICATION_REJECTED: 'SELLER_APPLICATION_REJECTED',
  SELLER_APPLICATION_SUSPENDED: 'SELLER_APPLICATION_SUSPENDED',
  ORDER_STATUS_CHANGED: 'ORDER_STATUS_CHANGED',
  PAYMENT_REFUNDED: 'PAYMENT_REFUNDED',
  PRODUCT_CREATED: 'PRODUCT_CREATED',
  PRODUCT_UPDATED: 'PRODUCT_UPDATED',
  PRODUCT_DELETED: 'PRODUCT_DELETED',
  PRODUCT_PUBLISHED: 'PRODUCT_PUBLISHED',
  PRODUCT_DRAFTED: 'PRODUCT_DRAFTED',
  PRODUCT_ARCHIVED: 'PRODUCT_ARCHIVED',
  PRODUCT_UNARCHIVED: 'PRODUCT_UNARCHIVED',
  PRODUCT_VISIBILITY_CHANGED: 'PRODUCT_VISIBILITY_CHANGED',
  PRODUCT_RESTOCKED: 'PRODUCT_RESTOCKED',
  PRODUCT_STOCK_ADJUSTED: 'PRODUCT_STOCK_ADJUSTED',
  DISPUTE_RESOLVED: 'DISPUTE_RESOLVED',
  DISPUTE_REJECTED: 'DISPUTE_REJECTED',
  DISPUTE_STATUS_CHANGED: 'DISPUTE_STATUS_CHANGED',
  DISPUTE_ASSIGNED: 'DISPUTE_ASSIGNED',
  DISPUTE_PRIORITY_CHANGED: 'DISPUTE_PRIORITY_CHANGED',
  SETTINGS_CHANGED: 'SETTINGS_CHANGED',
  PLATFORM_SETTINGS_CHANGED: 'PLATFORM_SETTINGS_CHANGED',
  CATEGORY_CREATED: 'CATEGORY_CREATED',
  CATEGORY_UPDATED: 'CATEGORY_UPDATED',
  CATEGORY_DELETED: 'CATEGORY_DELETED',
  COUPON_CREATED: 'COUPON_CREATED',
  COUPON_DELETED: 'COUPON_DELETED',
  SECTOR_CREATED: 'SECTOR_CREATED',
  SECTOR_UPDATED: 'SECTOR_UPDATED',
  SECTOR_DELETED: 'SECTOR_DELETED',
  PAYMENT_STATUS_CHANGED: 'PAYMENT_STATUS_CHANGED',
  PAYMENT_DELETED: 'PAYMENT_DELETED',
  REVIEW_APPROVED: 'REVIEW_APPROVED',
  REVIEW_REJECTED: 'REVIEW_REJECTED',
  ORDER_CANCELLED: 'ORDER_CANCELLED',
  DELIVERY_STATUS_CHANGED: 'DELIVERY_STATUS_CHANGED',
  DELIVERY_ASSIGNED: 'DELIVERY_ASSIGNED',
  NOTIFICATION_SETTINGS_CHANGED: 'NOTIFICATION_SETTINGS_CHANGED',
  SYSTEM_SETTINGS_CHANGED: 'SYSTEM_SETTINGS_CHANGED',
  // Request Management audit actions
  REQUEST_CREATED: 'REQUEST_CREATED',
  REQUEST_ACCEPTED: 'REQUEST_ACCEPTED',
  REQUEST_VIEWED: 'REQUEST_VIEWED',
  REQUEST_MESSAGE_SENT: 'REQUEST_MESSAGE_SENT',
  REQUEST_OFFER_CREATED: 'REQUEST_OFFER_CREATED',
  REQUEST_OFFER_UPDATED: 'REQUEST_OFFER_UPDATED',
  REQUEST_OFFER_ACCEPTED: 'REQUEST_OFFER_ACCEPTED',
  REQUEST_OFFER_DECLINED: 'REQUEST_OFFER_DECLINED',
  REQUEST_CANCELLED: 'REQUEST_CANCELLED',
  REQUEST_AGREED: 'REQUEST_AGREED',
  REQUEST_CONVERTED_TO_ORDER: 'REQUEST_CONVERTED_TO_ORDER',
  REQUEST_DECLINED: 'REQUEST_DECLINED',
  REQUEST_EXPIRED: 'REQUEST_EXPIRED',
  REQUEST_ADMIN_INTERVENTION: 'REQUEST_ADMIN_INTERVENTION',
  // Negotiation transparency + moderation (product-request upgrade)
  REQUEST_PRICE_CHANGED: 'REQUEST_PRICE_CHANGED',
  REQUEST_QUANTITY_CHANGED: 'REQUEST_QUANTITY_CHANGED',
  REQUEST_MESSAGE_REPLIED: 'REQUEST_MESSAGE_REPLIED',
  REQUEST_ATTACHMENT_ADDED: 'REQUEST_ATTACHMENT_ADDED',
  REQUEST_ATTACHMENT_REMOVED: 'REQUEST_ATTACHMENT_REMOVED',
  REQUEST_AGREEMENT_CONFIRMED: 'REQUEST_AGREEMENT_CONFIRMED',
  REQUEST_AGREEMENT_CONFIRMATION_PENDING: 'REQUEST_AGREEMENT_CONFIRMATION_PENDING',
  REQUEST_ORDER_CREATED: 'REQUEST_ORDER_CREATED',
  REQUEST_REPORTED: 'REQUEST_REPORTED',
  REQUEST_REPORT_REVIEWED: 'REQUEST_REPORT_REVIEWED',
  REQUEST_SUSPENDED: 'REQUEST_SUSPENDED',
  REQUEST_RESTORED: 'REQUEST_RESTORED',
  REQUEST_USER_RESTRICTED: 'REQUEST_USER_RESTRICTED',
  REQUEST_USER_RESTRICTION_LIFTED: 'REQUEST_USER_RESTRICTION_LIFTED',
};

const LEVELS = {
  INFO: 'INFO',
  WARNING: 'WARNING',
  CRITICAL: 'CRITICAL',
};

async function sendAudit(opts) {
  const {
    action,
    level = LEVELS.INFO,
    adminId = null,
    adminName = null,
    module = 'commerce',
    targetEntity = null,
    targetId = null,
    previousValue = null,
    newValue = null,
    reason = null,
    details = {},
    ipAddress = null,
  } = opts;

  const res = await client.request('POST', '/internal/audit-log', {
    body: {
      action, level, adminId, adminName, module,
      targetEntity, targetId, previousValue, newValue,
      reason, details, ipAddress,
    },
  });

  if (!res.ok) {
    // Never thrown: an audit failure must not fail the business action it
    // describes. The internal client has already logged the call itself.
    console.error('[AUDIT-CLIENT] Identity rejected audit log:', res.status, res.error || res.code);
  }
  return null;
}

/**
 * Extract the acting identity from a request for audit purposes.
 *
 * The gateway rebuilds x-user-* from the VERIFIED JWT, so `req.user` is the
 * trusted source. The name/email fallback used to default to the literal string
 * 'Admin', which mis-attributed every seller/customer action to an admin.
 * The actor's own role is returned so the audit sink can label it correctly.
 */
function getAdminFromReq(req) {
  const user = req?.user || null;
  const role = user?.role || null;
  const name = user?.name || user?.email || (role ? String(role).toLowerCase() : 'unknown');
  return {
    adminId: user?.id || user?.sub || null,
    adminName: name,
    actorRole: role,
    ipAddress: req?.ip || req?.headers?.['x-forwarded-for'] || null,
  };
}

module.exports = { ACTIONS, LEVELS, sendAudit, getAdminFromReq };
