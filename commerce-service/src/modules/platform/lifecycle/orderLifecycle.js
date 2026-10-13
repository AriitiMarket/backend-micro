/**
 * Operational lifecycle mapping — the SINGLE place where the platform's real
 * order/delivery statuses are translated into the admin console's operational
 * stages.
 *
 * Why a mapping and not a new status system: Commerce already owns the order
 * state machine (`orders/constants/orderStatuses.js`) and Delivery owns the
 * physical state machine (`deliveries/models/Delivery.js`). The admin console
 * must never write a second competing status — it only *reads* both and shows
 * the same reality in one vocabulary.
 *
 * Reality today (verified against the running services):
 *   order.status     : Processing | Confirmed | Shipped | In Transit | Delivered
 *                      | Cancelled | Refund Requested | Refund Approved
 *                      | Refund Success | Refund Rejected
 *   delivery.status  : pending | assigned | reassigned | pickup | in_transit
 *                      | delivered | failed | cancelled
 *   assignment.status: pending | accepted | rejected | expired | cancelled
 *
 * Stages that have no backing status in the platform are deliberately absent —
 * see `UNSUPPORTED_STAGES` — so the UI never shows an empty bucket that can
 * never fill.
 */

const OPERATIONAL_STAGES = Object.freeze([
  'new',
  'accepted',
  'ready_for_pickup',
  'pickup_assigned',
  'picked_up',
  'in_transit',
  'delivered',
  'completed',
  'cancelled',
  'exception',
]);

const OPERATIONAL_STAGE_LABELS = Object.freeze({
  new: 'New',
  accepted: 'Accepted',
  ready_for_pickup: 'Ready for Pickup',
  pickup_assigned: 'Pickup Assigned',
  picked_up: 'Picked Up',
  in_transit: 'In Transit',
  delivered: 'Delivered',
  completed: 'Completed',
  cancelled: 'Cancelled',
  exception: 'Exception',
});

// Stages the platform cannot currently evidence. 'preparing' was requested by
// the product spec but no service records a merchant "preparing" transition, so
// reporting it would mean inventing data.
const UNSUPPORTED_STAGES = Object.freeze([
  { stage: 'preparing', reason: 'No commerce/delivery status records a merchant preparing step' },
  { stage: 'arrived_at_dropoff', reason: 'Delivery service records in_transit -> delivered only' },
]);

// Terminal/refund order statuses that surface as an operational exception.
const EXCEPTION_ORDER_STATUSES = Object.freeze([
  'Refund Requested',
  'Refund Approved',
  'Refund Success',
  'Refund Rejected',
]);

// commerce order.status -> stage (used when no delivery record exists yet)
const ORDER_STATUS_STAGE = Object.freeze({
  Processing: 'new',
  Confirmed: 'accepted',
  Shipped: 'in_transit',
  'In Transit': 'in_transit',
  Delivered: 'delivered',
  Cancelled: 'cancelled',
  // Legacy/alternate spellings that exist in the database today.
  PENDING: 'new',
  CONFIRMED: 'accepted',
  SHIPPED: 'in_transit',
  DELIVERED: 'delivered',
  CANCELLED: 'cancelled',
  CANCELED: 'cancelled',
});

// delivery.status -> stage (authoritative for physical movement)
//
// Complete against the delivery service's canonical lifecycle: a status with no
// entry here falls through to the ORDER mapping, so the console reports the
// order's idea of reality instead of the delivery's. That is how a delivery
// sitting on the customer leg used to be shown as plain `in_transit`.
const DELIVERY_STATUS_STAGE = Object.freeze({
  pending: 'ready_for_pickup',
  assigned: 'pickup_assigned',
  reassigned: 'pickup_assigned',
  pickup: 'picked_up',
  in_transit: 'in_transit',
  delivered: 'delivered',
  failed: 'exception',
  cancelled: 'cancelled',
});

// Lookups are case-insensitive: the platform contains both "Processing" and
// legacy "PENDING"/"CONFIRMED" spellings, and the admin console must never show
// two different answers for the same row.
const ORDER_LOOKUP = Object.freeze(
  Object.entries(ORDER_STATUS_STAGE).reduce((map, [key, value]) => {
    map[key.trim().toLowerCase()] = value;
    return map;
  }, {})
);

