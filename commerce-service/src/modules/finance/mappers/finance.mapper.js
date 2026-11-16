'use strict';

/**
 * Finance Response DTO Mapper
 * Strips sensitive financial credentials, provider internal raw payload secrets, and __v.
 */

function toPayoutResponse(payout) {
  if (!payout) return null;
  const doc = typeof payout.toObject === 'function' ? payout.toObject() : { ...payout };

  delete doc.__v;

  return {
    id: doc._id || doc.id,
    sellerId: doc.sellerId,
    walletId: doc.walletId,
    amount: doc.amount,
    currency: doc.currency || 'ETB',
    status: doc.status,
    payoutMethod: doc.payoutMethod,
    payoutDetails: doc.payoutDetails || {},
    processingFee: doc.processingFee || 0,
    netPayoutAmount: doc.netPayoutAmount || doc.amount,
    isVerified: Boolean(doc.isVerified),
    requestedAt: doc.createdAt,
    approvedAt: doc.approvedAt,
    approvedBy: doc.approvedBy,
    processedAt: doc.processedAt,
    processedBy: doc.processedBy,
    transactionId: doc.transactionId,
    rejectionReason: doc.rejectionReason,
    cancellationReason: doc.cancellationReason,
  };
}

function toPayoutListResponse(payouts) {
  if (!Array.isArray(payouts)) return [];
  return payouts.map(toPayoutResponse).filter(Boolean);
}

function toWalletResponse(wallet) {
  if (!wallet) return null;
  const doc = typeof wallet.toObject === 'function' ? wallet.toObject() : { ...wallet };

  delete doc.__v;

  return {
    id: doc._id || doc.id,
    sellerId: doc.sellerId,
    availableBalance: doc.availableBalance || 0,
    pendingBalance: doc.pendingBalance || 0,
    totalEarned: doc.totalEarned || 0,
    totalCommissionDeducted: doc.totalCommissionDeducted || 0,
    totalRefunded: doc.totalRefunded || 0,
    totalPaidOut: doc.totalPaidOut || 0,
    currency: doc.currency || 'ETB',
    status: doc.status,
    lastPayoutAt: doc.lastPayoutAt,
    updatedAt: doc.updatedAt,
  };
}

module.exports = {
  toPayoutResponse,
  toPayoutListResponse,
  toWalletResponse,
};
