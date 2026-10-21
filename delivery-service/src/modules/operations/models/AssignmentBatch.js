const mongoose = require('mongoose');

/**
 * Multi-order assignment ("dispatch job").
 *
 * The legacy `Assignment` model is one delivery <-> one rider offer. The
 * product workflow is different: an admin selects MANY ready orders in one
 * operation, they become ONE assignment for ONE rider, and the rider walks a
 * single state machine (accept -> pick up from each seller -> deliver) while
 * every order inside keeps its OWN independent status and history.
 *
 * So this model is the parent job. It:
 *   - snapshots every order (delivery) in `deliveries[]` with a live per-order
 *     `status`, so the rider and admin both see individual progress;
 *   - pre-groups the orders into a `pickupPlan[]` (one stop per seller, in
 *     stable order) so the rider has an unambiguous collection sequence;
 *   - records the human reference (e.g. DL-2045) shown across both portals;
 *   - keeps an append-only `history[]` of every transition, and on reassignment
 *     links `reassignedFromId` so the previous batch is preserved, never
 *     silently duplicated or erased.
 */
const batchDeliverySchema = new mongoose.Schema({
  deliveryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Delivery', required: true },
  orderId: { type: String, required: true },
  sellerId: { type: String, required: true },
  sellerName: { type: String, default: '' },
  shopName: { type: String, default: '' },
  origin: { type: mongoose.Schema.Types.Mixed, default: null },
  destination: { type: mongoose.Schema.Types.Mixed, default: null },
  paymentMethod: { type: String, default: 'COD' },
  paymentAmount: { type: Number, default: 0 },
  // Mirrors the underlying Delivery status (independent per order).
  status: { type: String, default: 'assigned' },
}, { _id: false });

const pickupStopSchema = new mongoose.Schema({
  sequence: { type: Number, required: true },
  sellerId: { type: String, required: true },
  sellerName: { type: String, default: '' },
  shopName: { type: String, default: '' },
  address: { type: mongoose.Schema.Types.Mixed, default: null },
  contactPhone: { type: String, default: '' },
  contactName: { type: String, default: '' },
  // Order ids collected at this stop (grouped by seller).
  orderIds: { type: [String], default: [] },
  items: { type: [mongoose.Schema.Types.Mixed], default: [] },
  discrepancies: { type: [mongoose.Schema.Types.Mixed], default: [] },
  notes: { type: String, default: '' },
  completed: { type: Boolean, default: false },
  completedAt: { type: Date, default: null },
}, { _id: false });

const historyEntrySchema = new mongoose.Schema({
  status: { type: String, required: true },
  at: { type: Date, default: Date.now },
  actorId: { type: String, default: null },
  actorName: { type: String, default: '' },
  note: { type: String, default: '' },
}, { _id: false });

const assignmentBatchSchema = new mongoose.Schema({
  reference: { type: String, required: true, unique: true },
  providerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Provider', required: true },
  providerName: { type: String, default: '' },
  serviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'DeliveryService', default: null },
  routeId: { type: mongoose.Schema.Types.ObjectId, ref: 'DeliveryRoute', default: null },
  zoneIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Zone' }],

  status: {
    type: String,
    default: 'waiting_acceptance',
    enum: ['waiting_acceptance', 'accepted', 'picking_up', 'picked_up', 'in_transit', 'completed', 'rejected', 'cancelled'],
  },

  deliveries: { type: [batchDeliverySchema], default: [] },
  pickupPlan: { type: [pickupStopSchema], default: [] },

  assignedAt: { type: Date, default: Date.now },
  respondedAt: { type: Date, default: null },
  rejectedAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },
  cancelledAt: { type: Date, default: null },
  rejectionReason: { type: String, default: '' },
  cancellationReason: { type: String, default: '' },
  notes: { type: String, default: '' },

  // Reassignment lineage: the new batch points at the batch it replaced.
  reassignedFromId: { type: mongoose.Schema.Types.ObjectId, ref: 'AssignmentBatch', default: null },
  reassignedToId: { type: mongoose.Schema.Types.ObjectId, ref: 'AssignmentBatch', default: null },

  history: { type: [historyEntrySchema], default: [] },
}, { timestamps: true });

assignmentBatchSchema.index({ providerId: 1 });
assignmentBatchSchema.index({ status: 1 });
assignmentBatchSchema.index({ 'deliveries.deliveryId': 1 });
assignmentBatchSchema.index({ 'deliveries.orderId': 1 });

module.exports = mongoose.model('AssignmentBatch', assignmentBatchSchema);
