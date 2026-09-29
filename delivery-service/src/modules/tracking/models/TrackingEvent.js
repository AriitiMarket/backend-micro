const mongoose = require('mongoose');

const trackingEventSchema = new mongoose.Schema({
  deliveryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Delivery', required: true },
  providerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Provider', default: null },
  status: { type: String, required: true, enum: ['pending', 'assigned', 'pickup', 'in_transit', 'delivered', 'failed', 'cancelled', 'reassigned'] },
  location: {
    type: { type: String, enum: ['Point'], default: undefined },
    coordinates: { type: [Number], default: undefined },
  },
  accuracy: { type: Number, default: null },
  speed: { type: Number, default: null },
  heading: { type: Number, default: null },
  note: { type: String, default: '' },
  timestamp: { type: Date, default: Date.now },
}, { timestamps: true });

trackingEventSchema.index({ deliveryId: 1 });
trackingEventSchema.index({ deliveryId: 1, timestamp: 1 });
trackingEventSchema.index({ providerId: 1 });
trackingEventSchema.index({ location: '2dsphere' }, { sparse: true });

module.exports = mongoose.model('TrackingEvent', trackingEventSchema);
