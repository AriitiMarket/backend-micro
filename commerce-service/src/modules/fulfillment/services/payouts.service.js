const mongoose = require('mongoose');
const payoutsRepository = require('../repositories/payouts.repository');
const walletsRepository = require('../repositories/wallets.repository');
const settingsService = require('../../platform/services/settings.service');

class ApiError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
  }
}

/**
 * PAYOUT SERVICE
 *
 * Manages seller payout requests from submission through completion.
 *
 * Rules:
 * 1. Only sellers can request payouts
 * 2. Payout amount must not exceed available balance
 * 3. Minimum payout amount enforced (from platform settings)
 * 4. Admin must approve before processing
 * 5. Payout details must be verified
 * 6. Failed payouts return funds to available balance
 * 7. Processing fee from platform settings (not hardcoded)
 */
class PayoutService {
  constructor() {
    this.MIN_PAYOUT = 500; // ETB — overridden by settings at runtime
    this.PROCESSING_FEE_PERCENT = 1; // 1% fee — overridden by settings at runtime
  }

  /**
   * Load min payout and fee from platform settings.
   * Called at the start of each payout operation to ensure admin-customized values are used.
   */
  async loadSettings() {
    try {
      const settings = await settingsService.getPlatformSettings();
      this.MIN_PAYOUT = Number(settings.minPayoutAmount) || 500;
      this.PROCESSING_FEE_PERCENT = Number(settings.payoutProcessingFeePercent) || 1;
    } catch (err) {
      // Keep defaults if settings unavailable
      console.error('[PayoutService] Failed to load payout settings:', err.message);
    }
  }

