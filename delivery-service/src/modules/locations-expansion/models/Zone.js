const mongoose = require('mongoose');

const zoneSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  code: { type: String, required: true, unique: true, trim: true },
  description: { type: String, default: '' },
  status: { type: String, default: 'active', enum: ['active', 'inactive', 'suspended'] },
  // MVP lifecycle: DRAFT -> READY -> LIVE <-> PAUSED. PAUSED/DRAFT zones
  // do not accept NEW requests; existing deliveries in them continue normally.
  lifecycle: { type: String, default: 'LIVE', enum: ['DRAFT', 'READY', 'LIVE', 'PAUSED'] },
  // MVP traceability: which port/port serves this zone. Optional until all data
  // is backfilled — Port is the current port equivalent in existing data.
  portId: { type: mongoose.Schema.Types.ObjectId, ref: 'Port', default: null },
  portName: { type: String, default: '' },
  locationIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Location' }],
  coverage: {
    radiusKm: { type: Number, default: null },
    boundaries: { type: mongoose.Schema.Types.Mixed, default: null },
    center: {
      type: { type: String, enum: ['Point'], default: undefined },
      coordinates: { type: [Number], default: undefined },
    },
    includedAreas: [{ type: String }],
    excludedAreas: [{ type: String }],
  },
  // Delivery rules
  deliveryRules: {
    serviceable: { type: Boolean, default: true },
    deliveryFee: { type: Number, default: 0 },
    freeDeliveryThreshold: { type: Number, default: null },
    estimatedDeliveryTime: { type: String, default: '30-45 min' },
    minimumOrder: { type: Number, default: null },
    codAvailable: { type: Boolean, default: true },
    pickupAvailable: { type: Boolean, default: false },
  },
  // Operational rules
  operationalRules: {
    allowedProviders: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Provider' }],
    allowedRiders: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Rider' }],
    portId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', default: null },
    priority: { type: Number, default: 5, min: 1, max: 10 },
    operatingHours: {
      open: { type: String, default: null },
      close: { type: String, default: null },
      days: { type: [String], default: [] },
    },
  },
  priority: { type: Number, default: 5, min: 1, max: 10 },
  portId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', default: null },
}, { timestamps: true });

zoneSchema.index({ status: 1 });
zoneSchema.index({ locationIds: 1 });
zoneSchema.index({ 'coverage.center': '2dsphere' }, { sparse: true });
zoneSchema.index({ priority: 1 });
zoneSchema.index({ portId: 1 });
zoneSchema.index({ 'deliveryRules.serviceable': 1 });

module.exports = mongoose.model('Zone', zoneSchema);
