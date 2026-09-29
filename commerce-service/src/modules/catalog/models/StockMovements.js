const mongoose = require('mongoose');

const stockMovementSchema = new mongoose.Schema({
  productId: { type: String, required: true, index: true },
  shopId: { type: String, required: true, index: true },
  sellerId: { type: String, index: true },
  type: {
    type: String,
    enum: ['order_placed', 'order_confirmed', 'order_cancelled', 'refund', 'restock', 'adjustment', 'order_transferred'],
    required: true,
  },
  quantity: { type: Number, required: true },
  stockBefore: { type: Number, required: true },
  stockAfter: { type: Number, required: true },
  orderId: { type: String, default: null },
  note: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('StockMovement', stockMovementSchema);
