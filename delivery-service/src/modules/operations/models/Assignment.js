const mongoose = require('mongoose');

const assignmentSchema = new mongoose.Schema({
  deliveryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Delivery', required: true },
  providerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Provider', required: true },
  serviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'DeliveryService', default: null },
  zoneId: { type: mongoose.Schema.Types.ObjectId, ref: 'Zone', default: null },
  portId: { type: mongoose.Schema.Types.ObjectId, ref: 'Port', default: null },
  routeId: { type: mongoose.Schema.Types.ObjectId, ref: 'DeliveryRoute', default: null },
  status: { type: String, default: 'pending', enum: ['pending', 'accepted', 'rejected', 'expired', 'cancelled'] },
  assignedAt: { type: Date, default: Date.now },
  respondedAt: { type: Date, default: null },
  expiresAt: { type: Date, default: () => new Date(Date.now() + 5 * 60 * 1000) },
  rejectionReason: { type: String, default: '' },
  notes: { type: String, default: '' },
  /**
   * Force-assignment exception (MVP §11). A forced assignment is a deliberate
   * admin decision to hand the delivery to a provider outside its Zone/Port, so
   * it is recorded ON the assignment — visible in history, never hidden:
   *
   *   forcedAssignment / forceReason / forcedBy / forcedAt  — the exception itself
   *   originalZoneId / originalPortId                      — the delivery's OWN area
   *   providerZoneId / providerPortId                      — where the provider works
   *
   * The delivery's destination zone/port are NEVER rewritten by an assignment
   * (§12) — these fields are the geographic record of the exception.
   */
  forcedAssignment: { type: Boolean, default: false },
  forceReason: { type: String, default: '' },
  forcedBy: { type: String, default: null },
  forcedAt: { type: Date, default: null },
  originalZoneId: { type: mongoose.Schema.Types.ObjectId, ref: 'Zone', default: null },
  originalPortId: { type: mongoose.Schema.Types.ObjectId, ref: 'Port', default: null },
  providerZoneId: { type: mongoose.Schema.Types.ObjectId, ref: 'Zone', default: null },
  providerPortId: { type: mongoose.Schema.Types.ObjectId, ref: 'Port', default: null },
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
