const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  providerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Provider', required: true, index: true },
  deliveryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Delivery', default: null },
  payoutId: { type: mongoose.Schema.Types.ObjectId, default: null },
  key: { type: String, required: true, unique: true },
  type: { type: String, enum: ['delivery_earning', 'earning_available', 'payout_requested', 'payout_paid', 'payout_rejected', 'earning_reversed'], required: true },
  amount: { type: Number, required: true, min: 0 },
  status: { type: String, enum: ['pending', 'available', 'locked', 'paid', 'rejected', 'reversed'], default: 'available' },
  availableAt: { type: Date, default: null },
  note: { type: String, default: '' },
}, { timestamps: true });

module.exports = mongoose.model('ProviderWalletTransaction', transactionSchema);
