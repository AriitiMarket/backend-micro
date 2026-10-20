const mongoose = require('mongoose');

const payoutSchema = new mongoose.Schema({
  providerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Provider', required: true, index: true },
  amount: { type: Number, required: true, min: 0 },
  currency: { type: String, default: 'ETB' },
  status: { type: String, enum: ['pending', 'approved', 'paid', 'rejected', 'failed'], default: 'pending', index: true },
  payoutAccount: { type: mongoose.Schema.Types.Mixed, required: true },
  reference: { type: String, default: null },
  reason: { type: String, default: '' },
  reviewedBy: { type: String, default: null },
  reviewedAt: { type: Date, default: null },
}, { timestamps: true });

module.exports = mongoose.model('ProviderPayout', payoutSchema);
