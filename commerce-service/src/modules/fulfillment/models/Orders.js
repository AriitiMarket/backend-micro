const mongoose = require('mongoose');
const crypto = require('crypto');
const {
  ORDER_STATUSES,
  ORDER_STATUS_VALUES,
  PAYMENT_STATUS_VALUES,
} = require('../constants/orderStatuses');

// Sub-schema for a single seller's shipment within an order.
// Every seller/shop represented in the order gets its own snapshot.
const sellerShipmentSchema = new mongoose.Schema({
  sellerId: { type: String, required: true },
  businessId: { type: String, default: null },
  shopId: { type: String, required: true },

  // Products from this seller in the order
  items: [{ type: mongoose.Schema.Types.Mixed, required: true }],
  subtotal: { type: Number, default: 0 },
  discountAmount: { type: Number, default: 0 }, // Shop-specific promotion discount

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
  // Human-readable order reference (ORD-<epoch ms>-<random>). The database
  // carries a UNIQUE index on this field, so it has to be populated on EVERY
  // insert: an order created without it collides with the first order that
  // lacks one and the whole checkout fails with a duplicate-key error.
  orderNumber: { type: String, default: null },

  // --- Core order data ---
  cart: { type: Array, required: true },
  user: { type: Object, required: true },
  buyerId: { type: String, index: true },
  // Set when the order was created from an agreed product request
  // (Request Management → order). Null for a normal checkout.
  requestId: { type: String, default: null },
  // Groups the per-seller Order documents produced by one buyer checkout into
  // a single "buyer order". All seller fulfillment groups from the same
  // checkout share this id, so the admin audit view and the allocation ledger
  // can reconstruct the complete purchase from its seller-level rows.
  orderGroupId: { type: String, index: true, default: null },

  // --- Money (server-computed, per order) ---
  // One checkout can split into several orders (one per seller/shop), so each
  // order carries ITS OWN money breakdown. Previously a single `totalPrice`
  // computed over the whole cart was copied into every order, so a 2-shop
  // checkout showed the full amount on both orders (and double-counted it in
  // the buyer's history).
  subtotal: { type: Number, default: 0 },
  shippingFee: { type: Number, default: 0 },
  fulfilmentType: { type: String, enum: ['delivery', 'pickup'], default: 'delivery', index: true },
  // Pickup code is never stored in plaintext. The raw six digit code is only
  // returned once at checkout so the buyer can present it at collection.
  pickupCodeHash: { type: String, default: null, select: false },
  pickupCodeAttempts: { type: Number, default: 0 },
  pickupReadyAt: { type: Date, default: null },
  pickupCompletedAt: { type: Date, default: null },
  pickupExpiresAt: { type: Date, default: null },
  // Delivery quote and deliverer-share contract captured at checkout.
  deliveryFeeRuleId: { type: String, default: null },
  delivererShareRate: { type: Number, min: 0, max: 100, default: 80 },
  discountAmount: { type: Number, default: 0 }, // Applied promotion discount
  currency: { type: String, default: 'ETB' },
  totalPrice: { type: Number, required: true },

  // --- Promotion applied to this order ---
  appliedPromotionId: { type: String, default: null },
  promoCode: { type: String, default: null },
  promoDiscountDetails: {
    discountType: { type: String },
    discountPercent: { type: Number },
    fixedAmount: { type: Number },
    maxDiscountAmount: { type: Number },
    isPlatformWide: { type: Boolean },
  },
  // The canonical order lifecycle (modules/fulfillment/constants/orderStatuses).
  // This was a bare String, so any `.save()` could persist a status the state
  // machine knows nothing about — and every read then had to guess. Legacy
  // uppercase spellings are rewritten onto the canonical values by the boot
  // migration in src/app/config/database.js, so the enum can be strict.
  status: { type: String, enum: ORDER_STATUS_VALUES, default: ORDER_STATUSES.PROCESSING },
  paymentStatus: { type: String, enum: PAYMENT_STATUS_VALUES, default: 'PENDING' },
  paymentSettlementStartedAt: { type: Date, default: null },
  paymentInfo: { id: { type: String }, status: { type: String }, type: { type: String }, method: { type: String, default: 'COD' } },
  reservation: { type: Object, default: {} },
  // Set only after an authoritative settlement event (COD proof or a verified
  // payment-provider callback).
  paidAt: { type: Date, default: null },
  deliveredAt: { type: Date },
  cancelledAt: { type: Date },
  buyerConfirmedReceipt: { type: Boolean, default: false },
  buyerConfirmedAt: { type: Date, default: null },

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

    // THE order's single delivery zone (Rule A: one order = one zone).
    // Resolved/validated server-side at checkout (shopCoverage.service) from
    // the buyer's address or the zone covering the destination location —
    // never trusted blindly from the client and never changed afterwards.
    // Legacy orders predate the field and carry null.
    deliveryZoneId: { type: String, default: null, index: true },
    deliveryZoneName: { type: String, default: '' },
    portId: { type: String, default: null, index: true },
    portName: { type: String, default: '' },

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
  // Present on seller-split checkout rows. `sellerShipments.shopId` remains
  // authoritative for multi-shop reads, while this keeps single-shop legacy
  // queries and exports compatible.
  shopId: { type: String, index: true, default: null },

  // Location & Sector tracking for admin scope filtering
  deliveryZoneId: { type: String, index: true, default: null },
  deliveryZoneName: { type: String, default: '' },
  portId: { type: String, index: true, default: null },
  portName: { type: String, default: '' },
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

// Give every order its human-readable reference before it is written. The
// unique index on `orderNumber` makes this mandatory: two orders without a
// number would collide and the second checkout would be rejected.
orderSchema.pre('validate', function assignOrderNumber(next) {
  if (!this.orderNumber) {
    this.orderNumber = `ORD-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  }
  next();
});

// One order can carry items from several shops. The owner order list
// (`findBySellerOrShop`) and the admin shop detail both filter on the shipment
// shop id — without this index both are collection scans.
orderSchema.index({ 'sellerShipments.shopId': 1 });
orderSchema.index({ requestId: 1 }, { unique: true, partialFilterExpression: { requestId: { $type: 'string' } } });
// Index for best-seller aggregation: status + paymentStatus + createdAt
orderSchema.index({ status: 1, paymentStatus: 1, createdAt: 1 });

orderSchema.methods.setPickupCode = function setPickupCode(code) {
  this.pickupCodeHash = crypto.createHash('sha256').update(String(code)).digest('hex');
};

module.exports = mongoose.model('Order', orderSchema);
