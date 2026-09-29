const mongoose = require('mongoose');

const locationSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  localName: { type: String, default: null },
  type: { type: String, required: true, enum: ['country', 'region', 'city', 'town', 'area', 'sector', 'community', 'village', 'rural', 'other'] },
  parentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', default: null },
  code: { type: String, default: null },
  description: { type: String, default: '' },
  isActive: { type: Boolean, default: true },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  coordinates: {
    type: { type: String, enum: ['Point'], default: undefined },
    coordinates: { type: [Number], default: undefined },
  },
  // Serviceability configuration
  serviceability: {
    serviceable: { type: Boolean, default: false },
    deliveryAvailable: { type: Boolean, default: false },
    pickupAvailable: { type: Boolean, default: false },
    codAvailable: { type: Boolean, default: false },
    estimatedDeliveryTime: { type: String, default: null },
    deliveryFee: { type: Number, default: null },
    freeDeliveryThreshold: { type: Number, default: null },
    minimumOrder: { type: Number, default: null },
    operatingHours: {
      open: { type: String, default: null },
      close: { type: String, default: null },
      days: { type: [String], default: [] },
    },
  },
  // Hub configuration
  hub: {
    isHub: { type: Boolean, default: false },
    hubName: { type: String, default: null },
    hubCode: { type: String, default: null },
    hubAddress: { type: String, default: null },
    contactInfo: {
      phone: { type: String, default: null },
      email: { type: String, default: null },
    },
    operatingStatus: { type: String, default: 'active', enum: ['active', 'inactive', 'maintenance'] },
    capacity: { type: Number, default: null },
  },
  // Expansion lifecycle
  expansionStatus: { type: String, default: 'active', enum: ['planned', 'preparing', 'testing', 'active', 'suspended', 'closed'] },
}, { timestamps: true });

locationSchema.index({ parentId: 1 });
locationSchema.index({ type: 1 });
locationSchema.index({ name: 'text', description: 'text' });
locationSchema.index({ code: 1 }, { sparse: true });
locationSchema.index({ coordinates: '2dsphere' }, { sparse: true });
locationSchema.index({ expansionStatus: 1 });
locationSchema.index({ 'hub.isHub': 1 });
locationSchema.index({ 'serviceability.serviceable': 1 });

module.exports = mongoose.model('Location', locationSchema);
