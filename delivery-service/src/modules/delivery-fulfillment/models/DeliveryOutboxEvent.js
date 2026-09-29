const mongoose = require('mongoose');

const deliveryOutboxEventSchema = new mongoose.Schema({
  eventKey: { type: String, required: true },
  deliveryId: { type: String, required: true },
  orderId: { type: String, required: true },
  providerId: { type: String, default: null },
  status: { type: String, required: true },
  note: { type: String, default: '' },
  proofOfDelivery: { type: mongoose.Schema.Types.Mixed, default: null },
  state: { type: String, enum: ['PENDING', 'PROCESSING', 'SENT'], default: 'PENDING' },
  attempts: { type: Number, default: 0 },
  nextAttemptAt: { type: Date, default: Date.now },
  lockedAt: { type: Date, default: null },
  lastError: { type: String, default: '' },
  sentAt: { type: Date, default: null },
}, { timestamps: true });

deliveryOutboxEventSchema.index({ eventKey: 1 }, { unique: true });
deliveryOutboxEventSchema.index({ state: 1, nextAttemptAt: 1, createdAt: 1 });

module.exports = mongoose.model('DeliveryOutboxEvent', deliveryOutboxEventSchema);
