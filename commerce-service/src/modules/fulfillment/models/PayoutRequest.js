const mongoose = require('mongoose');

/**
 * PAYOUT REQUEST SCHEMA
 * 
 * Seller withdrawal requests tracked from submission through processing.
 * 
 * States:
 * - PENDING: Submitted, awaiting admin review
 * - APPROVED: Admin approved, ready to process
 * - PROCESSING: Payment in progress
 * - COMPLETED: Successfully paid to seller account
 * - FAILED: Payment failed, funds returned to available balance
 * - CANCELLED: Seller or admin cancelled request
 * - REJECTED: Admin rejected request
 */

const PayoutRequestSchema = new mongoose.Schema(
  {
    // Identity
    sellerId: {
      type: String,
      required: true,
      index: true,
      description: 'Seller requesting payout'
    },

    walletId: {
      type: String,
      required: true,
      description: 'Wallet being paid out'
    },

    // Request Details
    amount: {
      type: Number,
      required: true,
      min: 0,
      description: 'Amount requested for payout'
    },

    currency: {
      type: String,
      default: 'ETB',
      enum: ['ETB', 'USD'],
      description: 'Payout currency'
    },

    status: {
      type: String,
      enum: ['PENDING', 'APPROVED', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED', 'REJECTED'],
      default: 'PENDING',
      index: true,
      description: 'Payout request status'
    },

    // Payout Method
    payoutMethod: {
      type: String,
      enum: ['BANK_TRANSFER', 'MOBILE_MONEY', 'WALLET', 'CHECK'],
      required: true,
      description: 'How seller wants to receive funds'
    },

    payoutDetails: {
      type: mongoose.Schema.Types.Mixed,
      description: 'Method-specific details (account number, phone, etc.)'
    },

    // Verification
    isVerified: {
      type: Boolean,
      default: false,
      description: 'Whether payout details have been verified'
    },

    verificationNotes: {
      type: String,
      description: 'Admin notes on verification'
    },

    // Processing
    processedBy: {
      type: String,
      description: 'Admin who processed the payout (identity-service user id)'
    },

    processedAt: {
      type: Date,
      description: 'When payout was processed'
    },

    transactionId: {
      type: String,
      description: 'Payment provider transaction ID'
    },

    providerResponse: {
      type: mongoose.Schema.Types.Mixed,
      description: 'Response from payment provider'
    },

    // Admin Actions
    approvedBy: {
      type: String,
      description: 'Admin who approved request (identity-service user id)'
    },

    approvedAt: {
      type: Date,
      description: 'When request was approved'
    },

    // Retry tracking
    retryCount: {
      type: Number,
      default: 0,
      description: 'Number of retry attempts for failed payouts'
    },

    nextRetryAt: {
      type: Date,
      description: 'Scheduled time for next retry attempt'
    },

    rejectionReason: {
      type: String,
      description: 'Why request was rejected'
    },

    cancellationReason: {
      type: String,
      description: 'Why request was cancelled'
    },

    // Metadata
    notes: {
      type: String,
      description: 'Additional notes'
    },

    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
      description: 'Extensible metadata'
    },

    // Fees
    processingFee: {
      type: Number,
      default: 0,
      description: 'Fee deducted from payout'
    },

    netPayoutAmount: {
      type: Number,
      description: 'Amount actually paid (amount - fee)'
    },
  },
  {
    timestamps: true,
    collection: 'payout_requests',
    strict: true,
    description: 'Seller payout request workflow'
  }
);

// Indexes
PayoutRequestSchema.index({ sellerId: 1, status: 1 });
PayoutRequestSchema.index({ walletId: 1, createdAt: -1 });
PayoutRequestSchema.index({ status: 1, createdAt: -1 });
PayoutRequestSchema.index({ createdAt: -1 });
PayoutRequestSchema.index({ nextRetryAt: 1, status: 1 });

module.exports = mongoose.model('PayoutRequest', PayoutRequestSchema);
