const mongoose = require('mongoose');

const inventoryLedgerSchema = new mongoose.Schema({
  productId: { type: String, required: true, index: true },
  orderId: { type: String, default: null, index: true },
  returnId: { type: String, default: null },
  type: {
    type: String,
    enum: ['RESERVE', 'SELL', 'RELEASE', 'RESTORE', 'DEDUCT'],
    required: true,
    index: true,
  },
  quantity: { type: Number, required: true },
  reservationType: { type: String, default: null },
  previousStock: { type: Number, default: null },
  newStock: { type: Number, default: null },
  timestamp: { type: Date, default: Date.now, index: true },
}, { timestamps: false });

module.exports = mongoose.model('InventoryLedger', inventoryLedgerSchema);
