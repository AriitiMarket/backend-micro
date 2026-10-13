// Canonical order statuses and their valid transitions.
const ORDER_STATUSES = {
  PROCESSING: 'Processing',
  CONFIRMED: 'Confirmed',
  SHIPPED: 'Shipped',
  IN_TRANSIT: 'In Transit',
  DELIVERED: 'Delivered',
  CANCELLED: 'Cancelled',
  REFUND_REQUESTED: 'Refund Requested',
  REFUND_APPROVED: 'Refund Approved',
  REFUND_SUCCESS: 'Refund Success',
  REFUND_REJECTED: 'Refund Rejected',
};

// Allowed transitions: FROM status -> [allowed TO statuses]
const ALLOWED_TRANSITIONS = {
  [ORDER_STATUSES.PROCESSING]: [ORDER_STATUSES.CONFIRMED, ORDER_STATUSES.CANCELLED],
  [ORDER_STATUSES.CONFIRMED]: [ORDER_STATUSES.SHIPPED, ORDER_STATUSES.CANCELLED],
  [ORDER_STATUSES.SHIPPED]: [ORDER_STATUSES.IN_TRANSIT],
  [ORDER_STATUSES.IN_TRANSIT]: [ORDER_STATUSES.DELIVERED],
  [ORDER_STATUSES.DELIVERED]: [ORDER_STATUSES.REFUND_REQUESTED],
  [ORDER_STATUSES.CANCELLED]: [],
  [ORDER_STATUSES.REFUND_REQUESTED]: [ORDER_STATUSES.REFUND_APPROVED, ORDER_STATUSES.REFUND_REJECTED],
  [ORDER_STATUSES.REFUND_APPROVED]: [ORDER_STATUSES.REFUND_SUCCESS],
  [ORDER_STATUSES.REFUND_SUCCESS]: [],
  [ORDER_STATUSES.REFUND_REJECTED]: [ORDER_STATUSES.REFUND_REQUESTED],
};

function canTransition(from, to) {
  const target = normalizeStatus(to);
  if (!target || !CANONICAL_VALUES.includes(target)) return false;
  const allowed = ALLOWED_TRANSITIONS[normalizeStatus(from)];
  return allowed ? allowed.includes(target) : false;
}

/**
 * Legacy/aliased spellings that still live on stored documents and in older
 * clients: order creation used to store 'PENDING' and the payment-confirmation
 * claim used to store 'CONFIRMED'/'CANCELLED'. None of those is a canonical
 * status, so WITHOUT normalization an order sitting at 'PENDING' matches no
 * entry in ALLOWED_TRANSITIONS and every transition is rejected — which is
 * exactly why sellers could not accept their orders.
 */
const STATUS_ALIASES = {
  PENDING: ORDER_STATUSES.PROCESSING,
  NEW: ORDER_STATUSES.PROCESSING,
  ORDERED: ORDER_STATUSES.PROCESSING,
  CONFIRMED: ORDER_STATUSES.CONFIRMED,
  ACCEPTED: ORDER_STATUSES.CONFIRMED,
  SHIPPED: ORDER_STATUSES.SHIPPED,
  'OUT FOR DELIVERY': ORDER_STATUSES.IN_TRANSIT,
  'ON THE WAY': ORDER_STATUSES.IN_TRANSIT,
  'IN TRANSIT': ORDER_STATUSES.IN_TRANSIT,
  DELIVERED: ORDER_STATUSES.DELIVERED,
  COMPLETED: ORDER_STATUSES.DELIVERED,
  SUCCEEDED: ORDER_STATUSES.DELIVERED,
  RECEIVED: ORDER_STATUSES.DELIVERED,
  CANCELLED: ORDER_STATUSES.CANCELLED,
  CANCELED: ORDER_STATUSES.CANCELLED,
  'PROCESSING REFUND': ORDER_STATUSES.REFUND_REQUESTED,
  'REFUND REQUEST': ORDER_STATUSES.REFUND_REQUESTED,
  'REFUND REQUESTED': ORDER_STATUSES.REFUND_REQUESTED,
  'REFUND APPROVED': ORDER_STATUSES.REFUND_APPROVED,
  'REFUND SUCCESS': ORDER_STATUSES.REFUND_SUCCESS,
  'REFUND SUCCESSFUL': ORDER_STATUSES.REFUND_SUCCESS,
  REFUNDED: ORDER_STATUSES.REFUND_SUCCESS,
  'REFUND REJECTED': ORDER_STATUSES.REFUND_REJECTED,
};

const CANONICAL_VALUES = Object.values(ORDER_STATUSES);

/**
 * Map any stored or requested status onto a canonical status when possible.
 * Canonical values pass through untouched; unknown values are returned as-is so
 * callers can still report exactly what they received.
 */
function normalizeStatus(status) {
  if (status === null || status === undefined) return status;
  const raw = String(status).trim();
  if (!raw) return raw;
  if (CANONICAL_VALUES.includes(raw)) return raw;
  const upper = raw.toUpperCase();
  if (STATUS_ALIASES[upper]) return STATUS_ALIASES[upper];
  const titleCased = upper
    .split(/\s+/)
    .map((word) => word.charAt(0) + word.slice(1).toLowerCase())
    .join(' ');
  return CANONICAL_VALUES.includes(titleCased) ? titleCased : raw;
}

// Payment settlement is a SEPARATE lifecycle from the order lifecycle, and it
// has one state the order vocabulary has no room for: `SETTLING`, written while
// a COD collection is being confirmed. It is listed here (rather than inline in
// the model and again in the admin console) because a filter that omits it
// makes those orders unfindable, and an unstyled badge makes them invisible.
const PAYMENT_STATUSES = {
  PENDING: 'PENDING',
  SETTLING: 'SETTLING',
  CONFIRMED: 'CONFIRMED',
  FAILED: 'FAILED',
  REFUNDED: 'REFUNDED',
};

const PAYMENT_STATUS_VALUES = Object.values(PAYMENT_STATUSES);

module.exports = {
  ORDER_STATUSES,
  // The canonical values as a plain array — for the Mongoose enum, for
  // validation messages, and for any consumer that has to enumerate the
  // lifecycle without re-deriving it from the keyed object.
  ORDER_STATUS_VALUES: CANONICAL_VALUES,
  PAYMENT_STATUSES,
  PAYMENT_STATUS_VALUES,
  ALLOWED_TRANSITIONS,
  STATUS_ALIASES,
  normalizeStatus,
  canTransition,
};
