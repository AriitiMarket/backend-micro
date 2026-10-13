// Delivery-domain configuration. Nothing here is hard-coded into business
// rules — the lifecycle reads these so requirements can change per service or
// per delivery without touching the state machine.

// Proof-of-delivery requirements. Defaults are deliberately permissive so the
// existing dispatch flow (rider confirms in the batch UI, no evidence) keeps
// working; requirements are tightened per delivery (or later per delivery
// service) by setting `proofRules`.
const DEFAULT_PROOF_RULES = {
  requireConfirmation: false,
  requirePhoto: false,
  requireSignature: false,
  requireCodConfirmation: false,
};

// What can happen after a failed attempt — recorded on the attempt and echoed
// back to the caller so the next operational step is explicit. `return` is gone
// with the returns flow: offering an action the platform cannot execute is how
// an operator ends up with a delivery nothing will ever move again.
const FAILURE_NEXT_ACTIONS = ['retry', 'reschedule', 'escalation'];

// A failed delivery may be retried this many times before the state machine
// refuses further retries (escalation becomes the only way out).
const MAX_DELIVERY_RETRIES = 3;

// Cancellation is refused from this stage onwards unless an actor holding the
// `delivery.override` capability passes an explicit override. Once the rider is
// on the customer leg the parcel is physically out of the seller's hands, so
// cancelling it needs an explicit, audited decision rather than a stray click.
// A *delivered* delivery is never cancellable at all (see lifecycle.js).
const CANCELLATION_OVERRIDE_FROM = ['in_transit'];

// Fields a caller may change through `PATCH /deliveries/:id` — operational
// references and delivery configuration only. Commerce/Identity-owned data
// (order, buyer, seller, addresses) is never patchable from this service.
const PATCHABLE_REFERENCE_FIELDS = [
  'portId', 'routeId', 'shipmentId', 'serviceId', 'estimatedDeliveryAt', 'proofRules',
];

// Extra payload keys accepted alongside a generic status change
// (`PUT /deliveries/:id/status`). Everything else in the body is ignored so a
// status update can never mass-assign arbitrary document fields.
const STATUS_PAYLOAD_FIELDS = [
  'status', 'note', 'reason', 'evidence', 'nextAction', 'proof', 'proofOfDelivery', 'override',
];

module.exports = {
  DEFAULT_PROOF_RULES,
  FAILURE_NEXT_ACTIONS,
  MAX_DELIVERY_RETRIES,
  CANCELLATION_OVERRIDE_FROM,
  PATCHABLE_REFERENCE_FIELDS,
  STATUS_PAYLOAD_FIELDS,
};
