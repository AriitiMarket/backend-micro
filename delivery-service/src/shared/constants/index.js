// ── Delivery lifecycle ─────────────────────────────────────────────────────
// Canonical persisted statuses of a delivery (the physical fulfilment record).
//
// Every value here has a writer in the codebase. That is the rule the vocabulary
// is held to: a state that no dispatch, assignment, batch or admin flow can ever
// produce is dead weight — it renders in the console, passes the enum, and can
// never be entered, which is exactly how the console came to offer a
// "Ready for Pickup" button that dispatch then refused (dispatch only ever looks
// at `pending`, so `pending` IS "ready for pickup" here).
//
//   REQUESTED → assigned → pickup → in_transit → delivered
//                ↕ reassigned (assignment state owned by Operations)
//   FAILED (retry → pending) / CANCELLED: the exception outcomes
//
// Deliberately NOT modelled:
//   `validated` / `ready_for_pickup` — pre-assignment readiness. `pending` is
//     the ready pool (READY_DELIVERY_STATUSES); a second pre-assignment state
//     can only be a delivery that dispatch will not pick up.
//   `out_for_delivery` — no multi-drop last-mile stage exists; a rider on the
//     customer leg is `in_transit`.
//   `return_requested` / `returned` — no returns flow. `delivered` is final.
//
// Aliases for the removed spellings are kept below so an old filter, a stale
// client or a historical document still resolves to the state that replaced it.
// The return spellings are intentionally NOT aliased: a return is not a
// cancellation, so silently rewriting one into the other would corrupt meaning.
const DELIVERY_STATUSES = [
  'pending',
  'assigned', 'reassigned',
  'pickup', 'in_transit',
  'delivered',
  'failed', 'cancelled',
];

// Accepted spellings of a status at the API boundary (query filters, status
// payloads). Clients may send the canonical lifecycle names (any case), the
// persisted values, or historical variants — all normalize to one persisted
// value. Unknown values return null instead of silently persisting junk.
const DELIVERY_STATUS_ALIASES = {
  REQUESTED: 'pending',
  // The canonical lifecycle name of the initial state. Without this entry
  // `PENDING` — the spelling the platform's own state machine uses — was
  // rejected as an unknown status while every other canonical name was accepted.
  PENDING: 'pending',
  // Removed pre-assignment stages: they collapsed onto the ready pool.
  VALIDATED: 'pending',
  READY_FOR_PICKUP: 'pending',
  READY: 'pending',
  ASSIGNED: 'assigned',
  REASSIGNED: 'reassigned',
  PICKED_UP: 'pickup',
  PICKUP: 'pickup',
  IN_TRANSIT: 'in_transit',
  TRANSIT: 'in_transit',
  // Removed last-mile stage: the customer leg is `in_transit`.
  OUT_FOR_DELIVERY: 'in_transit',
  DELIVERED: 'delivered',
  COMPLETED: 'delivered',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  CANCELED: 'cancelled',
};

function tryNormalizeDeliveryStatus(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (raw === '') return null;
  if (DELIVERY_STATUSES.includes(raw)) return raw;
  const alias = DELIVERY_STATUS_ALIASES[raw]
    || DELIVERY_STATUS_ALIASES[raw.toUpperCase()]
    || DELIVERY_STATUS_ALIASES[raw.toLowerCase()];
  return alias && DELIVERY_STATUSES.includes(alias) ? alias : null;
}

// Allowed transitions: FROM -> [allowed TO]. Nothing else may move a delivery.
// `pending` is re-enterable as the "released/requeued to the ready pool"
// operation used by dispatch (rider rejects, assignment released, retry).
//
// A delivery may only be PICKED UP after a provider has been assigned to it:
// `assigned`/`reassigned` are the only states that precede `pickup`. Without
// this rule an unassigned (`pending`) delivery could be marked picked up, which
// no provider could ever account for.
const VALID_TRANSITIONS = {
  pending:    ['assigned', 'failed', 'cancelled'],
  assigned:   ['pickup', 'reassigned', 'pending', 'failed', 'cancelled'],
  reassigned: ['assigned', 'pickup', 'pending', 'failed', 'cancelled'],
  pickup:     ['in_transit', 'assigned', 'reassigned', 'pending', 'failed', 'cancelled'],
  in_transit: ['delivered', 'assigned', 'reassigned', 'pending', 'failed', 'cancelled'],
  delivered:  [],
  // `failed` is recoverable, so it is BLOCKED but not TERMINAL: the only way
  // out is the retry requeue back to the ready pool.
  failed:     ['pending', 'cancelled'],
  cancelled:  [],
};

