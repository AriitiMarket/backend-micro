const mongoose = require('mongoose');

const deliveryServiceSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  code: { type: String, required: true, unique: true, trim: true },
  description: { type: String, default: '' },
  status: { type: String, default: 'active', enum: ['active', 'inactive', 'suspended'] },
  serviceType: { type: String, default: 'standard', enum: ['standard', 'express', 'same_day', 'next_day', 'rural', 'scheduled'] },
  coverageZones: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Zone' }],
  baseFee: { type: Number, default: 0 },
  perKmFee: { type: Number, default: 0 },
  maxWeightKg: { type: Number, default: 50 },
  estimatedDurationMinutes: { type: Number, default: 60 },
}, { timestamps: true });

deliveryServiceSchema.index({ status: 1 });
deliveryServiceSchema.index({ serviceType: 1 });

module.exports = mongoose.model('DeliveryService', deliveryServiceSchema);
