const mongoose = require('mongoose');

const sectorSchema = new mongoose.Schema({
  name: { type: String, required: true },
  description: { type: String },
  city: { type: String, required: true },
  deliveryFee: { type: Number, required: true },
  estimatedDeliveryTime: { type: Number, required: true },
  isActive: { type: Boolean, default: true },
  boundaries: { type: Object, default: {} },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Sector', sectorSchema);
