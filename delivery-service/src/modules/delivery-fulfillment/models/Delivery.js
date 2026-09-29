const mongoose = require('mongoose');
const { DELIVERY_STATUSES } = require('../../../shared/constants');

// One failed attempt on a delivery. Persisted so failure history, reasons and
// the agreed next action survive across retries and are visible in history.
const attemptSchema = new mongoose.Schema({
  at: { type: Date, default: Date.now },
  reason: { type: String, default: '' },
  actorId: { type: String, default: null },
  actorName: { type: String, default: null },
  actorRole: { type: String, default: null },
  evidence: { type: mongoose.Schema.Types.Mixed, default: null },
  nextAction: { type: String, default: '' },
}, { _id: true });

const deliverySchema = new mongoose.Schema({
  orderId: { type: String, required: true },
  sellerId: { type: String, required: true },
  buyerId: { type: String, required: true },
  providerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Provider', default: null },
  serviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'DeliveryService', default: null },
  assignmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Assignment', default: null },
  routeId: { type: mongoose.Schema.Types.ObjectId, ref: 'DeliveryRoute', default: null },
  hubId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hub', default: null },
  shipmentId: { type: String, default: null },
  stopId: { type: String, default: null },

  // Idempotency key: first write creates the delivery, later duplicates return
  // the existing document instead of creating a second one. Derived from the
  // Commerce handoff (`order:<orderId>`) unless the caller supplies its own.
  idempotencyKey: { type: String, default: null },

  status: {
    type: String, default: 'pending',
    enum: DELIVERY_STATUSES,
  },

  origin: {
    // Location hierarchy IDs (for filtering)
    regionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', default: null },
    areaId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', default: null },
    cityId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', default: null },
    sectorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', default: null },
    locationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', default: null },

    // Location hierarchy names (historical snapshot)
    regionName: { type: String, default: '' },
    areaName: { type: String, default: '' },
    cityName: { type: String, default: '' },
    sectorName: { type: String, default: '' },

    // Address details
    shopId: { type: String, default: '' },
    shopName: { type: String, default: '' },
    businessId: { type: String, default: null },
    addressDetail: { type: String, default: '' },
    landmark: { type: String, default: '' },
    building: { type: String, default: '' },
    contactName: { type: String, default: '' },
    contactPhone: { type: String, default: '' },
    coordinates: {
      latitude: { type: Number, default: null },
      longitude: { type: Number, default: null },
    },
  },

  destination: {
    // Location hierarchy IDs (for filtering)
    regionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', default: null },
    areaId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', default: null },
    cityId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', default: null },
    sectorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', default: null },
    locationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', default: null },
    zoneId: { type: mongoose.Schema.Types.ObjectId, ref: 'Zone', default: null },

    // Location hierarchy names (historical snapshot)
    regionName: { type: String, default: '' },
    areaName: { type: String, default: '' },
    cityName: { type: String, default: '' },
    sectorName: { type: String, default: '' },

    // Address details
    addressDetail: { type: String, default: '' },
    landmark: { type: String, default: '' },
    building: { type: String, default: '' },
    contactName: { type: String, default: '' },
    contactPhone: { type: String, default: '' },
    additionalInstructions: { type: String, default: '' },
    coordinates: {
      latitude: { type: Number, default: null },
      longitude: { type: Number, default: null },
    },
  },

  estimatedDeliveryAt: { type: Date, default: null },
  // Milestone timestamps — one per reachable status, written only by the
  // state machine (never guessed in read paths).
  validatedAt: { type: Date, default: null },
  readyForPickupAt: { type: Date, default: null },
  assignedAt: { type: Date, default: null },
  pickedUpAt: { type: Date, default: null },
  inTransitAt: { type: Date, default: null },
  arrivedAtHubAt: { type: Date, default: null },
  outForDeliveryAt: { type: Date, default: null },
  deliveredAt: { type: Date, default: null },
  failedAt: { type: Date, default: null },
  cancelledAt: { type: Date, default: null },
  reassignedAt: { type: Date, default: null },
  returnRequestedAt: { type: Date, default: null },
  returnedAt: { type: Date, default: null },

  failureReason: { type: String, default: '' },
  cancellationReason: { type: String, default: '' },
  returnReason: { type: String, default: '' },

  // Failure handling: how many attempts so far and what the last attempt
  // agreed happens next (retry / reschedule / return / escalation).
  retryCount: { type: Number, default: 0 },
  nextAction: { type: String, default: '' },
  attempts: { type: [attemptSchema], default: [] },

  // Proof-of-delivery requirements for this delivery (defaults are permissive
  // so dispatch keeps working; requirements may be tightened per delivery or
  // per delivery service).
  proofRules: {
    requireConfirmation: { type: Boolean, default: false },
    requirePhoto: { type: Boolean, default: false },
    requireSignature: { type: Boolean, default: false },
    requireCodConfirmation: { type: Boolean, default: false },
  },

  proofOfDelivery: {
    type: new mongoose.Schema({
      type: { type: String, default: null },
      confirmedAt: { type: Date, default: null },
      recipientName: { type: String, default: null },
      recipientReference: { type: String, default: null },
      photoReference: { type: String, default: null },
      signatureReference: { type: String, default: null },
      note: { type: String, default: null },
      codConfirmed: { type: Boolean, default: false },
    }, { _id: false }),
    default: null
  },
  // Last completed transition (for optimistic UIs and conflict diagnostics).
  lastStatusChange: {
    from: { type: String, default: null },
    to: { type: String, default: null },
    at: { type: Date, default: null },
    actorId: { type: String, default: null },
    actorRole: { type: String, default: null },
  },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true });

deliverySchema.index({ orderId: 1 });
deliverySchema.index({ sellerId: 1 });
deliverySchema.index({ buyerId: 1 });
deliverySchema.index({ providerId: 1 });
deliverySchema.index({ status: 1 });
deliverySchema.index({ status: 1, createdAt: -1 });
deliverySchema.index({ serviceId: 1 });
deliverySchema.index({ shipmentId: 1 });
deliverySchema.index({ 'origin.locationId': 1 });
deliverySchema.index({ 'destination.locationId': 1 });
deliverySchema.index({ 'destination.zoneId': 1 });
deliverySchema.index({ 'destination.sectorId': 1 });
deliverySchema.index({ 'origin.sectorId': 1 });
// One delivery per idempotency key. Partial so legacy documents without a key
// are unaffected by the uniqueness rule.
deliverySchema.index(
  { idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } },
);

module.exports = mongoose.model('Delivery', deliverySchema);
