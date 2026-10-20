const mongoose = require('mongoose');

/**
 * PAYMENT METHOD CATALOGUE (platform settlement rails)
 *
 * One row per settlement rail the platform offers, e.g. Cash on Delivery,
 * Bank Transfer, Telebirr, CBE Birr. This is the catalogue the rest of the
 * payment stack already speaks:
 *
 *   * `payments.service.js` — listMethods()/saveMethod() read and write exactly
 *     these fields, and seed the four default rails here;
 *   * `POST /payment/create-payment` accepts a rail key as `paymentMethod`;
 *   * `GET /payment/get-active-methods` returns the ACTIVE rows a buyer may
 *     pick at checkout;
 *   * `POST /payment/seller/:sellerId/payment-accounts` links a seller's
 *     payout account to one of these rails (it requires `status === 'ACTIVE'`);
 *   * the admin console (Aritii-admin-web) edits these rows through
 *     `/payment/admin/methods`, and the buyer checkout screen
 *     (customer-frontend/src/buyer/components/Payment.jsx) filters them by
 *     `availableFor` and `key`.
 *
 * HISTORY / DEFECT FIX: this file used to hold a per-USER saved-instrument
 * schema (`userId` + `methodType` + card/wallet/bank sub-documents). That
 * schema cannot express a platform rail, so every catalogue query failed:
 * `PaymentMethod.updateOne({ key: ... }, ..., { upsert: true })` threw
 * "Path \"key\" is not in schema, strict mode is true, and upsert is true",
 * which made GET /payment/get-active-methods and GET /payment/admin/methods
 * return 500 and made it impossible for a seller to create a payout account
 * (createSellerAccount looks for an ACTIVE method and found none).
 * The per-user service that used the old shape
 * (services/paymentMethods.service.js) had no callers and was removed.
 *
 * Provider secrets are never stored in this collection: a rail only records
 * whether it is CONFIGURED, plus non-sensitive fee/limit metadata. Actual
 * credentials live in the provider's own environment.
 */
const paymentMethodSchema = new mongoose.Schema({
  // Stable machine key, e.g. 'COD', 'TELEBIRR'. Unique across the catalogue.
  key: { type: String, required: true, unique: true, index: true },

  // Adapter key the provider adapter is selected by, e.g. 'telebirr'.
  providerKey: { type: String, required: true, index: true },

  // Human label shown in the checkout / admin console.
  name: { type: String, required: true },
  description: { type: String, default: '' },

  // Rail family: OFFLINE (pay on delivery), BANK, WALLET, GATEWAY, CARD.
  type: {
    type: String,
    enum: ['OFFLINE', 'BANK', 'WALLET', 'GATEWAY', 'CARD'],
    default: 'OFFLINE',
  },

  // Which actors may use this rail: 'BUYERS' and/or 'SELLERS'.
  availableFor: { type: [String], default: ['BUYERS'] },

  // Which transaction kinds the rail settles: 'PAYMENT' and/or 'PAYOUT'.
  supportedTransactionTypes: { type: [String], default: ['PAYMENT'] },

  currency: { type: String, default: 'ETB' },

  // Limits and fees (non-sensitive configuration only).
  minAmount: { type: Number, default: 0 },
  maxAmount: { type: Number, default: null },
  fixedFee: { type: Number, default: 0 },
  percentageFee: { type: Number, default: 0 },

  // Display order in checkout (lower numbers appear first).
  sortOrder: { type: Number, default: 0 },

  processingSettings: { type: Object, default: {} },
  verificationRequired: { type: Boolean, default: false },
  settlementSettings: { type: Object, default: {} },

  status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'INACTIVE' },

  // True once the provider credentials/adapter for this rail are in place.
  // A rail may not be ACTIVE while unconfigured (see payments.service.js).
  configured: { type: Boolean, default: false },
}, { timestamps: true });

module.exports = mongoose.model('PaymentMethod', paymentMethodSchema);
