// Centralized input validation for the Deliveries module.
//
// Hand-rolled (no schema library) to keep the service dependency-free.
// Every entry point — routes, controllers and internal handoffs — funnels its
// payload through these functions so rules are never duplicated in handlers.
// Failures throw a single `VALIDATION_ERROR` carrying *all* problems at once.
const { validationError, badRequest } = require('../../../shared/errors');
const { isValidObjectId } = require('../../../shared/utils/mongoId');
const { tryNormalizeDeliveryStatus, DELIVERY_SERVICE_TYPES } = require('../../../shared/constants');
const moduleConstants = require('../constants');

const MAX_TEXT = 500;
const MAX_ID_LENGTH = 128;
// Sanity ceiling for a single package line — anything above this is a data error,
// not a real order (and would silently inflate capacity/weight calculations).
const MAX_ITEM_QUANTITY = 10000;
// Payment methods the Delivery model can store, for both the request and the
// delivery document.
const PAYMENT_METHODS = ['COD', 'PREPAID'];

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value, max = 255) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

// An address block counts as present when it carries any resolvable
// reference or human-readable detail.
function hasAddressInfo(address) {
  if (!isPlainObject(address)) return false;
  return Boolean(
    address.regionId || address.areaId || address.cityId || address.sectorId
    || address.locationId || address.zoneId
    || (isNonEmptyString(address.addressDetail, 500) && address.addressDetail.trim() !== '')
    || address.shopId || (address.coordinates && address.coordinates.latitude != null),
  );
}

function push(errors, condition, message) {
  if (!condition) errors.push(message);
}

function assertNoUnknownKeys(data, allowed, label = 'payload') {
  const unknown = Object.keys(data || {}).filter((k) => !allowed.includes(k));
  if (unknown.length > 0) {
    throw validationError(unknown.map((k) => `Unknown ${label} field "${k}"`));
  }
}

function assertObjectId(value, field, { optional = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (!optional) throw validationError([`"${field}" is required`]);
    return;
  }
  if (!isValidObjectId(value)) {
    throw validationError([`"${field}" must be a valid identifier`]);
  }
}

/**
 * `POST /deliveries` and the Commerce handoff share this contract:
 * an external order reference, the parties involved, a pickup point and a
 * destination. Commerce/Identity-owned data is referenced by id only.
 *
 * The package block and the coordinates are validated here too: an order with a
 * negative quantity, an impossible latitude or a nonexistent location reference
 * is rejected at the boundary instead of becoming an undeliverable record.
 */
function validateDeliveryCreationInput(data) {
  if (!isPlainObject(data)) throw validationError(['A JSON body is required']);
  const errors = [];
  push(errors, isNonEmptyString(data.orderId, MAX_ID_LENGTH), '"orderId" is required and must identify the external order');
  push(errors, isNonEmptyString(data.sellerId, MAX_ID_LENGTH), '"sellerId" is required');
  push(errors, isNonEmptyString(data.buyerId, MAX_ID_LENGTH), '"buyerId" is required');

  const hasDestination = hasAddressInfo(data.destination) || hasAddressInfo(data.deliveryAddress)
    || Boolean(data.destinationLocationId);
  push(errors, hasDestination, 'A destination (address or location reference) is required');

  const hasPickup = hasAddressInfo(data.origin) || hasAddressInfo(data.pickupAddress)
    || Boolean(data.pickupLocationId);
  push(errors, hasPickup, 'A pickup point (address or location reference) is required');

  validateLocationReference(data.pickupLocationId, 'pickupLocationId', errors);
  validateLocationReference(data.destinationLocationId, 'destinationLocationId', errors);
  validateAddressCoordinates(data.pickupAddress || data.origin, 'pickupAddress', errors);
  validateAddressCoordinates(data.deliveryAddress || data.destination, 'deliveryAddress', errors);
  validateItems(data.items, errors);
  validateNonNegative(data.totalWeight, 'totalWeight', errors);
  validateNonNegative(data.totalValue, 'totalValue', errors);
  validateNonNegative(data.paymentAmount, 'paymentAmount', errors);
  validatePaymentMethod(data.paymentMethod, errors);
  validateDeliveryType(data.deliveryType !== undefined ? data.deliveryType : data.serviceType, errors);

  if (data.status !== undefined && data.status !== null && !tryNormalizeDeliveryStatus(data.status)) {
    errors.push(`Unknown delivery status "${data.status}"`);
  }
  if (data.idempotencyKey !== undefined && data.idempotencyKey !== null && !isNonEmptyString(data.idempotencyKey, 128)) {
    errors.push('"idempotencyKey" must be a short non-empty string');
  }
  if (errors.length > 0) throw validationError(errors);
  return data;
}

