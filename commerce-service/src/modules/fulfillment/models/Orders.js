const mongoose = require('mongoose');

// Sub-schema for a single seller's shipment within an order.
// Every seller/shop represented in the order gets its own snapshot.
const sellerShipmentSchema = new mongoose.Schema({
  sellerId: { type: String, required: true },
  businessId: { type: String, default: null },
  shopId: { type: String, required: true },

  // Products from this seller in the order
  items: [{ type: mongoose.Schema.Types.Mixed, required: true }],
  subtotal: { type: Number, default: 0 },

  // Origin / pickup location snapshot (read-only at time of order)
  origin: {
    regionId: { type: String, default: null },
    regionName: { type: String, default: '' },
    areaId: { type: String, default: null },
    areaName: { type: String, default: '' },
    cityId: { type: String, default: null },
    cityName: { type: String, default: '' },
    sectorId: { type: String, default: null },
    sectorName: { type: String, default: '' },
    fullAddress: { type: String, default: '' },
    landmark: { type: String, default: '' },
    building: { type: String, default: '' },
    contactPhone: { type: String, default: '' },
    coordinates: {
      latitude: { type: Number, default: null },
      longitude: { type: Number, default: null },
    },
  },
}, { _id: false });

// Order references identity users via buyerId/sellerId.
const orderSchema = new mongoose.Schema({
  // --- Core order data ---
  cart: { type: Array, required: true },
  user: { type: Object, required: true },
  buyerId: { type: String, index: true },
  // Set when the order was created from an agreed product request
  // (Request Management → order). Null for a normal checkout.
  requestId: { type: String, default: null },

  // --- Money (server-computed, per order) ---
  // One checkout can split into several orders (one per seller/shop), so each
  // order carries ITS OWN money breakdown. Previously a single `totalPrice`
  // computed over the whole cart was copied into every order, so a 2-shop
  // checkout showed the full amount on both orders (and double-counted it in
  // the buyer's history).
  subtotal: { type: Number, default: 0 },
  shippingFee: { type: Number, default: 0 },
  currency: { type: String, default: 'ETB' },
  totalPrice: { type: Number, required: true },
  status: { type: String, default: 'Processing' },
  paymentStatus: { type: String, enum: ['PENDING', 'SETTLING', 'CONFIRMED', 'FAILED', 'REFUNDED'], default: 'PENDING' },
  paymentSettlementStartedAt: { type: Date, default: null },
  paymentInfo: { id: { type: String }, status: { type: String }, type: { type: String }, method: { type: String, default: 'COD' } },
  reservation: { type: Object, default: {} },
  // Set only after an authoritative settlement event (COD proof or a verified
  // payment-provider callback).
  paidAt: { type: Date, default: null },
  deliveredAt: { type: Date },
  cancelledAt: { type: Date },

  // --- Customer destination (historical snapshot at time of order) ---
  destination: {
    // Location hierarchy references
    regionId: { type: String, default: null },
    regionName: { type: String, default: '' },
    areaId: { type: String, default: null },
    areaName: { type: String, default: '' },
    cityId: { type: String, default: null },
    cityName: { type: String, default: '' },
    sectorId: { type: String, default: null },
    sectorName: { type: String, default: '' },

    // Full address details
    fullAddress: { type: String, default: '' },
    landmark: { type: String, default: '' },
    building: { type: String, default: '' },
    phone: { type: String, default: '' },
    additionalInstructions: { type: String, default: '' },

    // Optional coordinates for future map integration
    coordinates: {
      latitude: { type: Number, default: null },
      longitude: { type: Number, default: null },
    },
  },

  // --- Seller shipments (one per seller/shop in the order) ---
  sellerShipments: [sellerShipmentSchema],

  // --- Legacy fields (kept for backward compatibility) ---
  shippingAddress: { type: Object, default: {} },
  sellerId: { type: String, index: true },

  // Location & Sector tracking for admin scope filtering
  sectorId: {
    type: String,
    index: true,
    description: 'Reference to delivery location Sector (customer destination)',
  },
  locationId: {
    type: String,
    index: true,
    description: 'Reference to delivery location (customer destination)',
  },

  createdAt: { type: Date, default: Date.now },
  // Admin order timelines read `updatedAt`; without it (or timestamps:true)
  // every "Accepted"/status-change entry was filtered out as undefined.
  updatedAt: { type: Date, default: Date.now },
});

// Keep `updatedAt` fresh on every save() so timeline/analytics readers see
// the last modification without callers having to set the field themselves.
orderSchema.pre('save', function assignUpdatedAt(next) {
  this.updatedAt = new Date();
  next();
});

// One order can carry items from several shops. The owner order list
// (`findBySellerOrShop`) and the admin shop detail both filter on the shipment
// shop id — without this index both are collection scans.
orderSchema.index({ 'sellerShipments.shopId': 1 });
orderSchema.index({ requestId: 1 }, { unique: true, partialFilterExpression: { requestId: { $type: 'string' } } });

module.exports = mongoose.model('Order', orderSchema);
