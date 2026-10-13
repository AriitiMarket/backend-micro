/**
 * MongoDB transaction helpers
 */

class TransactionHelper {
  /**
   * Execute operations in a transaction
   */
  static async withTransaction(session, operations) {
    try {
      await session.withTransaction(async () => {
        for (const operation of operations) {
          await operation(session);
        }
      });
    } catch (error) {
      console.error('Transaction failed:', error);
      throw error;
    }
  }

  /**
   * Start session
   */
  static async startSession() {
    return await mongoose.startSession();
  }

  /**
   * End session
   */
  static async endSession(session) {
    await session.endSession();
  }

  /**
   * Commit transaction
   */
  static async commit(session) {
    await session.commitTransaction();
  }

  /**
   * Abort transaction
   */
  static async abort(session) {
    await session.abortTransaction();
  }

  /**
   * Retry transaction with backoff
   */
  static async retryTransaction(session, operations, maxRetries = 3) {
    let lastError;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await this.withTransaction(session, operations);
      } catch (error) {
        lastError = error;
        if (attempt < maxRetries - 1) {
          const delay = Math.pow(2, attempt) * 100;
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError;
  }
}

module.exports = TransactionHelper;