/** A location reference must be an ObjectId (or absent) — never a stray string. */
function validateLocationReference(value, field, errors) {
  if (value === undefined || value === null || value === '') return;
  if (!isValidObjectId(value)) errors.push(`"${field}" must be a valid location identifier`);
}

/** GeoJSON-style lat/lng bounds on the address snapshots. */
function validateAddressCoordinates(address, label, errors) {
  if (!isPlainObject(address) || !isPlainObject(address.coordinates)) return;
  const { latitude, longitude } = address.coordinates;
  const check = (value, field, min, max) => {
    if (value === undefined || value === null) return;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      errors.push(`"${label}.coordinates.${field}" must be a number`);
    } else if (value < min || value > max) {
      errors.push(`"${label}.coordinates.${field}" must be between ${min} and ${max}`);
    }
  };
  check(latitude, 'latitude', -90, 90);
  check(longitude, 'longitude', -180, 180);
}

/** Package lines: numeric, non-negative, within a sane ceiling. */
function validateItems(items, errors) {
  if (items === undefined || items === null) return;
  if (!Array.isArray(items)) { errors.push('"items" must be an array'); return; }
  items.forEach((item, index) => {
    if (!isPlainObject(item)) { errors.push(`"items[${index}]" must be an object`); return; }
    for (const field of ['quantity', 'weight', 'value']) {
      const value = item[field];
      if (value === undefined || value === null) continue;
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        errors.push(`"items[${index}].${field}" must be a number`);
      } else if (value < 0) {
        errors.push(`"items[${index}].${field}" cannot be negative`);
      }
    }
    if (typeof item.quantity === 'number' && item.quantity > MAX_ITEM_QUANTITY) {
      errors.push(`"items[${index}].quantity" must be at most ${MAX_ITEM_QUANTITY}`);
    }
  });
}

function validateNonNegative(value, field, errors) {
  if (value === undefined || value === null) return;
  if (typeof value !== 'number' || !Number.isFinite(value)) errors.push(`"${field}" must be a number`);
  else if (value < 0) errors.push(`"${field}" cannot be negative`);
}

/** Case-insensitive, normalized onto the values the model can store. */
function normalizePaymentMethod(value) {
  if (value === undefined || value === null || String(value).trim() === '') return 'COD';
  const method = String(value).trim().toUpperCase();
  return PAYMENT_METHODS.includes(method) ? method : null;
}

function validatePaymentMethod(value, errors) {
  if (value === undefined || value === null || String(value).trim() === '') return;
  if (!normalizePaymentMethod(value)) {
    errors.push(`"paymentMethod" must be one of: ${PAYMENT_METHODS.join(', ')}`);
  }
}

/** The delivery-service catalogue types an order may request. */
function validateDeliveryType(value, errors) {
  if (value === undefined || value === null || String(value).trim() === '') return;
  if (!DELIVERY_SERVICE_TYPES.includes(String(value).trim())) {
    errors.push(`Unsupported delivery type "${value}". Allowed: ${DELIVERY_SERVICE_TYPES.join(', ')}`);
  }
}

/** The Commerce order handoff (`POST /internal/delivery/request`). */
function validateRequestHandoffInput(data) {
  return validateDeliveryCreationInput(data);
}

/** Generic status change (`PUT /deliveries/:id/status`, `PATCH` with status). */
function validateStatusPayload(payload) {
  if (!isPlainObject(payload)) throw validationError(['A JSON body is required']);
  const status = tryNormalizeDeliveryStatus(payload.status);
  if (!status) throw validationError(['"status" is required and must be a known delivery status']);
  const errors = [];
  if (payload.note !== undefined && payload.note !== null && !isNonEmptyString(payload.note, MAX_TEXT) && payload.note !== '') {
    errors.push(`"note" must be a string of at most ${MAX_TEXT} characters`);
  }
  if (payload.reason !== undefined && payload.reason !== null && typeof payload.reason !== 'string') {
    errors.push('"reason" must be a string');
  }
  if (errors.length > 0) throw validationError(errors);
  return { ...payload, status };
}

