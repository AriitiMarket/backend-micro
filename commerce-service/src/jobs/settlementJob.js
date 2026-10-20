/**
 * SETTLEMENT JOB - PENDING TO AVAILABLE RELEASE
 *
 * Run this job daily (cron) or event-driven after settlement window (7 days)
 *
 * Location: backend-services/commerce-service/src/jobs/settlementJob.js
 */

const walletsService = require('../modules/fulfillment/services/wallets.service');
const walletsRepository = require('../modules/fulfillment/repositories/wallets.repository');
const logger = require('../shared/logger');

const SETTLEMENT_WINDOW_DAYS = 7; // From platform settings

class SettlementJob {
  async run() {
    try {
      logger.info('Starting settlement job...');

      const now = new Date();
      const settlementCutoff = new Date(now.getTime() - SETTLEMENT_WINDOW_DAYS * 24 * 60 * 60 * 1000);

      // Find all wallets with pending balance
      const wallets = await walletsRepository.getAllWallets(
        { pendingBalance: { $gt: 0 } },
        { limit: 1000 }
      );

      let processedCount = 0;
      let failedCount = 0;

      for (const wallet of wallets) {
        try {
          // Find oldest transaction for this wallet
          const oldestTransaction = await walletsRepository.getTransactionHistory(wallet.sellerId, {
            limit: 1,
            offset: 0
          });

          if (!oldestTransaction || oldestTransaction.length === 0) {
            continue;
          }

          const transactionAge = new Date(oldestTransaction[0].transactionAt);

          // Only release if settlement window has passed:
          // transaction must be OLDER than the cutoff (i.e., beyond the window)
          if (transactionAge < settlementCutoff) {
            continue;
          }

          // Release pending balance
          await walletsService.releasePendingBalance(
            wallet._id,
            wallet.pendingBalance,
            {
              actor: null,
              actorType: 'SYSTEM',
              reason: `Settlement window (${SETTLEMENT_WINDOW_DAYS} days) complete`
            }
          );

          logger.info(
            `Released pending balance for seller ${wallet.sellerId}: +${wallet.pendingBalance}`
          );
          processedCount++;
        } catch (err) {
          logger.error(
            `Failed to release pending balance for seller ${wallet.sellerId}:`,
            err
          );
          failedCount++;
        }
      }

      logger.info(
        `Settlement job completed. Processed: ${processedCount}, Failed: ${failedCount}`
      );

      return {
        success: true,
        processedCount,
        failedCount,
        timestamp: new Date().toISOString()
      };
    } catch (err) {
      logger.error('Settlement job error:', err);
      throw err;
    }
  }
}

module.exports = new SettlementJob();

/**
 * REGISTER IN CRON JOB SCHEDULER
 *
 * In your cron scheduler (e.g., node-cron or Bull):
 *
 *   const settlementJob = require('./jobs/settlementJob');
 *
 *   // Run daily at 2 AM
 *   cron.schedule('0 2 * * *', async () => {
 *     try {
 *       await settlementJob.run();
 *     } catch (err) {
 *       console.error('Settlement job failed:', err);
 *     }
 *   });
 */