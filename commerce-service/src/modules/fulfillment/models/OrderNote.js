/**
 * ORDER NOTE MODEL
 * Buyer-seller messaging within order context
 * Reuses pattern from Orders.js
 */

const mongoose = require('mongoose');

const orderNoteSchema = new mongoose.Schema({
  // Foreign keys
  orderId: { type: String, required: true, index: true },
  userId: { type: String, required: true, index: true },
  
  // Metadata
  userRole: { type: String, enum: ['BUYER', 'SELLER'], required: true },
  message: { type: String, required: true, maxlength: 2000 },
  
  // Status
  isPinned: { type: Boolean, default: false },
  isInternal: { type: Boolean, default: false }, // Only visible to seller
  deletedAt: { type: Date, default: null },
  
  // Timestamps
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
}, {
  timestamps: true,
  collection: 'order_notes',
});

// Indexes for common queries
orderNoteSchema.index({ orderId: 1, createdAt: -1 });
orderNoteSchema.index({ userId: 1, createdAt: -1 });
orderNoteSchema.index({ isPinned: -1, createdAt: -1 });

module.exports = mongoose.model('OrderNote', orderNoteSchema);
