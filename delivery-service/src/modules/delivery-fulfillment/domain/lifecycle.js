// Delivery domain rules — pure functions, no I/O.
//
// This is the single source of truth for "what may happen to a delivery":
// status normalization, transition legality, cancellation boundaries,
// proof-of-delivery requirements, retry rules and downstream (Commerce)
// status mapping. Both the service layer and any future module consult this
// instead of re-implementing rules.
const {
  DELIVERY_STATUSES,
  DELIVERY_EVENTS,
  DELIVERY_TO_COMMERCE_STATUS,
  VALID_TRANSITIONS,
  ACTIVE_DELIVERY_STATUSES,
  BLOCKED_DELIVERY_STATUSES,
  TERMINAL_DELIVERY_STATUSES,
  tryNormalizeDeliveryStatus,
} = require('../../../shared/constants');
const { badRequest, conflict, validationError } = require('../../../shared/errors');
const moduleConstants = require('../constants');

// Timestamp stamped on the delivery for each target status (single source for
// milestone history — the timeline is built from these, never guessed).
const STATUS_TIMESTAMP_FIELDS = {
  validated: 'validatedAt',
  ready_for_pickup: 'readyForPickupAt',
  assigned: 'assignedAt',
  reassigned: 'reassignedAt',
  pickup: 'pickedUpAt',
  in_transit: 'inTransitAt',
  arrived_at_hub: 'arrivedAtHubAt',
  out_for_delivery: 'outForDeliveryAt',
  delivered: 'deliveredAt',
  failed: 'failedAt',
  cancelled: 'cancelledAt',
  return_requested: 'returnRequestedAt',
  returned: 'returnedAt',
};

const STATUS_LABELS = {
  pending: 'Requested',
  validated: 'Validated',
  ready_for_pickup: 'Ready for Pickup',
  assigned: 'Assigned',
  reassigned: 'Reassigned',
  pickup: 'Picked Up',
  in_transit: 'In Transit',
  arrived_at_hub: 'Arrived at Hub',
  out_for_delivery: 'Out for Delivery',
  delivered: 'Delivered',
  failed: 'Failed',
  cancelled: 'Cancelled',
  return_requested: 'Return Requested',
  returned: 'Returned',
};

/** Normalize a status coming from the API; throws on unknown values. */
function normalizeStatus(value, field = 'status') {
  if (value === null || value === undefined || String(value).trim() === '') {
    throw badRequest(`"${field}" is required`, 'REQUIRED_FIELD');
  }
  const status = tryNormalizeDeliveryStatus(value);
  if (!status) {
    throw badRequest(`Unknown delivery status "${value}"`, 'UNKNOWN_STATUS');
  }
  return status;
}

/** Like `normalizeStatus` but returns null instead of throwing. */
function optionalStatus(value) {
  return value === null || value === undefined || String(value).trim() === ''
    ? null
    : tryNormalizeDeliveryStatus(value);
}

function allowedTransitions(fromStatus) {
  return [...(VALID_TRANSITIONS[fromStatus] || [])];
}

/** Throws 409 unless `toStatus` may follow `fromStatus`. */
function assertTransition(fromStatus, toStatus) {
  if (!allowedTransitions(fromStatus).includes(toStatus)) {
    throw conflict(
      `Invalid status transition: ${fromStatus} -> ${toStatus}`,
      'INVALID_TRANSITION',
    );
  }
  return true;
}

function isActive(status) { return ACTIVE_DELIVERY_STATUSES.includes(status); }
function isBlocked(status) { return BLOCKED_DELIVERY_STATUSES.includes(status); }
function isTerminal(status) { return TERMINAL_DELIVERY_STATUSES.includes(status); }

/**
 * Cancellation boundary. Refuses to cancel once the delivery is dispatched to
 * the last mile unless an explicit administrative override is presented, and
 * never allows cancelling something already delivered (returns exist for that).
 */
function assertCancellable(status, override = false) {
  if (status === 'delivered' || status === 'returned' || status === 'return_requested') {
    throw conflict(
      `A ${STATUS_LABELS[status] || status} delivery cannot be cancelled — use the return flow instead`,
      'CANCEL_NOT_ALLOWED',
    );
  }
  if (moduleConstants.CANCELLATION_OVERRIDE_FROM.includes(status) && !override) {
    throw conflict(
      'Cancellation is no longer operationally valid at this stage — an administrative override is required',
      'OVERRIDE_REQUIRED',
    );
  }
  return true;
}

/** Throws 400 listing every proof requirement the delivery has not met. */
function assertProofSatisfied(proof, rules) {
  const effective = { ...moduleConstants.DEFAULT_PROOF_RULES, ...(rules || {}) };
  const p = proof && typeof proof === 'object' ? proof : {};
  const missing = [];
  if (effective.requireConfirmation && !(p.confirmed === true || p.confirmedBy || p.recipientName)) {
    missing.push('recipient confirmation');
  }
  if (effective.requirePhoto && !p.photoUrl) missing.push('photo proof');
  if (effective.requireSignature && !p.signatureUrl) missing.push('signature');
  if (effective.requireCodConfirmation && !(p.codConfirmed === true)) missing.push('COD confirmation');
  if (missing.length > 0) {
    throw validationError(
      missing.map((m) => `Proof of delivery requires ${m}`),
      'PROOF_REQUIRED',
    );
  }
  return true;
}

/** Retry is only meaningful on a failed delivery and only up to the cap. */
function assertRetryable(status, retryCount = 0) {
  if (status !== 'failed') {
    throw conflict(
      `Only a failed delivery can be retried (current status: ${status})`,
      'RETRY_NOT_ALLOWED',
    );
  }
  if (retryCount >= moduleConstants.MAX_DELIVERY_RETRIES) {
    throw conflict(
      `Retry limit reached (${moduleConstants.MAX_DELIVERY_RETRIES}) — escalate the delivery instead`,
      'RETRY_LIMIT_REACHED',
    );
  }
  return true;
}

/** A delivery can only complete from an in-flight state, never from a dead one. */
function assertDeliverable(status) {
  if (['cancelled', 'returned', 'return_requested', 'failed'].includes(status)) {
    throw conflict(
      `Delivery is ${STATUS_LABELS[status] || status} and cannot be completed`,
      'ALREADY_COMPLETED',
    );
  }
  return true;
}

/** Lifecycle event name for a transition (overridable by the caller). */
function eventFor(toStatus, ctx) {
  if (ctx && ctx.event) return ctx.event;
  return DELIVERY_EVENTS[toStatus] || 'delivery.status_changed';
}

function timestampFieldFor(toStatus) {
  return STATUS_TIMESTAMP_FIELDS[toStatus] || null;
}

function labelFor(status) {
  return STATUS_LABELS[status] || status;
}

/**
 * Map a delivery status onto the vocabulary Commerce's delivery webhook
 * accepts. Returns null when Commerce must not be notified at all.
 */
function toCommerceStatus(toStatus) {
  if (Object.prototype.hasOwnProperty.call(DELIVERY_TO_COMMERCE_STATUS, toStatus)) {
    return DELIVERY_TO_COMMERCE_STATUS[toStatus];
  }
  return null;
}

module.exports = {
  STATUS_TIMESTAMP_FIELDS,
  STATUS_LABELS,
  DELIVERY_STATUSES,
  normalizeStatus,
  optionalStatus,
  allowedTransitions,
  assertTransition,
  isActive,
  isBlocked,
  isTerminal,
  assertCancellable,
  assertProofSatisfied,
  assertRetryable,
  assertDeliverable,
  eventFor,
  timestampFieldFor,
  labelFor,
  toCommerceStatus,
};
