const mongoose = require('mongoose');

const routeSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  code: { type: String, default: null, unique: true, sparse: true },
  originLocationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', required: true },
  destinationLocationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', required: true },
  status: { type: String, default: 'active', enum: ['active', 'inactive', 'suspended', 'archived'] },
  distanceKm: { type: Number, default: null },
  estimatedDurationMinutes: { type: Number, default: null },
  description: { type: String, default: '' },
  waypoints: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Location' }],
  // Operational fields
  providerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Provider', default: null },
  vehicleRequirements: [{ type: String }],
  riderRequirements: [{ type: String }],
  operatingHours: {
    open: { type: String, default: null },
    close: { type: String, default: null },
    days: { type: [String], default: [] },
  },
  maxCapacity: { type: Number, default: null },
  priority: { type: Number, default: 5, min: 1, max: 10 },
}, { timestamps: true });

routeSchema.index({ originLocationId: 1 });
routeSchema.index({ destinationLocationId: 1 });
routeSchema.index({ status: 1 });
routeSchema.index({ providerId: 1 });
routeSchema.index({ priority: 1 });
routeSchema.index({ code: 1 }, { sparse: true });

module.exports = mongoose.model('DeliveryRoute', routeSchema);
