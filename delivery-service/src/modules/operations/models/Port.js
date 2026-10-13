const mongoose = require('mongoose');

const portSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  locationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', required: true },
  zoneId: { type: mongoose.Schema.Types.ObjectId, ref: 'Zone', default: null },
  coordinates: { latitude: { type: Number, default: null }, longitude: { type: Number, default: null } },
  status: { type: String, default: 'active', enum: ['active', 'inactive', 'suspended'] },
  description: { type: String, default: '' },
  capacity: { type: Number, default: 100 },
  currentLoad: { type: Number, default: 0 },
  contactPhone: { type: String, default: '' },
  contactEmail: { type: String, default: '' },
  operatingHours: {
    open: { type: String, default: '08:00' },
    close: { type: String, default: '18:00' },
  },
}, { timestamps: true });

portSchema.index({ status: 1 });
portSchema.index({ locationId: 1 });
portSchema.index({ zoneId: 1 });

module.exports = mongoose.model('Port', portSchema);