function validateFailPayload(payload, { requireReason = true } = {}) {
  if (!isPlainObject(payload)) throw validationError(['A JSON body is required']);
  const errors = [];
  const reason = typeof payload.reason === 'string' ? payload.reason.trim()
    : (typeof payload.note === 'string' ? payload.note.trim() : '');
  if (requireReason && reason === '') errors.push('"reason" is required to record a failed attempt');
  if (reason.length > MAX_TEXT) errors.push(`"reason" must be at most ${MAX_TEXT} characters`);
  if (payload.nextAction !== undefined && payload.nextAction !== null && payload.nextAction !== ''
    && !moduleConstants.FAILURE_NEXT_ACTIONS.includes(payload.nextAction)) {
    errors.push(`"nextAction" must be one of: ${moduleConstants.FAILURE_NEXT_ACTIONS.join(', ')}`);
  }
  if (payload.evidence !== undefined && payload.evidence !== null
    && typeof payload.evidence !== 'string' && !isPlainObject(payload.evidence)) {
    errors.push('"evidence" must be a string or an object');
  }
  if (errors.length > 0) throw validationError(errors);
  return {
    ...payload,
    reason,
    nextAction: payload.nextAction || '',
    evidence: payload.evidence ?? null,
  };
}

function validateCancelPayload(payload, { requireReason = true } = {}) {
  if (!isPlainObject(payload)) throw validationError(['A JSON body is required']);
  const errors = [];
  const reason = typeof payload.reason === 'string' ? payload.reason.trim()
    : (typeof payload.note === 'string' ? payload.note.trim() : '');
  if (requireReason && reason === '') errors.push('"reason" is required to cancel a delivery');
  if (reason.length > MAX_TEXT) errors.push(`"reason" must be at most ${MAX_TEXT} characters`);
  if (payload.override !== undefined && payload.override !== null && typeof payload.override !== 'boolean') {
    errors.push('"override" must be a boolean');
  }
  if (errors.length > 0) throw validationError(errors);
  return { ...payload, reason, override: payload.override === true };
}

function validateDeliverPayload(payload) {
  if (payload === undefined || payload === null) return { proof: null, note: '' };
  if (!isPlainObject(payload)) throw validationError(['A JSON body is required']);
  const errors = [];
  if (payload.proof !== undefined && payload.proof !== null && !isPlainObject(payload.proof)) {
    errors.push('"proof" must be an object');
  }
  if (payload.note !== undefined && payload.note !== null && typeof payload.note !== 'string') {
    errors.push('"note" must be a string');
  }
  if (payload.proof && typeof payload.proof === 'object') {
    const proof = payload.proof;
    if (proof.photoUrl !== undefined && proof.photoUrl !== null && !isNonEmptyString(proof.photoUrl, 1000)) {
      errors.push('"proof.photoUrl" must be a string URL');
    }
    if (proof.signatureUrl !== undefined && proof.signatureUrl !== null && !isNonEmptyString(proof.signatureUrl, 1000)) {
      errors.push('"proof.signatureUrl" must be a string URL');
    }
    if (proof.codCollectedAmount !== undefined && proof.codCollectedAmount !== null
      && typeof proof.codCollectedAmount !== 'number') {
      errors.push('"proof.codCollectedAmount" must be a number');
    }
  }
  if (errors.length > 0) throw validationError(errors);
  return { proof: payload.proof || null, note: payload.note || '' };
}

function validateRetryPayload(payload) {
  if (payload === undefined || payload === null) return { reason: '' };
  if (!isPlainObject(payload)) throw validationError(['A JSON body is required']);
  const reason = typeof payload.reason === 'string' ? payload.reason.trim() : '';
  if (reason.length > MAX_TEXT) throw validationError([`"reason" must be at most ${MAX_TEXT} characters`]);
  return { reason };
}

function validateReturnPayload(payload, { requireReason = true } = {}) {
  if (!isPlainObject(payload)) throw validationError(['A JSON body is required']);
  const action = payload.action || 'request';
  const errors = [];
  if (!['request', 'complete'].includes(action)) errors.push('"action" must be "request" or "complete"');
  const reason = typeof payload.reason === 'string' ? payload.reason.trim() : '';
  if (requireReason && action === 'request' && reason === '') errors.push('"reason" is required to request a return');
  if (reason.length > MAX_TEXT) errors.push(`"reason" must be at most ${MAX_TEXT} characters`);
  if (errors.length > 0) throw validationError(errors);
  return { action, reason };
}

function validateValidatePayload(payload) {
  if (payload === undefined || payload === null) return { readyForPickup: true, hold: false };
  if (!isPlainObject(payload)) throw validationError(['A JSON body is required']);
  const errors = [];
  for (const key of ['readyForPickup', 'hold']) {
    if (payload[key] !== undefined && payload[key] !== null && typeof payload[key] !== 'boolean') {
      errors.push(`"${key}" must be a boolean`);
    }
  }
  if (errors.length > 0) throw validationError(errors);
  return {
    readyForPickup: payload.readyForPickup !== false,
    hold: payload.hold === true,
  };
}

