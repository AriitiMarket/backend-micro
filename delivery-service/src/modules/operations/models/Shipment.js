const mongoose = require('mongoose');

const shipmentItemSchema = new mongoose.Schema({
  deliveryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Delivery', required: true },
  orderId: { type: String, required: true },
  // Identity-service ids are UUIDs, not ObjectIds (same as Delivery).
  sellerId: { type: String, required: true },
  buyerId: { type: String, required: true },
  weight: { type: Number, default: 0 },
  quantity: { type: Number, default: 1 },
  status: { type: String, default: 'added' },
}, { _id: false });

const shipmentHistorySchema = new mongoose.Schema({
  status: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
  actorId: { type: String, default: null },
  actorName: { type: String, default: null },
  locationId: { type: mongoose.Schema.Types.ObjectId, default: null },
  portId: { type: mongoose.Schema.Types.ObjectId, default: null },
  note: { type: String, default: '' },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { _id: false });

const shipmentSchema = new mongoose.Schema({
  shipmentNumber: { type: String, unique: true, sparse: true },
  status: { 
    type: String, 
    enum: ['planning', 'ready', 'dispatched', 'in_transit', 'arrived', 'receiving', 'received', 'completed', 'cancelled', 'failed', 'returned'],
    default: 'planning'
  },
  originLocationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', default: null },
  destinationLocationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', default: null },
  originPortId: { type: mongoose.Schema.Types.ObjectId, ref: 'Port', default: null },
  destinationPortId: { type: mongoose.Schema.Types.ObjectId, ref: 'Port', default: null },
  routeId: { type: mongoose.Schema.Types.ObjectId, ref: 'DeliveryRoute', default: null },
  serviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'DeliveryService', default: null },
  providerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Provider', default: null },
  
  snapshots: {
    originName: { type: String, default: '' },
    destinationName: { type: String, default: '' },
    routeName: { type: String, default: '' },
    originPortName: { type: String, default: '' },
    destinationPortName: { type: String, default: '' }
  },

  capacity: {
    maxWeight: { type: Number, default: null },
    usedWeight: { type: Number, default: 0 },
    maxItems: { type: Number, default: null },
    usedItems: { type: Number, default: 0 },
  },

  items: [shipmentItemSchema],
  history: [shipmentHistorySchema]

}, { timestamps: true });

shipmentSchema.index({ status: 1 });
shipmentSchema.index({ originPortId: 1 });
shipmentSchema.index({ destinationPortId: 1 });
shipmentSchema.index({ providerId: 1 });
shipmentSchema.index({ 'items.deliveryId': 1 });

module.exports = mongoose.model('Shipment', shipmentSchema);
