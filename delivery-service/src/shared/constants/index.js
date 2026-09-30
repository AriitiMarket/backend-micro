// ── Delivery lifecycle ─────────────────────────────────────────────────────
// Canonical persisted statuses of a delivery (the physical fulfilment record).
//
// The first eight values are the original MVP vocabulary and stay byte-stable
// so existing documents, the admin UI and Commerce's webhook keep working.
// The remaining values add the stages the delivery domain needs: request
// validation, readiness, hub hand-off, last mile and returns.
//
//   REQUESTED        → pending
//   VALIDATED        → validated
//   READY_FOR_PICKUP → ready_for_pickup
//   PICKED_UP        → pickup
//   IN_TRANSIT       → in_transit
//   ARRIVED_AT_HUB   → arrived_at_hub
//   OUT_FOR_DELIVERY → out_for_delivery
//   DELIVERED        → delivered
//   (+ assigned / reassigned: assignment states owned by Operations)
//   FAILED / CANCELLED / RETURN_REQUESTED / RETURNED: exception states
const DELIVERY_STATUSES = [
  'pending', 'validated', 'ready_for_pickup',
  'assigned', 'reassigned',
  'pickup', 'in_transit', 'arrived_at_hub', 'out_for_delivery',
  'delivered',
  'failed', 'cancelled',
  'return_requested', 'returned',
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
  VALIDATED: 'validated',
  READY_FOR_PICKUP: 'ready_for_pickup',
  READY: 'ready_for_pickup',
  ASSIGNED: 'assigned',
  REASSIGNED: 'reassigned',
  PICKED_UP: 'pickup',
  PICKUP: 'pickup',
  IN_TRANSIT: 'in_transit',
  TRANSIT: 'in_transit',
  ARRIVED_AT_HUB: 'arrived_at_hub',
  HUB: 'arrived_at_hub',
  OUT_FOR_DELIVERY: 'out_for_delivery',
  DELIVERED: 'delivered',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  RETURN_REQUESTED: 'return_requested',
  RETURNED: 'returned',
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
// Terminal states (`cancelled`, `returned`) have no outgoing transitions.
// `pending` is re-enterable as the "released/requeued to the ready pool"
// operation used by dispatch (rider rejects, assignment released, retry).
//
// A delivery may only be PICKED UP after a provider has been assigned to it:
// `assigned`/`reassigned` are the only states that precede `pickup`. Without
// this rule an unassigned (`pending`) delivery could be marked picked up, which
// no provider could ever account for.
const VALID_TRANSITIONS = {
  pending:           ['validated', 'ready_for_pickup', 'assigned', 'failed', 'cancelled'],
  validated:         ['ready_for_pickup', 'assigned', 'failed', 'cancelled'],
  ready_for_pickup:  ['assigned', 'failed', 'cancelled'],
  assigned:          ['pickup', 'reassigned', 'pending', 'failed', 'cancelled'],
  reassigned:        ['assigned', 'pickup', 'pending', 'failed', 'cancelled'],
  pickup:            ['in_transit', 'arrived_at_hub', 'out_for_delivery', 'assigned', 'reassigned', 'pending', 'failed', 'cancelled'],
  in_transit:        ['arrived_at_hub', 'out_for_delivery', 'delivered', 'assigned', 'reassigned', 'pending', 'failed', 'cancelled'],
  arrived_at_hub:    ['out_for_delivery', 'in_transit', 'delivered', 'assigned', 'pending', 'failed', 'cancelled'],
  out_for_delivery:  ['delivered', 'assigned', 'failed', 'cancelled'],
  delivered:         ['return_requested'],
  failed:            ['pending', 'cancelled', 'return_requested'],
  cancelled:         [],
  return_requested:  ['returned'],
  returned:          [],
};

// Status groupings shared by Deliveries and Operations (dashboards, dispatch
// eligibility, counters) so the two modules never drift apart.
const READY_DELIVERY_STATUSES = ['pending', 'validated', 'ready_for_pickup'];
const IN_PROGRESS_DELIVERY_STATUSES = [
  'assigned', 'reassigned', 'pickup', 'in_transit', 'arrived_at_hub', 'out_for_delivery',
];
const ACTIVE_DELIVERY_STATUSES = [...READY_DELIVERY_STATUSES, ...IN_PROGRESS_DELIVERY_STATUSES];
// Not eligible for (re)assignment — a completed, failed, cancelled or
// in-return delivery must never enter dispatch again.
const BLOCKED_DELIVERY_STATUSES = ['delivered', 'failed', 'cancelled', 'return_requested', 'returned'];
// True terminal states: no transition ever leaves them.
const TERMINAL_DELIVERY_STATUSES = ['cancelled', 'returned'];

// Lifecycle event names emitted on tracking/audit records for each target
// status. `delivery.created` is emitted when a delivery is first materialized.
const DELIVERY_CREATED_EVENT = 'delivery.created';
const DELIVERY_EVENTS = {
  pending: 'delivery.requeued',
  validated: 'delivery.validated',
  ready_for_pickup: 'delivery.ready_for_pickup',
  assigned: 'delivery.assigned',
  reassigned: 'delivery.reassigned',
  pickup: 'delivery.picked_up',
  in_transit: 'delivery.in_transit',
  arrived_at_hub: 'delivery.arrived_at_hub',
  out_for_delivery: 'delivery.out_for_delivery',
  delivered: 'delivery.delivered',
  failed: 'delivery.failed',
  cancelled: 'delivery.cancelled',
  return_requested: 'delivery.return_requested',
  returned: 'delivery.returned',
};

// Commerce compatibility: its delivery webhook accepts only the original
// eight statuses (anything else is rejected with 400) and maps them onto order
// statuses. Intermediate stages collapse onto the closest accepted value;
// return states are delivery-internal (Commerce handles refunds separately)
// and are therefore not pushed.
const DELIVERY_TO_COMMERCE_STATUS = {
  pending: 'pending',
  validated: 'pending',
  ready_for_pickup: 'pending',
  assigned: 'assigned',
  reassigned: 'reassigned',
  pickup: 'pickup',
  in_transit: 'in_transit',
  arrived_at_hub: 'in_transit',
  out_for_delivery: 'in_transit',
  delivered: 'delivered',
  failed: 'failed',
  cancelled: 'cancelled',
  return_requested: null,
  returned: null,
};

const PROVIDER_STATUSES = ['pending', 'available', 'busy', 'offline', 'suspended'];

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
const TERMINAL_ASSIGNMENT_BATCH_STATUSES = ['completed', 'rejected', 'cancelled'];

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

const LOCATION_TYPES = [
  'country', 'region', 'city', 'town', 'area', 'sector',
  'community', 'village', 'rural', 'other',
];

const ROOT_LOCATION_TYPES = ['country', 'region', 'rural', 'other'];

const LOCATION_CHILD_TYPES = {
  country:   ['region', 'city', 'town', 'area', 'rural', 'other'],
  region:    ['city', 'town', 'area', 'sector', 'community', 'village', 'rural', 'other'],
  city:      ['town', 'area', 'sector', 'community', 'village', 'other'],
  town:      ['area', 'sector', 'community', 'village', 'other'],
  area:      ['sector', 'community', 'village', 'other'],
  sector:    ['community', 'village', 'other'],
  community: ['village', 'other'],
  village:   ['other'],
  rural:     ['community', 'village', 'other'],
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
  DELIVERY_CREATED_EVENT,
  DELIVERY_EVENTS,
  DELIVERY_TO_COMMERCE_STATUS,
  PROVIDER_STATUSES,
  ASSIGNMENT_BATCH_STATUSES,
  ACTIVE_ASSIGNMENT_BATCH_STATUSES,
  TERMINAL_ASSIGNMENT_BATCH_STATUSES,
  ASSIGNMENT_BATCH_TRANSITIONS,
  MAX_BATCH_ORDERS,
  VEHICLE_TYPES,
  DELIVERY_SERVICE_TYPES,
  LOCATION_TYPES,
  ROOT_LOCATION_TYPES,
  LOCATION_CHILD_TYPES,
};