/** `PATCH /deliveries/:id` — references + optional status in one payload. */
function validatePatchPayload(payload) {
  if (!isPlainObject(payload)) throw validationError(['A JSON body is required']);
  const allowed = [...moduleConstants.PATCHABLE_REFERENCE_FIELDS, 'status', 'note', 'reason', 'proof', 'override', 'evidence', 'nextAction'];
  assertNoUnknownKeys(payload, allowed);
  const errors = [];
  for (const field of ['hubId', 'routeId', 'shipmentId', 'serviceId']) {
    if (payload[field] === undefined) continue;
    if (payload[field] !== null && payload[field] !== '' && !isValidObjectId(payload[field])) {
      errors.push(`"${field}" must be a valid identifier or null`);
    }
  }
  if (payload.estimatedDeliveryAt !== undefined && payload.estimatedDeliveryAt !== null
    && Number.isNaN(Date.parse(payload.estimatedDeliveryAt))) {
    errors.push('"estimatedDeliveryAt" must be a valid date');
  }
  if (payload.proofRules !== undefined && payload.proofRules !== null && !isPlainObject(payload.proofRules)) {
    errors.push('"proofRules" must be an object');
  }
  if (payload.proofRules && isPlainObject(payload.proofRules)) {
    for (const key of Object.keys(payload.proofRules)) {
      if (!Object.prototype.hasOwnProperty.call(moduleConstants.DEFAULT_PROOF_RULES, key)) {
        errors.push(`Unknown proof rule "${key}"`);
      } else if (typeof payload.proofRules[key] !== 'boolean') {
        errors.push(`Proof rule "${key}" must be a boolean`);
      }
    }
  }
  if (payload.status !== undefined && payload.status !== null && !tryNormalizeDeliveryStatus(payload.status)) {
    errors.push(`Unknown delivery status "${String(payload.status)}"`);
  }
  if (Object.keys(payload).length === 0) errors.push('At least one field to update is required');
  if (errors.length > 0) throw validationError(errors);
  return payload;
}

/** List filter (`GET /deliveries`) — validates + normalizes query params. */
function buildDeliveryFilter(query = {}) {
  const filter = {};
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), 200);

  if (query.status !== undefined && query.status !== null && String(query.status).trim() !== '') {
    const values = String(query.status).split(',').map((s) => s.trim()).filter(Boolean);
    const normalized = [];
    const unknown = [];
    for (const value of values) {
      const status = tryNormalizeDeliveryStatus(value);
      if (status) normalized.push(status);
      else unknown.push(value);
    }
    if (unknown.length > 0) {
      throw badRequest(`Unknown delivery status filter: ${unknown.join(', ')}`, 'UNKNOWN_STATUS');
    }
    filter.status = normalized.length === 1 ? normalized[0] : { $in: [...new Set(normalized)] };
  }
  if (query.sellerId) filter.sellerId = query.sellerId;
  if (query.buyerId) filter.buyerId = query.buyerId;
  // `partnerId` is the legacy spelling of this filter — accepted so an
  // already-deployed client keeps narrowing the list correctly.
  const providerId = query.providerId || query.partnerId;
  if (providerId) filter.providerId = providerId;
  if (query.sectorId) filter['destination.sectorId'] = query.sectorId;
  if (query.zoneId) filter['destination.zoneId'] = query.zoneId;
  if (query.orderId) filter.orderId = query.orderId;
  if (query.shipmentId) filter.shipmentId = query.shipmentId;
  if (query.search) {
    const rx = new RegExp(String(query.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [
      { orderId: rx },
      { 'destination.sectorName': rx },
      { 'destination.addressDetail': rx },
      { 'destination.cityName': rx },
    ];
  }
  return { filter, page, limit };
}

module.exports = {
  isPlainObject,
  hasAddressInfo,
  assertNoUnknownKeys,
  validateDeliveryCreationInput,
  validateRequestHandoffInput,
  validateStatusPayload,
  validateFailPayload,
  validateCancelPayload,
  validateDeliverPayload,
  validateRetryPayload,
  validateReturnPayload,
  validateValidatePayload,
  validatePatchPayload,
  buildDeliveryFilter,
  normalizePaymentMethod,
  MAX_ITEM_QUANTITY,
  PAYMENT_METHODS,
};
