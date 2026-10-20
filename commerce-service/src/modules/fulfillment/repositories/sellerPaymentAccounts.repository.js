const SellerPaymentAccount = require('../models/SellerPaymentAccounts');

class SellerPaymentAccountsRepository {
  async create(data) {
    const account = new SellerPaymentAccount(data);
    return account.save();
  }

  async findById(id) {
    return SellerPaymentAccount.findById(id).lean();
  }

  async findBySellerId(sellerId, options = {}) {
    const { limit = 50, offset = 0 } = options;
    return SellerPaymentAccount.find({ sellerId })
      .skip(offset)
      .limit(Math.min(Math.max(1, limit), 100))
      .sort({ createdAt: -1 })
      .lean();
  }

  async findDefaultBySellerId(sellerId) {
    return SellerPaymentAccount.findOne({ sellerId, isDefault: true }).lean();
  }

  async updateById(id, data) {
    return SellerPaymentAccount.findByIdAndUpdate(id, { $set: data }, { new: true }).lean();
  }

  async setDefault(sellerId, accountId) {
    // Unset all defaults for this seller first
    await SellerPaymentAccount.updateMany({ sellerId }, { $set: { isDefault: false } });
    return SellerPaymentAccount.findByIdAndUpdate(accountId, { $set: { isDefault: true } }, { new: true }).lean();
  }

  async deleteById(id) {
    return SellerPaymentAccount.findByIdAndDelete(id).lean();
  }

  async verifyById(id, isVerified = true, verificationNotes = '') {
    return SellerPaymentAccount.findByIdAndUpdate(
      id,
      { $set: { status: isVerified ? 'VERIFIED' : 'REJECTED', verificationNotes } },
      { new: true }
    ).lean();
  }

  async countBySellerId(sellerId) {
    return SellerPaymentAccount.countDocuments({ sellerId });
  }
}

module.exports = new SellerPaymentAccountsRepository();
