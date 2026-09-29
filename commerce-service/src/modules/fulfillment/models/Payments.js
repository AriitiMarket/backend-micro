const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema({
  // `orderId` is indexed by the UNIQUE declaration below — declaring it here
  // too made Mongoose register a second, non-unique index with the same auto
  // name (`orderId_1`), so syncIndexes() failed with "existing index has the
  // same name" and every suite that opened a connection was cancelled.
  orderId: { type: String, required: true },
  userId: { type: String, index: true },
  sellerId: { type: String, index: true },
  paymentMethod: { type: String, default: 'COD' },
  amount: { type: Number, required: true },
  currency: { type: String, default: 'ETB' },
  status: { type: String, enum: ['PENDING', 'COMPLETED', 'FAILED', 'REFUNDED'], default: 'PENDING' },
  transactionId: { type: String, default: undefined },
  metadata: { type: Object, default: {} },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});
// One payment per order. The unique index closes the race where two requests both pass findByOrder before either create.
paymentSchema.index({ orderId: 1 }, { unique: true });
paymentSchema.index({ transactionId: 1 }, { unique: true, partialFilterExpression: { transactionId: { $type: 'string' } } });


module.exports = mongoose.model('Payment', paymentSchema);