// Status groupings shared by Deliveries and Operations (dashboards, dispatch
// eligibility, counters) so the two modules never drift apart. Every consumer
// derives its lists from these — none may re-spell a status list locally.
const READY_DELIVERY_STATUSES = ['pending'];
const IN_PROGRESS_DELIVERY_STATUSES = ['assigned', 'reassigned', 'pickup', 'in_transit'];
const ACTIVE_DELIVERY_STATUSES = [...READY_DELIVERY_STATUSES, ...IN_PROGRESS_DELIVERY_STATUSES];
// Not eligible for (re)assignment — a completed, failed or cancelled delivery
// must never enter dispatch again.
const BLOCKED_DELIVERY_STATUSES = ['delivered', 'failed', 'cancelled'];
// True terminal states: no transition ever leaves them. Deliberately excludes
// `failed`, which the retry requeue can still leave.
const TERMINAL_DELIVERY_STATUSES = ['delivered', 'cancelled'];

const DELIVERY_EVENTS = {
  pending: 'delivery.requeued',
  assigned: 'delivery.assigned',
  reassigned: 'delivery.reassigned',
  pickup: 'delivery.picked_up',
  in_transit: 'delivery.in_transit',
  delivered: 'delivery.delivered',
  failed: 'delivery.failed',
  cancelled: 'delivery.cancelled',
};

// Commerce compatibility: its delivery webhook accepts exactly this
// vocabulary, so the map is now 1:1. The lifecycle above and the webhook
// contract were previously kept in step by hand, which let them drift.
const DELIVERY_TO_COMMERCE_STATUS = {
  pending: 'pending',
  assigned: 'assigned',
  reassigned: 'reassigned',
  pickup: 'pickup',
  in_transit: 'in_transit',
  delivered: 'delivered',
  failed: 'failed',
  cancelled: 'cancelled',
};

// Multi-order assignment (a "batch" / dispatch job). One batch groups many
// deliveries for a single rider, carries its own state machine and keeps the
// previous batch in history on reassignment.
const ASSIGNMENT_BATCH_STATUSES = [
  'waiting_acceptance', // created, rider has not responded yet
  'accepted',           // rider accepted the job
  'picking_up',         // rider is collecting from sellers
  'picked_up',          // all seller pickups complete
  'in_transit',         // rider is delivering to customers
  'completed',          // every delivery delivered (terminal)
  'rejected',           // rider declined (terminal, releases deliveries)
  'cancelled',          // admin cancelled or superseded by reassignment (terminal)
];

const ACTIVE_ASSIGNMENT_BATCH_STATUSES = [
  'waiting_acceptance', 'accepted', 'picking_up', 'picked_up', 'in_transit',
];

// Allowed transitions: FROM -> [allowed TO] for a multi-order assignment.
const ASSIGNMENT_BATCH_TRANSITIONS = {
  waiting_acceptance: ['accepted', 'rejected', 'cancelled'],
  accepted:           ['picking_up', 'cancelled'],
  picking_up:         ['picked_up', 'cancelled'],
  picked_up:          ['in_transit', 'cancelled'],
  in_transit:         ['completed', 'cancelled'],
  completed:          [],
  rejected:           [],
  cancelled:          [],
};

// A single batch may not exceed this many orders.
const MAX_BATCH_ORDERS = 20;

const VEHICLE_TYPES = ['bicycle', 'motorcycle', 'car', 'van', 'truck', 'foot'];

const DELIVERY_SERVICE_TYPES = ['standard', 'express', 'same_day', 'next_day', 'rural', 'scheduled'];

// MVP geography is Region (optional) -> City. Zone and Port are separate models
// (a coverage area and a known local point inside it) and must never appear as
// location types.
const LOCATION_TYPES = ['country', 'region', 'city', 'other'];

const ROOT_LOCATION_TYPES = ['country', 'other'];

const LOCATION_CHILD_TYPES = {
  country: ['region', 'city', 'other'],
  region:  ['city', 'other'],
  city:    ['other'],
  other:   [],
};

module.exports = {
  DELIVERY_STATUSES,
  DELIVERY_STATUS_ALIASES,
  tryNormalizeDeliveryStatus,
  VALID_TRANSITIONS,
  READY_DELIVERY_STATUSES,
  IN_PROGRESS_DELIVERY_STATUSES,
  ACTIVE_DELIVERY_STATUSES,
  BLOCKED_DELIVERY_STATUSES,
  TERMINAL_DELIVERY_STATUSES,
  DELIVERY_EVENTS,
  DELIVERY_TO_COMMERCE_STATUS,
  ASSIGNMENT_BATCH_STATUSES,
  ACTIVE_ASSIGNMENT_BATCH_STATUSES,
  ASSIGNMENT_BATCH_TRANSITIONS,
  MAX_BATCH_ORDERS,
  VEHICLE_TYPES,
  DELIVERY_SERVICE_TYPES,
  LOCATION_TYPES,
  ROOT_LOCATION_TYPES,
  LOCATION_CHILD_TYPES,
};
