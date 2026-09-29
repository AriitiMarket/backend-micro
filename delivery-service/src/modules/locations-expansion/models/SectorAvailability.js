const mongoose = require('mongoose');

const sectorAvailabilitySchema = new mongoose.Schema({
  locationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', required: true, index: true },
  sectorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', required: true, index: true },
  sectorName: { type: String, default: '', trim: true },
  isActive: { type: Boolean, default: true, index: true },
  deliveryAvailable: { type: Boolean, default: true },
  pickupAvailable: { type: Boolean, default: true },
  notes: { type: String, default: '' },
  updatedBy: { type: String, default: null },
}, { timestamps: true });

sectorAvailabilitySchema.index({ locationId: 1, sectorId: 1 }, { unique: true });

module.exports = mongoose.model('SectorAvailability', sectorAvailabilitySchema);
