const mongoose = require('mongoose');
const { DELIVERY_STATUSES } = require('../../../shared/constants');

// History is the delivery's audit trail: EVERY status the delivery state machine
// can reach must be storable here. The enum used to list only the original eight
// MVP values, so a transition outside that hand-written list was rejected by
// mongoose validation and the event was silently lost from history. It is now
// derived from the one canonical lifecycle list, so the two cannot drift again.
const trackingEventSchema = new mongoose.Schema({
  deliveryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Delivery', required: true },
  providerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Provider', default: null },
  status: { type: String, required: true, enum: DELIVERY_STATUSES },
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
