const mongoose = require('mongoose');

const paymentMethodSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, index: true },
  // Provider adapter key, e.g. telebirr, cbe_birr, flutterwave. This is not a secret.
  providerKey: { type: String, required: true, index: true },
  name: { type: String, required: true },
  type: { type: String, required: true, enum: ['OFFLINE', 'BANK', 'WALLET', 'GATEWAY', 'CARD'] },
  description: { type: String, default: '' },
  availableFor: { type: [String], default: ['BUYERS', 'SELLERS'] },
  supportedTransactionTypes: { type: [String], default: ['PAYMENT', 'PAYOUT'] },
  currency: { type: String, default: 'ETB' },
  minAmount: { type: Number, default: 0 },
  maxAmount: { type: Number, default: null },
  fixedFee: { type: Number, default: 0 },
  percentageFee: { type: Number, default: 0 },
  processingSettings: { type: Object, default: {} },
  verificationRequired: { type: Boolean, default: false },
  // Only references to environment-backed provider credentials belong here.
  // Never store API keys, app secrets, or merchant secrets in MongoDB.
  providerConfig: { type: Object, default: {} },
  settlementSettings: { type: Object, default: {} },
  status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'INACTIVE' },
  configured: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

paymentMethodSchema.pre('save', function(next) { this.updatedAt = new Date(); next(); });
module.exports = mongoose.model('PaymentMethod', paymentMethodSchema);
