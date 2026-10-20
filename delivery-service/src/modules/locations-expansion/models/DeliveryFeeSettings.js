const mongoose = require('mongoose');

const settingsSchema = new mongoose.Schema({
  key: { type: String, default: 'platform', unique: true },
  defaultFee: { type: Number, min: 0, default: 150 },
  delivererShareRate: { type: Number, min: 0, max: 100, default: 80 },
  minimumPayout: { type: Number, min: 0, default: 0 },
  holdHours: { type: Number, min: 0, default: 24 },
}, { timestamps: true });

module.exports = mongoose.model('DeliveryFeeSettings', settingsSchema);
