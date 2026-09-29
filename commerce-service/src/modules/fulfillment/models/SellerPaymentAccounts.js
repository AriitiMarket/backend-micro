const mongoose = require('mongoose');

const sellerPaymentAccountSchema = new mongoose.Schema({
  sellerId: { type: String, required: true, index: true },
  methodId: { type: String, required: true, index: true },
  provider: { type: String, default: '' },
  status: { type: String, enum: ['PENDING', 'VERIFIED', 'REJECTED', 'SUSPENDED'], default: 'PENDING' },
  isDefault: { type: Boolean, default: false },
  // Only a masked, non-secret label is returned to admin/customer UIs.
  accountLabel: { type: String, required: true },
  accountHint: { type: String, required: true },
  encryptedDetails: { type: String, required: true, select: false },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

sellerPaymentAccountSchema.index({ sellerId: 1, methodId: 1 }, { unique: true });
sellerPaymentAccountSchema.pre('save', function(next) { this.updatedAt = new Date(); next(); });
module.exports = mongoose.model('SellerPaymentAccount', sellerPaymentAccountSchema);