const DELIVERY_LOOKUP = Object.freeze(
  Object.entries(DELIVERY_STATUS_STAGE).reduce((map, [key, value]) => {
    map[key.trim().toLowerCase()] = value;
    return map;
  }, {})
);

const EXCEPTION_LOOKUP = Object.freeze(
  EXCEPTION_ORDER_STATUSES.reduce((map, status) => {
    map[status.trim().toLowerCase()] = status;
    return map;
  }, {})
);

const normalizeStatus = (status) => String(status || '').trim().toLowerCase();

/**
 * Stage for a bare order status (used by the Operations counters, which only
 * have grouped counts and no rows to inspect). Shares the same lookup as
 * `mapOrderToOperationalStage`, so counters and drill-down lists always agree.
 */
function mapOrderStatusToStage(status) {
  const normalized = normalizeStatus(status);
  if (EXCEPTION_LOOKUP[normalized]) return 'exception';
  return ORDER_LOOKUP[normalized] || 'new';
}

function isSettled(order) {
  // Only CONFIRMED settles. `PAID` was accepted here but is not a member of the
  // order payment enum, so it was dead code that made an unsettled order look
  // settled to every stage counter.
  return String((order && order.paymentStatus) || '').toUpperCase() === 'CONFIRMED';
}

/**
 * Resolves the operational stage for an order, optionally refined by its
 * delivery record. Order-level terminal states win over physical movement so a
 * cancelled order is never reported as in transit.
 */
function mapOrderToOperationalStage(order, delivery) {
  if (!order) return { stage: 'new', source: 'none', reason: 'order missing' };

  const orderStatus = order.status;
  const deliveryStatus = delivery && delivery.status;
  const orderKey = normalizeStatus(orderStatus);
  const deliveryKey = normalizeStatus(deliveryStatus);

  if (orderKey === 'cancelled' || orderKey === 'canceled' || (deliveryKey === 'cancelled' && orderKey !== 'delivered')) {
    return { stage: 'cancelled', source: 'order/delivery', reason: 'Cancelled' };
  }

  if (EXCEPTION_LOOKUP[orderKey]) {
    return { stage: 'exception', source: 'order', reason: orderStatus };
  }

  if (deliveryKey === 'failed') {
    return { stage: 'exception', source: 'delivery', reason: 'Delivery failed' };
  }

  if (deliveryKey && DELIVERY_LOOKUP[deliveryKey]) {
    const stage = DELIVERY_LOOKUP[deliveryKey];
    if (stage === 'delivered') {
      return isSettled(order)
        ? { stage: 'completed', source: 'delivery+payment', reason: 'Delivered and settled' }
        : { stage: 'delivered', source: 'delivery', reason: 'Delivered, payment not settled' };
    }
    return { stage, source: 'delivery', reason: `delivery ${deliveryStatus}` };
  }

  if (ORDER_LOOKUP[orderKey]) {
    const stage = ORDER_LOOKUP[orderKey];
    if (stage === 'delivered') {
      return isSettled(order)
        ? { stage: 'completed', source: 'order+payment', reason: 'Delivered and settled' }
        : { stage: 'delivered', source: 'order', reason: 'Delivered, payment not settled' };
    }
    return { stage, source: 'order', reason: `order ${orderStatus}` };
  }

  return { stage: 'new', source: 'fallback', reason: `unmapped status "${orderStatus}"` };
}

/** Stage for a delivery row without an order in scope (operations counters). */
function mapDeliveryStatusToStage(status) {
  return DELIVERY_LOOKUP[normalizeStatus(status)] || 'exception';
}

function stageLabel(stage) {
  return OPERATIONAL_STAGE_LABELS[stage] || stage;
}

module.exports = {
  OPERATIONAL_STAGES,
  OPERATIONAL_STAGE_LABELS,
  UNSUPPORTED_STAGES,
  ORDER_STATUS_STAGE,
  DELIVERY_STATUS_STAGE,
  EXCEPTION_ORDER_STATUSES,
  ORDER_LOOKUP,
  DELIVERY_LOOKUP,
  mapOrderToOperationalStage,
  mapOrderStatusToStage,
  mapDeliveryStatusToStage,
  stageLabel,
  isSettled,
};