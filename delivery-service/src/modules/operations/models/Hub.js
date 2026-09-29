const mongoose = require('mongoose');

const hubSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  locationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', required: true },
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

hubSchema.index({ status: 1 });
hubSchema.index({ locationId: 1 });

module.exports = mongoose.model('Hub', hubSchema);
