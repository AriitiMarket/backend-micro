const mongoose = require('mongoose');

const PRODUCT_REQUEST_STATUSES = [
  'PENDING', 'REVIEWING', 'NEGOTIATING', 'AGREED', 'CONVERTING', 'CONVERTED',
  'DECLINED', 'CANCELLED', 'EXPIRED',
];

// Statuses that still accept messages/offers and can still expire.
const OPEN_REQUEST_STATUSES = ['PENDING', 'REVIEWING', 'NEGOTIATING'];

/** Platform abuse report raised against a request (buyer/seller/admin). */
const reportSchema = new mongoose.Schema({
  reportedBy: { type: String, required: true },
  reporterRole: { type: String, default: null },
  category: { type: String, default: 'OTHER', maxlength: 40 },
  reason: { type: String, required: true, maxlength: 500 },
  details: { type: String, default: '', maxlength: 2000 },
  status: { type: String, enum: ['OPEN', 'RESOLVED', 'DISMISSED'], default: 'OPEN' },
  createdAt: { type: Date, default: Date.now },
  reviewedBy: { type: String, default: null },
  reviewedAt: { type: Date, default: null },
  resolution: { type: String, default: '', maxlength: 500 },
}, { _id: true });

/**
 * One entry of the request's own timeline. Kept on the document (instead of
 * the global audit log) because buyers and sellers must be able to read it
 * without admin rights, and it is bounded with $slice.
 */
const activitySchema = new mongoose.Schema({
  type: { type: String, required: true, maxlength: 48 },
  actorId: { type: String, default: null },
  actorRole: { type: String, default: null },
  summary: { type: String, default: '', maxlength: 240 },
  data: { type: mongoose.Schema.Types.Mixed, default: null },
  createdAt: { type: Date, default: Date.now },
}, { _id: true });

const offerSchema = new mongoose.Schema({
  productId: { type: String, default: null },
  productName: { type: String, default: '' },
  quantity: { type: Number, required: true, min: 1 },
  /** Unit of measure (Piece, Dozen, kg, Bag…). Mirrors the request's unit. */
  unit: { type: String, default: '', maxlength: 32 },
  unitPrice: { type: Number, required: true, min: 0 },
  totalPrice: { type: Number, required: true, min: 0 },
  note: { type: String, default: '' },
  /** Optional expiry the counterparty should honour. */
  validUntil: { type: Date, default: null },
  /**
   * Snapshot of the offer this one counters (quantity/unit/unitPrice/
   * totalPrice/product), so the UI can show "Previous … → New …" without
   * guessing. null for the first offer.
   */
  previous: { type: mongoose.Schema.Types.Mixed, default: null },
  status: { type: String, enum: ['ACTIVE', 'ACCEPTED', 'DECLINED', 'SUPERSEDED'], default: 'ACTIVE' },
  createdBy: { type: String, required: true },
  createdByRole: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
}, { _id: true });

/** Product Request — buyer/seller negotiation, never delivery. */
const requestSchema = new mongoose.Schema({
  // One canonical owner field: `buyerId`. The legacy `customerId` twin was
  // removed (boot migration folds it in) so a request can never carry two
  // disagreeing owners.
  buyerId: { type: String, required: true, index: true },
  sellerId: { type: String, default: null, index: true },
  shopId: { type: String, default: null, index: true },
  productId: { type: String, default: null, index: true },
  subject: { type: String, required: true, trim: true, maxlength: 300 },
  title: { type: String, required: true, trim: true, maxlength: 300 },
  details: { type: String, default: '', trim: true, maxlength: 5000 },
  quantity: { type: Number, required: true, min: 1 },
  /** Unit of measure for `quantity` (Piece, Pieces, Dozen, kg, Bag…). */
  unit: { type: String, default: 'Unit', trim: true, maxlength: 32 },
  /** Snapshot of the product being sourced (header + admin table). */
  productName: { type: String, default: '', maxlength: 300 },
  /**
   * Snapshot of the seller side (business name + owner) taken at creation so
   * every list/detail — including the admin workspace — can name both parties
   * without joining the shops collection.
   */
  seller: { type: mongoose.Schema.Types.Mixed, default: {} },
  /**
   * Free-form structured requirements — deliberately NOT a fixed product
   * schema: quality, brand, size, color, packaging plus an open notes field,
   * all optional, all strings. Buyers describe what they need; sellers quote
   * against it.
   */
  specs: {
    type: mongoose.Schema.Types.Mixed,
    default: () => ({ quality: '', brand: '', size: '', color: '', packaging: '', notes: '' }),
  },
  targetPrice: { type: Number, default: null, min: 0 },
  attachments: [{ url: { type: String, required: true }, publicId: { type: String, default: null } }],
  status: { type: String, enum: PRODUCT_REQUEST_STATUSES, default: 'PENDING', index: true },
  expiresAt: { type: Date, default: null },
  conversationId: { type: String, default: null, index: true },
  offers: [offerSchema],
  response: { type: String, default: '' },
  respondedBy: { type: String, default: null },
  respondedAt: { type: Date, default: null },
  buyer: { type: mongoose.Schema.Types.Mixed, default: {} },
  orderId: { type: String, default: null, index: true },
  conversionStartedAt: { type: Date, default: null },
  /**
   * Delivery destination the customer picked when the agreement became an
   * order. The request is still a negotiation document — this is only the
   * address the converted order ships to, remembered so a retry (or the
   * order view) never has to ask for it again.
   */
  destination: { type: mongoose.Schema.Types.Mixed, default: null },
  /**
   * Explicit dual confirmation of the final terms. Nothing is auto-confirmed:
   * the buyer confirms by accepting the offer (or pressing Confirm Agreement)
   * and the seller confirms separately. `confirmedAt` — and therefore order
   * creation — only exists once BOTH sides have confirmed.
   */
  agreement: {
    type: mongoose.Schema.Types.Mixed,
    default: () => ({
      buyerConfirmedAt: null,
      sellerConfirmedAt: null,
      confirmedAt: null,
      note: '',
      terms: null,
    }),
  },
  /** Platform moderation: while suspended, nobody may post or counter. */
  suspended: { type: Boolean, default: false },
  suspendReason: { type: String, default: '', maxlength: 500 },
  suspendedBy: { type: String, default: null },
  suspendedAt: { type: Date, default: null },
  /** Abuse reports raised against this request (see reportSchema). */
  reports: [reportSchema],
  /** Bounded per-request timeline read by all participants + admin. */
  activity: {
    type: [activitySchema],
    default: [],
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
}, { timestamps: true, minimize: false });

requestSchema.index({ buyerId: -1, createdAt: -1 });
requestSchema.index({ shopId: 1, status: 1, createdAt: -1 });
requestSchema.index({ status: 1, createdAt: -1 });
// Backs the expiry sweep (open request + deadline in the past).
requestSchema.index({ expiresAt: 1, status: 1 });
// Admin moderation filters ("Reported" / suspended views).
requestSchema.index({ 'reports.status': 1, createdAt: -1 });
requestSchema.index({ suspended: 1, createdAt: -1 });

module.exports = mongoose.model('Request', requestSchema);
module.exports.PRODUCT_REQUEST_STATUSES = PRODUCT_REQUEST_STATUSES;
module.exports.OPEN_REQUEST_STATUSES = OPEN_REQUEST_STATUSES;
