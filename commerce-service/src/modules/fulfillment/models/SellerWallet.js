const mongoose = require('mongoose');

/**
 * SELLER WALLET SCHEMA
 * 
 * Tracks seller financial balances:
 * - availableBalance: Ready for payout (settled, not held)
 * - pendingBalance: Awaiting settlement or release conditions
 * - totalEarned: Cumulative earnings (reference only)
 * - totalCommissionDeducted: Cumulative commission (reference only)
 * 
 * Rules:
 * 1. One wallet per seller (tied to sellerId)
 * 2. Balances updated ONLY by backend services (never direct seller updates)
 * 3. All updates tracked in WalletTransaction ledger
 * 4. Immutable history - no deletion of wallet records
 * 5. Timezone-independent UTC timestamps
 * 
 * NOT a payment instrument - seller cannot transfer funds directly
 * Sellers request payouts, admin processes settlements
 */

const SellerWalletSchema = new mongoose.Schema(
  {
    // Identity
    sellerId: {
      type: String,
      required: true,
      unique: true,
      index: true,
      description: 'Reference to seller user account'
    },

    // Balances (in lowest currency unit: cents for ETB, etc.)
    availableBalance: {
      type: Number,
      default: 0,
      min: 0,
      description: 'Ready for payout - no holds or pending conditions'
    },

    pendingBalance: {
      type: Number,
      default: 0,
      min: 0,
      description: 'Awaiting settlement window, refund window, or other release condition'
    },

    // Cumulative reference (recalculated from ledger for verification)
    totalEarned: {
      type: Number,
      default: 0,
      min: 0,
      description: 'Total gross earnings from order allocations'
    },

    totalCommissionDeducted: {
      type: Number,
      default: 0,
      min: 0,
      description: 'Total platform commission charged'
    },

    totalRefunded: {
      type: Number,
      default: 0,
      min: 0,
      description: 'Total amount refunded to buyers (reduces seller earnings)'
    },

    totalAdjusted: {
      type: Number,
      default: 0,
      description: 'Total manual adjustments (positive or negative)'
    },

    totalPaidOut: {
      type: Number,
      default: 0,
      min: 0,
      description: 'Total amount paid to seller account'
    },

    // Wallet metadata
    currency: {
      type: String,
      default: 'ETB',
      enum: ['ETB', 'USD'],
      description: 'Wallet currency (must match seller/platform preference)'
    },

    status: {
      type: String,
      enum: ['ACTIVE', 'SUSPENDED', 'CLOSED'],
      default: 'ACTIVE',
      description: 'Wallet operational status'
    },

    // Last activity tracking
    lastTransactionAt: {
      type: Date,
      default: null,
      description: 'Timestamp of last wallet transaction'
    },

    lastSettlementAt: {
      type: Date,
      default: null,
      description: 'Timestamp of last pending→available transfer'
    },

    lastPayoutAt: {
      type: Date,
      default: null,
      description: 'Timestamp of last payout request processed'
    },

    // Metadata
    notes: {
      type: String,
      default: '',
      description: 'Admin notes (suspension reason, special terms, etc.)'
    },

    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
      description: 'Extensible metadata (provider account info, etc.)'
    },
  },
  {
    timestamps: true,
    collection: 'seller_wallets',
    strict: true,
    description: 'Seller wallet balances and history reference'
  }
);

// Index for queries
SellerWalletSchema.index({ sellerId: 1, status: 1 });
SellerWalletSchema.index({ createdAt: -1 });
SellerWalletSchema.index({ updatedAt: -1 });

// Virtual: calculate current net balance
SellerWalletSchema.virtual('totalBalance').get(function() {
  return this.availableBalance + this.pendingBalance;
});

// Prevent direct balance modification (enforce through service only)
SellerWalletSchema.pre('save', function(next) {
  // If new doc but balances are set directly (not through ledger), error
  if (this.isNew && (this.availableBalance > 0 || this.pendingBalance > 0)) {
    return next(new Error('Wallet balances must be updated through WalletTransaction ledger, not directly'));
  }
  next();
});

module.exports = mongoose.model('SellerWallet', SellerWalletSchema);
