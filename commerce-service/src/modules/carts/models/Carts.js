const mongoose = require('mongoose');

const cartItemSchema = new mongoose.Schema({
  _id: { type: String, default: () => String(new mongoose.Types.ObjectId()) },
  productId: { type: String, required: true, index: true },
  shopId: { type: String, required: true, index: true },
  name: { type: String, required: true },
  price: { type: Number, required: true },
  quantity: { type: Number, required: true, min: 1, default: 1 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

const cartSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  items: [cartItemSchema],
  updatedAt: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now },
});

cartSchema.index({ userId: 1, 'items.productId': 1 }, { unique: true });

module.exports = mongoose.model('Cart', cartSchema);
