const mongoose = require('mongoose');

const timelineEntrySchema = new mongoose.Schema({
  status: {
    type: String,
    enum: ['DRAFT', 'PENDING_REVIEW', 'MORE_INFORMATION_REQUIRED', 'APPROVED', 'REJECTED', 'SUSPENDED'],
    required: true,
  },
  changedAt: { type: Date, default: Date.now },
  changedBy: { type: String, required: true },
  reason: { type: String, trim: true },
}, { _id: false });

// Seller Application — owned by Commerce Service (MongoDB).
// This is the business on-boarding record; it is NOT the identity/account.
// `ownerId` references the Identity Service user (the Aritii account).
// Status lifecycle: DRAFT -> PENDING_REVIEW -> APPROVED | REJECTED | SUSPENDED
const sellerApplicationSchema = new mongoose.Schema({
  ownerId: { type: String, required: [true, 'Owner (user id) is required'] },
  // Canonical name for new clients; ownerId is retained for backward compatibility.
  userId: { type: String, index: true },

  // STEP 1 — Seller type
  sellerType: {
    type: String,
    enum: ['INDIVIDUAL', 'BUSINESS', 'SHOP', 'ORGANIZATION'],
    default: 'INDIVIDUAL',
  },

  // STEP 2 — Business information
  businessInformation: {
    businessName: { type: String, trim: true },
    businessCategory: { type: String, trim: true },
    description: { type: String, trim: true },
    phone: { type: String, trim: true },
    email: { type: String, trim: true },
  },

  // STEP 3 — Business location
  location: {
    // Legacy fields (kept for backward compat)
    country: { type: String, trim: true },
    region: { type: String, trim: true },
    city: { type: String, trim: true },
    address: { type: String, trim: true },
    // Location hierarchy references (from Delivery Service)
    regionId: { type: String },
    regionName: { type: String, trim: true },
    cityId: { type: String },
    cityName: { type: String, trim: true },
    areaId: { type: String },
    areaName: { type: String, trim: true },
    sectorId: { type: String },
    sectorName: { type: String, trim: true },
    deliveryZoneId: { type: String },
    deliveryZoneName: { type: String, trim: true },
    landmark: { type: String, trim: true },
    specificPlace: { type: String, trim: true },
    latitude: { type: Number },
    longitude: { type: Number },
  },

  // STEP 4 — Shop creation
  shopInformation: {
    shopName: { type: String, trim: true },
    description: { type: String, trim: true },
    category: { type: String, trim: true },
    logo: {
      public_id: { type: String },
      url: { type: String },
    },
    coverImage: {
      public_id: { type: String },
      url: { type: String },
    },
    publicPhone: { type: String, trim: true },
    publicEmail: { type: String, trim: true },
  },

  status: {
    type: String,
    enum: ['DRAFT', 'PENDING_REVIEW', 'MORE_INFORMATION_REQUIRED', 'APPROVED', 'REJECTED', 'SUSPENDED'],
    default: 'DRAFT',
  },

  verificationStatus: {
    emailVerified: { type: Boolean, default: false },
    phoneVerified: { type: Boolean, default: false },
    documentsVerified: { type: Boolean, default: false },
    addressVerified: { type: Boolean, default: false },
  },

  statusTimeline: { type: [timelineEntrySchema], default: [] },

  review: {
    reviewedBy: { type: String },
    reviewedAt: { type: Date },
    rejectionReason: { type: String },
    informationRequestReason: { type: String },
  },

  // Set once the application is approved and a Shop is created from it.
  shopId: { type: String },

  // True when this business record was synthesised by `createShop`/the
  // hierarchy migration because the owner already had a live Shop but no
  // business record. It exists to keep User -> Seller -> Business -> Shop
  // unbroken, NOT to represent a reviewed registration, so the seller may
  // still edit it (see `saveApplication`).
  provisionedFromShop: { type: Boolean, default: false },

  submittedAt: { type: Date },
  approvedAt: { type: Date },
  rejectedAt: { type: Date },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// One application per owner. The old check lived only in application code
// (`findByOwner` before create), so two concurrent submissions could still
// produce duplicate businesses for one account. Named explicitly because it
// replaces the legacy non-unique `ownerId_1` index (dropped by the boot
// migration) — reusing that name would collide with its options.
sellerApplicationSchema.index(
  { ownerId: 1 },
  { name: 'ownerId_unique_application', unique: true }
);

const SellerApplication = mongoose.model('SellerApplication', sellerApplicationSchema);

// A failed index build (e.g. duplicate owners already in existing data) is a
// loud warning, not a boot crash: mongoose emits an unhandled 'error' event on
// the model, which otherwise takes the service down.
SellerApplication.on('error', (err) => {
  console.error('[commerce] SellerApplication index warning:', err.message);
});

module.exports = SellerApplication;