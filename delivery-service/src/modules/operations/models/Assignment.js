const mongoose = require('mongoose');

const assignmentSchema = new mongoose.Schema({
  deliveryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Delivery', required: true },
  providerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Provider', required: true },
  serviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'DeliveryService', default: null },
  zoneId: { type: mongoose.Schema.Types.ObjectId, ref: 'Zone', default: null },
  hubId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hub', default: null },
  routeId: { type: mongoose.Schema.Types.ObjectId, ref: 'DeliveryRoute', default: null },
  status: { type: String, default: 'pending', enum: ['pending', 'accepted', 'rejected', 'expired', 'cancelled'] },
  assignedAt: { type: Date, default: Date.now },
  respondedAt: { type: Date, default: null },
  expiresAt: { type: Date, default: () => new Date(Date.now() + 5 * 60 * 1000) },
  rejectionReason: { type: String, default: '' },
  notes: { type: String, default: '' },
}, { timestamps: true });

assignmentSchema.index({ deliveryId: 1 });
assignmentSchema.index({ providerId: 1 });
assignmentSchema.index({ status: 1 });
// Hard guarantee: a delivery can never hold two active assignments at once,
// even when two admins assign simultaneously (MVP §29).
assignmentSchema.index(
  { deliveryId: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['pending', 'accepted'] } } }
);

module.exports = mongoose.model('Assignment', assignmentSchema);
