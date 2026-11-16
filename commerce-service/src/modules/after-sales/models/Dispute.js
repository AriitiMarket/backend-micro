const mongoose = require('mongoose');

const DISPUTE_TYPES = ['ORDER', 'PAYMENT', 'DELIVERY', 'PRODUCT', 'OTHER', 'order', 'payment', 'delivery', 'product', 'other'];

const disputeSchema = new mongoose.Schema({
  orderId: { type: String, default: null },
  buyerId: { type: String, default: null, index: true },
  buyerName: { type: String, default: null },
  sellerId: { type: String, default: null, index: true },
  sellerName: { type: String, default: null },
  shopId: { type: mongoose.Schema.Types.ObjectId, default: null },
  riderId: { type: String, default: null },
  riderName: { type: String, default: null },
  filedBy: { type: String, default: null },
  filedByRole: { type: String, default: null },

  // Unified initiator fields from OrderDispute
  initiator: { type: String, default: null },
  initiatorRole: { type: String, enum: ['BUYER', 'SELLER', 'ADMIN', null], default: null },

  // Consolidated disputeType enum + legacy type
  disputeType: {
    type: String,
    enum: DISPUTE_TYPES,
    default: 'ORDER',
    index: true,
  },
  type: {
    type: String,
    enum: ['order', 'payment', 'delivery', 'product', 'other'],
    default: 'order',
    index: true,
  },

  subject: { type: String, default: '', trim: true },
  description: { type: String, default: '', trim: true },
  reason: { type: String, default: null },

  status: {
    type: String,
    enum: [
      'open', 'in_progress', 'under_investigation', 'resolved', 'rejected', 'closed',
      'OPEN', 'INVESTIGATING', 'ESCALATED', 'RESOLVED',
    ],
    default: 'open',
    index: true,
  },
  priority: {
    type: String,
    enum: ['low', 'medium', 'high', 'critical', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'],
    default: 'medium',
    index: true,
  },

  evidence: mongoose.Schema.Types.Mixed,
  assignedToAdmin: { type: String, default: null },
  resolvedBy: { type: String, default: null },
  resolution: mongoose.Schema.Types.Mixed,
  resolutionType: {
    type: String,
    enum: ['refund', 'replacement', 'credit', 'apology', 'none', null],
    default: null,
  },
  compensationAmount: { type: Number, default: 0 },

  notes: [
    {
      adminId: { type: String, required: true },
      adminName: { type: String, default: null },
      note: { type: String, required: true },
      createdAt: { type: Date, default: Date.now },
    },
  ],
  timeline: [
    {
      action: { type: String, required: true },
      adminId: { type: String, default: null },
      timestamp: { type: Date, default: Date.now },
      details: { type: String, default: null },
    },
  ],

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  resolvedAt: { type: Date, default: null },
  closedAt: { type: Date, default: null },
}, { timestamps: true });

disputeSchema.pre('validate', function(next) {
  if (this.reason && !this.subject) this.subject = this.reason;
  if (this.reason && !this.description) this.description = this.reason;
  if (this.subject && !this.reason) this.reason = this.subject;
  if (!this.buyerId && this.initiator) this.buyerId = this.initiator;
  if (!this.initiator && this.buyerId) this.initiator = this.buyerId;
  if (!this.filedBy && this.initiator) this.filedBy = this.initiator;
  if (!this.filedBy && this.buyerId) this.filedBy = this.buyerId;
  if (this.disputeType && !this.type) {
    this.type = String(this.disputeType).toLowerCase();
  }
  if (this.type && !this.disputeType) {
    this.disputeType = String(this.type).toUpperCase();
  }
  next();
});

disputeSchema.index({ status: 1, createdAt: -1 });
disputeSchema.index({ orderId: 1 }, { sparse: true });

const Dispute = (mongoose.models.Dispute || mongoose.model('Dispute', disputeSchema));
module.exports = Dispute;
