const mongoose = require('mongoose');

const walletSchema = new mongoose.Schema({
  providerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Provider', required: true, unique: true },
  pendingBalance: { type: Number, default: 0, min: 0 },
  availableBalance: { type: Number, default: 0, min: 0 },
  lockedBalance: { type: Number, default: 0, min: 0 },
  withdrawnBalance: { type: Number, default: 0, min: 0 },
  currency: { type: String, default: 'ETB' },
}, { timestamps: true });

module.exports = mongoose.model('ProviderWallet', walletSchema);