  /**
   * Request payout (seller action)
   * @param {string} sellerId
   * @param {number} amount
   * @param {string} payoutMethod
   * @param {Object} payoutDetails
   * @returns {Promise<Object>}
   */
  async requestPayout(sellerId, amount, payoutMethod, payoutDetails) {
    await this.loadSettings();

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      if (!sellerId) throw new ApiError('Seller ID required', 400);

      amount = Number(amount || 0);
      if (amount <= 0) throw new ApiError('Amount must be positive', 400);
      if (amount < this.MIN_PAYOUT) {
        throw new ApiError(`Minimum payout amount is ${this.MIN_PAYOUT} ETB`, 400);
      }

      if (!payoutMethod || !['BANK_TRANSFER', 'MOBILE_MONEY', 'WALLET', 'CHECK'].includes(payoutMethod)) {
        throw new ApiError('Invalid payout method', 400);
      }

      // Get seller wallet
      const wallet = await walletsRepository.getWalletBySellerId(sellerId);
      if (!wallet) throw new ApiError('Wallet not found', 404);

      // Check available balance
      if (amount > wallet.availableBalance) {
        throw new ApiError('Insufficient available balance for payout', 400);
      }

      // Calculate processing fee
      const processingFee = Math.ceil(amount * (this.PROCESSING_FEE_PERCENT / 100));
      const netPayoutAmount = amount - processingFee;

      // Create payout request
      const payoutRequest = await payoutsRepository.create({
        sellerId: sellerId,
        walletId: wallet._id,
        amount,
        currency: wallet.currency || 'ETB',
        status: 'PENDING',
        payoutMethod,
        payoutDetails: payoutDetails || {},
        processingFee,
        netPayoutAmount,
        isVerified: false
      });

      // Deduct from available balance immediately (PENDING state)
      await walletsRepository.updateWalletBalances(wallet._id, {
        availableBalance: wallet.availableBalance - amount
      });

      // Log transaction
      await walletsRepository.createTransaction({
        sellerId: sellerId,
        walletId: wallet._id,
        transactionType: 'PAYOUT_REQUESTED',
        amount: amount,
        currency: wallet.currency || 'ETB',
        direction: 'DEBIT',
        status: 'PENDING',
        balanceBeforeTransaction: wallet.availableBalance,
        balanceAfterTransaction: wallet.availableBalance - amount,
        payoutRequestId: payoutRequest._id,
        reason: `Payout request via ${payoutMethod}`,
        actorType: 'SELLER',
        transactionAt: new Date()
      });

      await session.commitTransaction();

      return {
        payoutRequest,
        deductedAmount: amount,
        processingFee,
        netPayoutAmount,
        remainingBalance: wallet.availableBalance - amount
      };
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      await session.endSession();
    }
  }

  /**
   * Get seller's payout requests
   */
  async getSellerPayouts(sellerId, options = {}) {
    if (!sellerId) throw new ApiError('Seller ID required', 400);

    const { limit = 50, offset = 0, status } = options;

    return payoutsRepository.findBySellerId(sellerId, {
      limit: Math.min(Math.max(1, limit), 100),
      offset: Math.max(0, offset),
      status
    });
  }

  /**
   * Get payout by ID (with seller verification)
   */
  async getPayout(payoutId, sellerId) {
    if (!payoutId) throw new ApiError('Payout ID required', 400);

    const payout = await payoutsRepository.findById(payoutId);
    if (!payout) throw new ApiError('Payout not found', 404);

    // Verify seller owns this payout
    if (sellerId && String(payout.sellerId) !== String(sellerId)) {
      throw new ApiError('You do not have access to this payout', 403);
    }

    return payout;
  }

  /**
   * ADMIN: Approve payout request
   */
  async approvePayout(payoutId, approvedBy, notes = '') {
    if (!approvedBy) throw new ApiError('Admin ID required', 400);

    const payout = await payoutsRepository.findById(payoutId);
    if (!payout) throw new ApiError('Payout not found', 404);

    if (payout.status !== 'PENDING') {
      throw new ApiError(`Cannot approve payout with status: ${payout.status}`, 400);
    }

    return payoutsRepository.approve(payoutId, approvedBy, notes);
  }

  /**
   * ADMIN: Reject payout request
   */
  async rejectPayout(payoutId, rejectionReason, rejectedBy) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      if (!rejectionReason) throw new ApiError('Rejection reason required', 400);
      if (!rejectedBy) throw new ApiError('Admin ID required', 400);

      const payout = await payoutsRepository.findById(payoutId);
      if (!payout) throw new ApiError('Payout not found', 404);

      if (payout.status !== 'PENDING') {
        throw new ApiError(`Cannot reject payout with status: ${payout.status}`, 400);
      }

      // Return deducted amount back to available balance
      const wallet = await walletsRepository.getWalletById(payout.walletId);
      if (wallet) {
        await walletsRepository.updateWalletBalances(payout.walletId, {
          availableBalance: wallet.availableBalance + payout.amount
        });

        // Log transaction reversal
        await walletsRepository.createTransaction({
          sellerId: payout.sellerId,
          walletId: payout.walletId,
          transactionType: 'PAYOUT_FAILED',
          amount: payout.amount,
          currency: payout.currency,
          direction: 'CREDIT',
          status: 'COMPLETED',
          balanceBeforeTransaction: wallet.availableBalance,
          balanceAfterTransaction: wallet.availableBalance + payout.amount,
          payoutRequestId: payoutId,
          reason: `Payout rejected: ${rejectionReason}`,
          // WalletTransaction.actor is a String (the identity service issues
          // string user ids). This used to call `mongoose.Types.ObjectId(...)`
          // WITHOUT `new`, which throws "Class constructor ObjectId cannot be
          // invoked without 'new'" in Mongoose 8 — so every payout rejection
          // blew up AFTER the funds had already been returned to the wallet.
          actor: rejectedBy,
          actorType: 'ADMIN',
          transactionAt: new Date()
        });
      }

      // Update payout status
      const updated = await payoutsRepository.reject(payoutId, rejectionReason, rejectedBy);

      await session.commitTransaction();

      return {
        payout: updated,
        refundedAmount: payout.amount,
        reason: rejectionReason
      };
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      await session.endSession();
    }
  }

  /**
   * ADMIN: Complete payout (successful payment)
   */
  async completePayout(payoutId, transactionId, providerResponse, processedBy) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      if (!transactionId) throw new ApiError('Transaction ID required', 400);
      if (!processedBy) throw new ApiError('Admin ID required', 400);

      const payout = await payoutsRepository.findById(payoutId);
      if (!payout) throw new ApiError('Payout not found', 404);

      if (payout.status !== 'APPROVED' && payout.status !== 'PROCESSING') {
        throw new ApiError(`Cannot complete payout with status: ${payout.status}`, 400);
      }

      // Update payout
      const updated = await payoutsRepository.complete(
        payoutId,
        transactionId,
        providerResponse,
        processedBy
      );

      // Update wallet with payout completed
      const wallet = await walletsRepository.getWalletById(payout.walletId);
      if (wallet) {
        await walletsRepository.updateWalletBalances(payout.walletId, {
          totalPaidOut: wallet.totalPaidOut + payout.netPayoutAmount,
          lastPayoutAt: new Date()
        });

        // Log transaction
        await walletsRepository.createTransaction({
          sellerId: payout.sellerId,
          walletId: payout.walletId,
          transactionType: 'PAYOUT_COMPLETED',
          amount: payout.netPayoutAmount,
          currency: payout.currency,
          direction: 'DEBIT',
          status: 'COMPLETED',
          payoutRequestId: payoutId,
          reason: `Payout completed via ${payout.payoutMethod}`,
          actor: processedBy,
          actorType: 'ADMIN',
          metadata: { transactionId, fee: payout.processingFee },
          transactionAt: new Date()
        });
      }

      await session.commitTransaction();

      return updated;
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      await session.endSession();
    }
  }

  /**
   * ADMIN: Mark payout as failed (payment provider failed)
   */
  async failPayout(payoutId, failureReason, transactionId, providerResponse, processedBy) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      if (!failureReason) throw new ApiError('Failure reason required', 400);

      const payout = await payoutsRepository.findById(payoutId);
      if (!payout) throw new ApiError('Payout not found', 404);

      // Return deducted amount back to available balance
      const wallet = await walletsRepository.getWalletById(payout.walletId);
      if (wallet) {
        await walletsRepository.updateWalletBalances(payout.walletId, {
          availableBalance: wallet.availableBalance + payout.amount
        });

        // Log transaction reversal
        await walletsRepository.createTransaction({
          sellerId: payout.sellerId,
          walletId: payout.walletId,
          transactionType: 'PAYOUT_FAILED',
          amount: payout.amount,
          currency: payout.currency,
          direction: 'CREDIT',
          status: 'COMPLETED',
          balanceBeforeTransaction: wallet.availableBalance,
          balanceAfterTransaction: wallet.availableBalance + payout.amount,
          payoutRequestId: payoutId,
          reason: `Payout failed: ${failureReason}`,
          actor: processedBy ? processedBy : undefined,
          actorType: 'ADMIN',
          metadata: { transactionId, providerResponse },
          transactionAt: new Date()
        });
      }

      // Mark payout as failed
      const updated = await payoutsRepository.fail(
        payoutId,
        failureReason,
        transactionId,
        providerResponse
      );

      await session.commitTransaction();

      return {
        payout: updated,
        refundedAmount: payout.amount,
        reason: failureReason
      };
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      await session.endSession();
    }
  }

  /**
   * ADMIN: Retry a failed payout
   * Increments retryCount and schedules next attempt with backoff
   */
  async retryPayout(payoutId, processedBy) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      if (!processedBy) throw new ApiError('Admin ID required', 400);

      const payout = await payoutsRepository.findById(payoutId);
      if (!payout) throw new ApiError('Payout not found', 404);

      if (payout.status !== 'FAILED') {
        throw new ApiError(`Cannot retry payout with status: ${payout.status}`, 400);
      }

      const retryCount = Number(payout.retryCount || 0) + 1;
      const maxRetries = 3;
      const backoffMinutes = Math.pow(2, retryCount) * 15; // 30min, 60min, 120min

      if (retryCount > maxRetries) {
        throw new ApiError(`Payout has exceeded maximum retry attempts (${maxRetries})`, 400);
      }

      const nextRetryAt = new Date(Date.now() + backoffMinutes * 60 * 1000);

      // Return funds to available balance first (they were deducted on request)
      const wallet = await walletsRepository.getWalletById(payout.walletId);
      if (wallet) {
        await walletsRepository.updateWalletBalances(payout.walletId, {
          availableBalance: wallet.availableBalance + payout.amount
        });

        await walletsRepository.createTransaction({
          sellerId: payout.sellerId,
          walletId: payout.walletId,
          transactionType: 'PAYOUT_RETRY',
          amount: payout.amount,
          currency: payout.currency,
          direction: 'DEBIT',
          status: 'PENDING',
          balanceBeforeTransaction: wallet.availableBalance,
          balanceAfterTransaction: wallet.availableBalance - payout.amount,
          payoutRequestId: payoutId,
          reason: `Payout retry attempt ${retryCount}`,
          actor: processedBy,
          actorType: 'ADMIN',
          metadata: { retryCount, nextRetryAt },
          transactionAt: new Date()
        });
      }

      const updated = await payoutsRepository.retry(
        payoutId,
        retryCount,
        nextRetryAt,
        processedBy
      );

      await session.commitTransaction();

      return {
        payout: updated,
        retryCount,
        nextRetryAt,
      };
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      await session.endSession();
    }
  }

  /**
   * ADMIN: Get pending payouts
   */
  async getPendingPayouts(options = {}) {
    return payoutsRepository.findPending(options);
  }

  /**
   * ADMIN: Get all payouts with filtering
   */
  async getAllPayouts(filters = {}, options = {}) {
    return payoutsRepository.findAll(filters, options);
  }

  /**
   * ADMIN: Get seller payout statistics
   */
  async getSellerPayoutStats(sellerId) {
    if (!sellerId) throw new ApiError('Seller ID required', 400);
    return payoutsRepository.getStatistics(sellerId);
  }

  /**
   * ADMIN: Get platform payout statistics
   */
  async getPlatformPayoutStats() {
    return payoutsRepository.getPlatformStatistics();
  }

  /**
   * ADMIN: Export payout data
   * @param {Object} options - { status, startDate, endDate, format }
   * @returns {Promise<string|Array>}
   */
  async exportPayoutData(options = {}) {
    const { status, startDate, endDate, format = 'csv' } = options;

    const payouts = await payoutsRepository.findAll(
      { status, startDate, endDate },
      { limit: 10000 }
    );

    if (format === 'csv') {
      const headers = ['Payout ID', 'Seller ID', 'Amount', 'Status', 'Payout Method', 'Processing Fee', 'Net Amount', 'Requested At', 'Approved At', 'Processed At', 'Transaction ID'];
      const rows = payouts.map(p => [
        p._id,
        p.sellerId,
        p.amount,
        p.status,
        p.payoutMethod,
        p.processingFee,
        p.netPayoutAmount,
        p.createdAt ? new Date(p.createdAt).toISOString() : '',
        p.approvedAt ? new Date(p.approvedAt).toISOString() : '',
        p.processedAt ? new Date(p.processedAt).toISOString() : '',
        p.transactionId || ''
      ]);

      const csv = [headers.join(','), ...rows.map(r => r.map(v => `"${v}"`).join(','))].join('\n');
      return csv;
    }

    return payouts;
  }
}

module.exports = new PayoutService();
