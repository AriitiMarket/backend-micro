const mongoose = require('mongoose');

const zoneSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  code: { type: String, required: true, unique: true, trim: true },
  description: { type: String, default: '' },
  status: { type: String, default: 'active', enum: ['active', 'inactive', 'suspended'] },
  sectorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', default: null },
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
    hubId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', default: null },
    priority: { type: Number, default: 5, min: 1, max: 10 },
    operatingHours: {
      open: { type: String, default: null },
      close: { type: String, default: null },
      days: { type: [String], default: [] },
    },
  },
  priority: { type: Number, default: 5, min: 1, max: 10 },
  hubId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', default: null },
}, { timestamps: true });

zoneSchema.index({ status: 1 });
zoneSchema.index({ sectorId: 1 });
zoneSchema.index({ locationIds: 1 });
zoneSchema.index({ 'coverage.center': '2dsphere' }, { sparse: true });
zoneSchema.index({ priority: 1 });
zoneSchema.index({ hubId: 1 });
zoneSchema.index({ 'deliveryRules.serviceable': 1 });

module.exports = mongoose.model('Zone', zoneSchema);
