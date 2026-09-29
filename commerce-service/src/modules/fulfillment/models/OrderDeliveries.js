const mongoose = require('mongoose');

/**
 * ORDER ↔ DELIVERY BRIDGE — the single table that connects a marketplace order
 * to its shipment.
 *
 * Why one linked table instead of delivery columns on the order:
 *   * the delivery state (status, actor, timestamps) is OWNED by the Delivery
 *     Service; keeping it in its own document preserves that ownership while
 *     still letting Commerce answer "what is happening with this order?" in one
 *     local read, without a cross-service call;
 *   * `orderId` is UNIQUE: one order ships as one shipment (the marketplace
 *     splits a checkout into per-seller orders, each shipped separately), so
 *     this row IS the lookup key from either side — the Delivery Service keys
 *     its own records by `orderId`, and Commerce keys this row the same way;
 *   * the row re-records what the delivery was ASKED to do (pickup, destination,
 *     items, value), so both sides can re-derive the delivery info even if the
 *     Delivery Service is unavailable.
 */
const orderDeliverySchema = new mongoose.Schema({
  // --- The link ---
  orderId: { type: String, required: true, unique: true, index: true },
  deliveryId: { type: String, default: null, index: true },
  deliveryRequestId: { type: String, default: null },
  handoffStatus: { type: String, enum: ['WAITING_APPROVAL', 'PENDING', 'COMPLETED', 'ABANDONED'], default: 'WAITING_APPROVAL' },
  // The DELIVERY provider that owns the shipment (was `partnerId`; renamed
  // with the delivery actor — boot migration in src/app/config/database.js).
  providerId: { type: String, default: null },
  serviceId: { type: String, default: null },

  // --- Delivery-owned state (mirror of the Delivery Service state machine) ---
  status: {
    type: String,
    enum: ['pending', 'assigned', 'pickup', 'in_transit', 'delivered', 'failed', 'cancelled', 'reassigned', null],
    default: null,
  },
  note: { type: String, default: null },
  statusUpdatedAt: { type: Date, default: null },

  // --- What was handed to the delivery provider (snapshot at request time) ---
  pickupLocationId: { type: String, default: null },
  destinationLocationId: { type: String, default: null },
  pickupAddress: { type: Object, default: null },
  deliveryAddress: { type: Object, default: null },
  items: { type: [mongoose.Schema.Types.Mixed], default: [] },
  totalValue: { type: Number, default: 0 },
  createdFrom: { type: String, default: 'checkout' },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('OrderDelivery', orderDeliverySchema);
