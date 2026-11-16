'use strict';

function validatePayoutAccount(account) {
  if (!account || typeof account !== 'object') {
    return { valid: false, message: 'Payout account details are required' };
  }
  const type = String(account.type || '').trim().slice(0, 40);
  const accountName = String(account.accountName || '').trim().slice(0, 120);
  const accountNumber = String(account.accountNumber || '').trim().slice(0, 80);
  const bankName = String(account.bankName || '').trim().slice(0, 120);

  if (!type || !accountName || !accountNumber) {
    return { valid: false, message: 'Payout type, account name and account number are required' };
  }
  return {
    valid: true,
    data: { type, accountName, accountNumber, bankName, verified: false },
  };
}

function validatePayoutRequest(amount) {
  const value = Math.round((Number(amount) || 0) * 100) / 100;
  if (!Number.isFinite(value) || value <= 0) {
    return { valid: false, message: 'Payout amount must be greater than zero' };
  }
  return { valid: true, value };
}

function validatePayoutReview(action, reason = '', reference = '') {
  if (!['approve', 'reject'].includes(action)) {
    return { valid: false, message: 'Action must be approve or reject' };
  }
  if (action === 'reject' && !String(reason || '').trim()) {
    return { valid: false, message: 'Rejection reason is required' };
  }
  return {
    valid: true,
    reason: String(reason || '').slice(0, 500),
    reference: String(reference || '').slice(0, 120) || null,
  };
}

module.exports = {
  validatePayoutAccount,
  validatePayoutRequest,
  validatePayoutReview,
};
