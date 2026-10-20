const mongoose = require('mongoose');

/**
 * WALLET TRANSACTION LEDGER
 * 
 * Immutable append-only ledger tracking every wallet balance change.
 * 
 * Transaction Types:
 * - ORDER_ALLOCATION: Seller earned from order payment confirmation
 * - COMMISSION_DEDUCTED: Platform commission charged
 * - PENDING_RELEASE: Pending balance moved to available (settlement window ended)
 * - REFUND_CREDITED: Refund to buyer (reduces seller earnings)
 * - ADJUSTMENT: Manual admin correction (could be positive or negative)
 * - PAYOUT_REQUESTED: Seller withdrawal request submitted
 * - PAYOUT_COMPLETED: Payout processed and paid
 * - PAYOUT_FAILED: Payout failed, funds returned to available
 * 
 * Design:
 * 1. APPEND-ONLY: No updates, no deletes. Only inserts.
 * 2. Immutable: createdAt is generated once, never changed.
 * 3. Full history: All transactions preserved for audit.
 * 4. References: Link to order, allocation, payment for traceability.
 * 5. Balance snapshot: Store balance after transaction for verification.
 */

const WalletTransactionSchema = new mongoose.Schema(
  {
    // Identity
    sellerId: {
      type: String,
      required: true,
      index: true,
      description: 'Seller account ID'
    },

    walletId: {
      type: String,
      required: false,
      description: 'Reference to SellerWallet (for fast lookups)'
    },

    // Transaction details
    transactionType: {
      type: String,
      enum: [
        'ORDER_ALLOCATION',
        'COMMISSION_DEDUCTED',
        'PENDING_RELEASE',
        'REFUND_CREDITED',
        'ADJUSTMENT',
        'PAYOUT_REQUESTED',
        'PAYOUT_COMPLETED',
        'PAYOUT_FAILED',
      ],
      required: true,
      index: true,
      description: 'Type of wallet transaction'
    },

    // Amount and status
    amount: {
      type: Number,
      required: true,
      description: 'Transaction amount (always positive, direction in type)'
    },

    currency: {
      type: String,
      default: 'ETB',
      enum: ['ETB', 'USD'],
      description: 'Transaction currency'
    },

    direction: {
      type: String,
      enum: ['CREDIT', 'DEBIT'],
      required: true,
      description: 'CREDIT: added to balance, DEBIT: subtracted'
    },

    status: {
      type: String,
      enum: ['PENDING', 'COMPLETED', 'FAILED', 'REVERSED'],
      default: 'COMPLETED',
      description: 'Transaction status (mostly completed, unless awaiting)'
    },

    // Balance snapshot (for audit)
    balanceBeforeTransaction: {
      type: Number,
      required: false,
      description: 'Available balance before this transaction'
    },

    balanceAfterTransaction: {
      type: Number,
      required: false,
      description: 'Available balance after this transaction'
    },

    pendingBeforeTransaction: {
      type: Number,
      required: false,
      description: 'Pending balance before this transaction'
    },

    pendingAfterTransaction: {
      type: Number,
      required: false,
      description: 'Pending balance after this transaction'
    },

    // References for traceability
    orderId: {
      type: String,
      required: false,
      description: 'Associated order (for ORDER_ALLOCATION, REFUND_CREDITED)'
    },

    allocationId: {
      type: String,
      required: false,
      description: 'Associated seller allocation'
    },

    paymentId: {
      type: String,
      required: false,
      description: 'Associated payment (if payment-related)'
    },

    payoutRequestId: {
      type: String,
      required: false,
      description: 'Associated payout request'
    },

    // Context
    reason: {
      type: String,
      required: false,
      description: 'Human-readable reason for transaction'
    },

    actor: {
      type: String,
      required: false,
      description: 'Admin or system user who initiated transaction'
    },

    actorType: {
      type: String,
      enum: ['SYSTEM', 'ADMIN', 'SELLER'],
      default: 'SYSTEM',
      description: 'Who initiated the transaction'
    },

    // Metadata for extensibility
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
      description: 'Additional context (provider reference, etc.)'
    },

    // Immutable timestamp (set once at creation)
    transactionAt: {
      type: Date,
      required: true,
      default: () => new Date(),
      description: 'When transaction occurred (immutable)'
    },
  },
  {
    timestamps: false,  // Don't use auto timestamps - we use transactionAt only
    collection: 'wallet_transactions',
    strict: true,
    description: 'Immutable append-only wallet transaction ledger'
  }
);

// Indexes
WalletTransactionSchema.index({ sellerId: 1, transactionAt: -1 });
WalletTransactionSchema.index({ walletId: 1, transactionAt: -1 });
WalletTransactionSchema.index({ orderId: 1, transactionAt: -1 });
WalletTransactionSchema.index({ transactionType: 1, transactionAt: -1 });
WalletTransactionSchema.index({ status: 1, transactionAt: -1 });
WalletTransactionSchema.index({ transactionAt: -1 });

// Prevent modification (append-only)
WalletTransactionSchema.pre('findOneAndUpdate', function(next) {
  return next(new Error('Wallet transactions are immutable - cannot update'));
});

WalletTransactionSchema.pre('updateOne', function(next) {
  return next(new Error('Wallet transactions are immutable - cannot update'));
});

WalletTransactionSchema.pre('updateMany', function(next) {
  return next(new Error('Wallet transactions are immutable - cannot update'));
});

module.exports = mongoose.model('WalletTransaction', WalletTransactionSchema);
