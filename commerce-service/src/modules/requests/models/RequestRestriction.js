const mongoose = require('mongoose');

/**
 * Platform restriction on the product-request surface.
 *
 * Identity owns accounts; this owns "this account may not open (or receive)
 * product requests, and why". Enforced inside the request service — the UI
 * never decides — so a restricted user cannot bypass it with a direct call.
 */
const requestRestrictionSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  /** Which side of a request is restricted. */
  scope: { type: String, enum: ['BUYER', 'SELLER', 'BOTH'], default: 'BUYER' },
  kind: { type: String, enum: ['TEMPORARY', 'PERMANENT'], default: 'PERMANENT' },
  /** TEMPORARY restrictions lift themselves at this moment (null = n/a). */
  until: { type: Date, default: null },
  reason: { type: String, required: true, maxlength: 500 },
  status: { type: String, enum: ['ACTIVE', 'LIFTED'], default: 'ACTIVE', index: true },
  createdBy: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
  liftedBy: { type: String, default: null },
  liftedAt: { type: Date, default: null },
  liftReason: { type: String, default: '', maxlength: 500 },
}, { timestamps: true });

requestRestrictionSchema.index({ userId: 1, status: 1 });

module.exports = mongoose.model('RequestRestriction', requestRestrictionSchema);
