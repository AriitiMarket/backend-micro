const mongoose = require('mongoose');

// Commerce Service owns the Shop. Seller identity (ownerId) references Identity Service user.
const shopSchema = new mongoose.Schema({
  name: { type: String, required: [true, 'Please enter your business name!'] },
  email: { type: String, required: [true, 'Please enter your business email address'] },
  ownerId: { type: String, index: true, required: true }, // Identity Service user id (SELLER)
  description: { type: String },
  // Shop/business category — a title-as-FK into Category (type 'business'),
  // same convention Product.category uses for product categories. Copied from
  // the approved SellerApplication so the storefront can browse shops BY SHOP
  // CATEGORY instead of misusing product categories.
  category: { type: String, trim: true, default: '', index: true },
  address: { type: String, required: true },
  // Phone/zip are strings: validators accept "+251-911…" and leading zeros,
  // both of which Number would destroy. Existing numeric docs are cast on read.
  // Not `required` — admin-provisioned shops (application approval) may lack a
  // phone; the seller create/update API still validates when the field is sent.
  phoneNumber: { type: String, default: '' },
  role: { type: String, default: 'Seller' },
  avatar: {
    public_id: { type: String, required: true },
    url: { type: String, required: true },
  },
  zipCode: { type: String, default: '' },
  
  // Location & Expansion relationships
  locationId: {
    type: String,
    index: true,
    description: 'Reference to Delivery Location (geographic area for operations)'
  },
  sectorId: {
    type: String,
    index: true,
    description: 'Reference to Delivery Sector (specific delivery area)'
  },

  // Full location snapshot (read-only from Delivery hierarchy, cached for orders)
  locationSnapshot: {
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
    resolvedAt: { type: Date, default: null },
  },

  // DELIVERY COVERAGE (service areas) — which delivery ZONES this shop serves.
  //
  // Deliberately separate from `locationSnapshot` above: the snapshot is WHERE
  // the shop physically is, coverage is WHERE it delivers to. A shop in Harar
  // may serve several zones; neither field can stand in for the other.
  //
  // The zone IDs reference the Delivery Service's Zone collection (the single
  // source of truth for zone definitions) — Commerce only caches the reference,
  // never zone data. Zone ids/names are re-validated against Delivery whenever
  // an admin writes this block (shopCoverage.service), and `zoneNames` is the
  // denormalized snapshot of that validation so public payloads stay a local
  // read.
  //
  // Legacy documents predate the field: readers MUST treat an absent/empty
  // block as UNCONFIGURED ("Delivery coverage not configured") and block
  // checkout for that shop — never guess a zone.
  deliveryCoverage: {
    zoneIds: [{ type: String }],
    zoneNames: [{
      _id: false,
      id: { type: String },
      name: { type: String },
    }],
    status: {
      type: String,
      enum: ['UNCONFIGURED', 'ACTIVE', 'PAUSED'],
      default: 'UNCONFIGURED',
    },
    source: { type: String, enum: ['ADMIN', 'APPLICATION', 'MIGRATION'], default: null },
    verifiedBy: { type: String, default: null },
    verifiedAt: { type: Date, default: null },
    updatedAt: { type: Date, default: null },
  },
  // Buyer collection is enabled explicitly per shop. Missing values on legacy
  // shops remain disabled until the seller/admin opts in.
  pickupEnabled: { type: Boolean, default: false, index: true },
  pickupHours: { type: String, default: '' },
  
  // NEW: Status tracking (separate from role which is always 'Seller')
  status: {
    type: String,
    enum: ['PENDING_APPROVAL', 'APPROVED', 'SUSPENDED', 'INACTIVE', 'ACTIVE'],
    default: 'PENDING_APPROVAL',
    index: true,
    description: 'Shop operational status: PENDING_APPROVAL (awaiting admin), APPROVED (admin approved), ACTIVE (operational), SUSPENDED (temporarily closed), INACTIVE (deactivated)'
  },
  
  // NEW: Link to SellerApplication for audit trail
  applicationId: {
    type: String,
    index: true,
    description: 'Reference to SellerApplication that initiated this shop'
  },

  // The BUSINESS this shop belongs to (User -> Seller Actor -> Business -> Shop).
  // Always a SellerApplication _id. Kept separate from `applicationId` because
  // `applicationId` records which application *initiated* the shop (and may be
  // absent for shops opened directly from the seller console), while
  // `businessId` records which business *owns* it — and must exist for every
  // shop. `createShop` backfills both; the hierarchy migration backfills the rest.
  businessId: {
    type: String,
    index: true,
    description: 'Reference to the SellerApplication (business) that owns this shop'
  },

  withdrawMethod: { type: Object },
  availableBalance: { type: Number, default: 0 },
  transections: [
    {
      amount: { type: Number },
      status: { type: String, default: 'Processing' },
      createdAt: { type: Date, default: Date.now },
      updatedAt: { type: Date },
    },
  ],
  
  // NEW: Timestamps for audit and tracking
  createdAt: { type: Date, default: Date.now, index: true },
  updatedAt: { type: Date, default: Date.now },
  
  // NEW: Approval metadata
    approvalMetadata: {
    approvedBy: { type: String, description: 'Admin user ID who approved' },
    approvedAt: { type: Date },
    rejectionReason: { type: String },
    suspensionReason: { type: String },
    suspendedBy: { type: String, description: 'Admin user ID who suspended' },
    suspendedAt: { type: Date },
  },

  // Curation flags for the public marketplace (optional; default to "visible"
  // so listings are never emptied when the flags are absent).
  showOnPublic: { type: Boolean, default: true },
  featured: { type: Boolean, default: false },
  displayPriority: { type: Number, default: 0 },
});

// Index for common admin queries
shopSchema.index({ ownerId: 1, status: 1 });
// Public marketplace browse: visibility gate + optional shop category filter
shopSchema.index({ status: 1, category: 1 });
shopSchema.index({ locationId: 1, status: 1 });
shopSchema.index({ sectorId: 1, status: 1 });
shopSchema.index({ 'locationSnapshot.regionId': 1, status: 1 });
shopSchema.index({ 'locationSnapshot.cityId': 1, status: 1 });
shopSchema.index({ 'locationSnapshot.areaId': 1, status: 1 });
// Zone-aware discovery + admin coverage filters: "which shops serve zone X?"
// and "which shops have no configured coverage?" would otherwise scan.
shopSchema.index({ 'deliveryCoverage.zoneIds': 1, status: 1 });
shopSchema.index({ 'deliveryCoverage.status': 1, status: 1 });

module.exports = mongoose.model('Shop', shopSchema);
