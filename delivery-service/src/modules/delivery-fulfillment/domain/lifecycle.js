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
  assigned: 'assignedAt',
  reassigned: 'reassignedAt',
  pickup: 'pickedUpAt',
  in_transit: 'inTransitAt',
  delivered: 'deliveredAt',
  failed: 'failedAt',
  cancelled: 'cancelledAt',
};

const STATUS_LABELS = {
  pending: 'Requested',
  assigned: 'Assigned',
  reassigned: 'Reassigned',
  pickup: 'Picked Up',
  in_transit: 'In Transit',
  delivered: 'Delivered',
  failed: 'Failed',
  cancelled: 'Cancelled',
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
 * Cancellation boundary. Refuses to cancel a delivery that already completed —
 * once it reached the customer the only honest outcomes are `delivered` or
 * `failed`, and reopening a finished delivery would let an operator erase the
 * proof-of-delivery trail.
 */
function assertCancellable(status, override = false) {
  if (status === 'delivered') {
    throw conflict(
      'A delivered delivery cannot be cancelled',
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

/**
 * Normalize a proof-of-delivery payload onto the field names the Delivery model
 * actually stores.
 *
 * The API historically accepted `photoUrl` / `signatureUrl` while the persisted
 * subdocument stores `photoReference` / `signatureReference` (and mongooses'
 * strict mode then discarded the accepted value). Mapping every accepted
 * spelling onto the storage contract here keeps one vocabulary: callers may send
 * either, nothing is silently dropped, and `assertProofSatisfied` checks the
 * same fields that were saved.
 */
function normalizeProofOfDelivery(proof) {
  if (!proof || typeof proof !== 'object') return null;
  const p = proof;
  const numberOrNull = (value) => (value === null || value === undefined || value === '' || Number.isNaN(Number(value))
    ? null
    : Number(value));
  return {
    type: p.type || (p.photoReference || p.photoUrl ? 'photo' : (p.signatureReference || p.signatureUrl ? 'signature' : 'confirmation')),
    confirmedAt: p.confirmedAt || new Date(),
    recipientName: p.recipientName || null,
    recipientReference: p.recipientReference || p.confirmedBy || null,
    photoReference: p.photoReference || p.photoUrl || null,
    signatureReference: p.signatureReference || p.signatureUrl || null,
    note: p.note || null,
    codConfirmed: p.codConfirmed === true,
    // COD receipts must survive on the document: without this the collected
    // amount was discarded and the cash reconciliation had no evidence.
    codCollectedAmount: numberOrNull(p.codCollectedAmount),
  };
}

/**
 * Throws 400 listing every proof requirement the delivery has not met.
 *
 * A COD delivery counts as confirmed either by an explicit `codConfirmed: true`
 * or by reporting the collected amount — the amount is the evidence the platform
 * reconciles, so accepting it keeps the rule satisfiable by real clients.
 */
function assertProofSatisfied(proof, rules, { expectedCodAmount = null } = {}) {
  const effective = { ...moduleConstants.DEFAULT_PROOF_RULES, ...(rules || {}) };
  const p = proof && typeof proof === 'object' ? proof : {};
  const missing = [];
  const codReported = p.codConfirmed === true
    || (p.codCollectedAmount !== null && p.codCollectedAmount !== undefined && expectedCodAmount !== null
      && Number(p.codCollectedAmount) === Number(expectedCodAmount));
  if (effective.requireConfirmation && !(p.confirmed === true || p.recipientName || p.recipientReference)) {
    missing.push('recipient confirmation');
  }
  if (effective.requirePhoto && !(p.photoReference || p.photoUrl)) missing.push('photo proof');
  if (effective.requireSignature && !(p.signatureReference || p.signatureUrl)) missing.push('signature');
  if (effective.requireCodConfirmation && !codReported) missing.push('COD confirmation');
  if (missing.length > 0) {
    throw validationError(
      missing.map((m) => `Proof of delivery requires ${m}`),
      'Proof of delivery is incomplete',
      'PROOF_REQUIRED',
    );
  }
  if (effective.requireCodConfirmation && p.codCollectedAmount !== null && p.codCollectedAmount !== undefined
    && expectedCodAmount !== null && Number(p.codCollectedAmount) !== Number(expectedCodAmount)) {
    throw conflict(
      'COD collection must equal the order total',
      'COD_AMOUNT_MISMATCH',
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
  if (['cancelled', 'failed'].includes(status)) {
    throw conflict(
      `Delivery is ${STATUS_LABELS[status] || status} and cannot be completed`,
      'ALREADY_COMPLETED',
    );
  }
  return true;
}

/** Lifecycle event name for a transition (overridable by the caller). */
/** Operational flag only — "late" is NEVER a delivery status. */
function isLate(delivery, now = new Date()) {
  if (!delivery || !delivery.estimatedDeliveryAt) return false;
  if (isBlocked(delivery.status) || isTerminal(delivery.status)) return false;
  return new Date(now) > new Date(delivery.estimatedDeliveryAt);
}

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
  normalizeProofOfDelivery,
  assertProofSatisfied,
  assertRetryable,
  assertDeliverable,
  isLate,
  eventFor,
  timestampFieldFor,
  labelFor,
  toCommerceStatus,
};
