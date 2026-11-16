const sellerPaymentAccountsRepository = require('../repositories/sellerPaymentAccounts.repository');

class ApiError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
  }
}

class SellerPaymentAccountsService {
  /**
   * Add a payment account for a seller
   */
  async addPaymentAccount(sellerId, accountData) {
    const { methodId, provider, accountLabel, accountHint, encryptedDetails, isDefault = false } = accountData;

    if (!methodId) throw new ApiError('Payment method ID is required', 400);
    if (!accountLabel) throw new ApiError('Account label is required', 400);
    if (!accountHint) throw new ApiError('Account hint is required', 400);
    if (!encryptedDetails) throw new ApiError('Encrypted account details are required', 400);

    const existingCount = await sellerPaymentAccountsRepository.countBySellerId(sellerId);

    const account = await sellerPaymentAccountsRepository.create({
      sellerId,
      methodId,
      provider: provider || '',
      status: 'PENDING',
      isDefault: existingCount === 0 ? true : isDefault,
      accountLabel,
      accountHint,
      encryptedDetails,
    });

    return account;
  }

  /**
   * Get all payment accounts for a seller
   */
  async getSellerPaymentAccounts(sellerId, options = {}) {
    return sellerPaymentAccountsRepository.findBySellerId(sellerId, options);
  }

  /**
   * Get the default payment account for a seller
   */
  async getDefaultPaymentAccount(sellerId) {
    return sellerPaymentAccountsRepository.findDefaultBySellerId(sellerId);
  }

  /**
   * Update a payment account (only owner or admin)
   */
  async updatePaymentAccount(accountId, sellerId, data) {
    const account = await sellerPaymentAccountsRepository.findById(accountId);
    if (!account) throw new ApiError('Payment account not found', 404);
    if (String(account.sellerId) !== String(sellerId)) {
      throw new ApiError('You do not own this payment account', 403);
    }

    const allowedFields = ['provider', 'accountLabel', 'accountHint', 'encryptedDetails', 'isDefault'];
    const updates = {};
    for (const field of allowedFields) {
      if (data[field] !== undefined) updates[field] = data[field];
    }

    if (updates.isDefault) {
      return sellerPaymentAccountsRepository.setDefault(sellerId, accountId);
    }

    return sellerPaymentAccountsRepository.updateById(accountId, updates);
  }

  /**
   * Delete a payment account (only owner or admin)
   */
  async deletePaymentAccount(accountId, sellerId) {
    const account = await sellerPaymentAccountsRepository.findById(accountId);
    if (!account) throw new ApiError('Payment account not found', 404);
    if (String(account.sellerId) !== String(sellerId)) {
      throw new ApiError('You do not own this payment account', 403);
    }

    return sellerPaymentAccountsRepository.deleteById(accountId);
  }

  /**
   * Verify or reject a payment account (admin only)
   */
  async verifyPaymentAccount(accountId, isVerified, verificationNotes = '') {
    return sellerPaymentAccountsRepository.verifyById(accountId, isVerified, verificationNotes);
  }

  /**
   * Get all payment accounts (admin view)
   */
  async getAllPaymentAccounts(options = {}) {
    const { limit = 50, offset = 0, status, sellerId } = options;
    const filter = {};
    if (status) filter.status = status;
    if (sellerId) filter.sellerId = sellerId;

    const [accounts, total] = await Promise.all([
      SellerPaymentAccountModel.find(filter)
        .skip(offset)
        .limit(Math.min(Math.max(1, limit), 100))
        .sort({ createdAt: -1 })
        .lean(),
      SellerPaymentAccountModel.countDocuments(filter),
    ]);

    return { accounts, total };
  }
}

const SellerPaymentAccountModel = require('../models/SellerPaymentAccounts');
module.exports = new SellerPaymentAccountsService();
