const mongoose = require('mongoose');

const disputeSchema = new mongoose.Schema({
  orderId: { type: String, default: null },
  buyerId: { type: String, required: true },
  buyerName: { type: String, default: null },
  sellerId: { type: String, default: null },
  sellerName: { type: String, default: null },
  shopId: { type: mongoose.Schema.Types.ObjectId, default: null },
  riderId: { type: String, default: null },
  riderName: { type: String, default: null },
  filedBy: { type: String, default: null },
  filedByRole: { type: String, default: null },
  type: {
    type: String,
    enum: ['order', 'payment', 'delivery', 'product', 'other'],
    required: true,
  },
  subject: { type: String, required: true, trim: true },
  description: { type: String, required: true, trim: true },
  status: {
    type: String,
    enum: ['open', 'in_progress', 'under_investigation', 'resolved', 'rejected', 'closed'],
    default: 'open',
  },
  priority: {
    type: String,
    enum: ['low', 'medium', 'high', 'critical'],
    default: 'medium',
  },
  evidence: [
    {
      title: { type: String, default: null },
      description: { type: String, default: null },
      fileUrl: { type: String, default: null },
      uploadedAt: { type: Date, default: Date.now },
    },
  ],
  assignedToAdmin: { type: String, default: null },
  resolution: { type: String, default: null },
  resolutionType: {
    type: String,
    enum: ['refund', 'replacement', 'credit', 'apology', 'none'],
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
  resolvedAt: { type: Date, default: null },
  closedAt: { type: Date, default: null },
}, { timestamps: true });

disputeSchema.index({ buyerId: 1 });
disputeSchema.index({ sellerId: 1 });
disputeSchema.index({ status: 1 });
disputeSchema.index({ priority: 1 });
disputeSchema.index({ type: 1 });
disputeSchema.index({ orderId: 1 }, { sparse: true });
disputeSchema.index({ createdAt: -1 });

const Dispute = mongoose.model('Dispute', disputeSchema);
module.exports = Dispute;
