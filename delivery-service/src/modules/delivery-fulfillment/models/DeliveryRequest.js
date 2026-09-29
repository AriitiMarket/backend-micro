const mongoose = require('mongoose');

const deliveryRequestSchema = new mongoose.Schema({
  orderId: { type: String, required: true },
  sellerId: { type: String, required: true },
  buyerId: { type: String, required: true },

  // --- Location references (for filtering/segmentation) ---
  // Both references are optional and only populated when the id exists in the
  // location tree: a shop that has not set its map pin, or a buyer address
  // saved against an older tree, must still hand its order to Delivery. The
  // address snapshots below carry the text address, so orders never fail here.
  pickupLocationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', default: null },
  destinationLocationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', default: null },

  // --- Customer destination (complete snapshot) ---
  deliveryAddress: {
    // Location hierarchy
    regionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', default: null },
    regionName: { type: String, default: '' },
    areaId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', default: null },
    areaName: { type: String, default: '' },
    cityId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', default: null },
    cityName: { type: String, default: '' },
    sectorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', default: null },
    sectorName: { type: String, default: '' },

    locationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location' },
    zoneId: { type: mongoose.Schema.Types.ObjectId, ref: 'Zone' },
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

  // --- Seller pickup (complete snapshot) ---
  pickupAddress: {
    // Location hierarchy
    regionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', default: null },
    regionName: { type: String, default: '' },
    areaId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', default: null },
    areaName: { type: String, default: '' },
    cityId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', default: null },
    cityName: { type: String, default: '' },
    sectorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', default: null },
    sectorName: { type: String, default: '' },

    shopId: { type: String, default: null },
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

  // --- Items ---
  items: [{
    name: { type: String, default: '' },
    weight: { type: Number, default: 0 },
    quantity: { type: Number, default: 1 },
    value: { type: Number, default: 0 },
  }],
  totalValue: { type: Number, default: 0 },
  totalWeight: { type: Number, default: 0 },
  paymentMethod: { type: String, enum: ['COD', 'PREPAID'], default: 'COD' },
  paymentAmount: { type: Number, min: 0, default: 0 },
  preferredServiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'DeliveryService', default: null },
  specialInstructions: { type: String, default: '' },
  requestedAt: { type: Date, default: Date.now },
}, { timestamps: true });

deliveryRequestSchema.index({ orderId: 1 });
deliveryRequestSchema.index({ sellerId: 1 });
deliveryRequestSchema.index({ buyerId: 1 });
deliveryRequestSchema.index({ destinationLocationId: 1 });

module.exports = mongoose.model('DeliveryRequest', deliveryRequestSchema);
