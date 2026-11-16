'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const walletRepo = require('../repositories/providerWallet.repository');
const payoutRepo = require('../repositories/providerPayout.repository');
const txRepo = require('../repositories/providerWalletTransaction.repository');
const walletService = require('../services/provider-wallet.service');
const {
  validatePayoutAccount,
  validatePayoutRequest,
  validatePayoutReview,
} = require('../validators');

const ProviderWallet = require('../models/ProviderWallet');
const ProviderPayout = require('../models/ProviderPayout');
const ProviderWalletTransaction = require('../models/ProviderWalletTransaction');
const Provider = require('../../providers/models/Provider');

const TEST_DB_URI = process.env.ARITII_TEST_MONGO
  ? `${process.env.ARITII_TEST_MONGO}/aritii_provider_wallet_test`
  : 'mongodb://127.0.0.1:27017/aritii_provider_wallet_test';

test.before(async () => {
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(TEST_DB_URI);
  }
  await Promise.all([
    ProviderWallet.deleteMany({}),
    ProviderPayout.deleteMany({}),
    ProviderWalletTransaction.deleteMany({}),
    Provider.deleteMany({}),
  ]);
});

test.after(async () => {
  await Promise.all([
    ProviderWallet.deleteMany({}),
    ProviderPayout.deleteMany({}),
    ProviderWalletTransaction.deleteMany({}),
    Provider.deleteMany({}),
  ]);
  await mongoose.disconnect();
});

test('Validators: validatePayoutAccount', () => {
  const invalid = validatePayoutAccount({});
  assert.equal(invalid.valid, false);

  const valid = validatePayoutAccount({
    type: 'bank',
    accountName: 'Abebe Bikila',
    accountNumber: '100012345678',
    bankName: 'Commercial Bank of Ethiopia',
  });
  assert.equal(valid.valid, true);
  assert.equal(valid.data.accountName, 'Abebe Bikila');
  assert.equal(valid.data.verified, false);
});

test('Validators: validatePayoutRequest', () => {
  assert.equal(validatePayoutRequest(0).valid, false);
  assert.equal(validatePayoutRequest(-50).valid, false);
  assert.equal(validatePayoutRequest('abc').valid, false);

  const valid = validatePayoutRequest(150.5);
  assert.equal(valid.valid, true);
  assert.equal(valid.value, 150.5);
});

test('Validators: validatePayoutReview', () => {
  assert.equal(validatePayoutReview('invalid_action').valid, false);
  assert.equal(validatePayoutReview('reject', '').valid, false);

  const approved = validatePayoutReview('approve');
  assert.equal(approved.valid, true);

  const rejected = validatePayoutReview('reject', 'Invalid bank details');
  assert.equal(rejected.valid, true);
  assert.equal(rejected.reason, 'Invalid bank details');
});

test('Earnings credit and transaction ledger creation', async () => {
  const providerId = new mongoose.Types.ObjectId();
  const deliveryId = new mongoose.Types.ObjectId();

  const credited = await walletService.creditDelivery({
    providerId,
    _id: deliveryId,
    delivererEarning: 85.50,
  });

  assert.equal(credited, 85.50);

  const wallet = await walletRepo.findByProviderId(providerId);
  assert.ok(wallet);
  // Default holdHours is 24, so it lands in pendingBalance or availableBalance
  const totalBalance = wallet.pendingBalance + wallet.availableBalance;
  assert.equal(totalBalance, 85.50);

  const txs = await txRepo.find({ providerId });
  assert.equal(txs.length, 1);
  assert.equal(txs[0].type, 'delivery_earning');
  assert.equal(txs[0].amount, 85.50);
});

test('Concurrent payout requests exceeding available balance are atomically rejected', async () => {
  const identityUserId = `user-${Date.now()}`;
  const provider = await Provider.create({
    name: 'Courier Speed',
    phone: '+251911223344',
    identityUserId,
    status: 'available',
    metadata: {
      payoutAccount: {
        type: 'bank',
        accountName: 'Courier Speed',
        accountNumber: '100099998888',
        verified: true,
      },
    },
  });

  // Seed wallet with 100 ETB available
  const wallet = await walletRepo.getOrCreate(provider._id);
  await ProviderWallet.updateOne({ _id: wallet._id }, { $set: { availableBalance: 100, lockedBalance: 0 } });

  // Concurrently attempt 5 payout requests of 60 ETB each (total 300 ETB > 100 ETB)
  const attempts = await Promise.allSettled([
    walletService.requestPayout(identityUserId, 60),
    walletService.requestPayout(identityUserId, 60),
    walletService.requestPayout(identityUserId, 60),
    walletService.requestPayout(identityUserId, 60),
    walletService.requestPayout(identityUserId, 60),
  ]);

  const fulfilled = attempts.filter((a) => a.status === 'fulfilled');
  const rejected = attempts.filter((a) => a.status === 'rejected');

  // Exactly 1 can succeed, the other 4 must fail
  assert.equal(fulfilled.length, 1, 'Only 1 concurrent payout should succeed');
  assert.equal(rejected.length, 4, '4 concurrent payouts should be rejected');

  for (const r of rejected) {
    assert.match(r.reason.message, /Exceeds available balance/i);
  }

  // Wallet must reflect 40 ETB available and 60 ETB locked; NEVER negative
  const updatedWallet = await walletRepo.findByProviderId(provider._id);
  assert.equal(updatedWallet.availableBalance, 40);
  assert.equal(updatedWallet.lockedBalance, 60);
  assert.ok(updatedWallet.availableBalance >= 0, 'Available balance must never drop below 0');
});

test('Payout review: approve sets status paid, deducts locked and adds to withdrawn', async () => {
  const providerId = new mongoose.Types.ObjectId();
  const wallet = await walletRepo.getOrCreate(providerId);
  await ProviderWallet.updateOne({ _id: wallet._id }, { $set: { availableBalance: 50, lockedBalance: 50 } });

  const payout = await payoutRepo.create({
    providerId,
    amount: 50,
    payoutAccount: { accountNumber: '123' },
    status: 'pending',
  });

  const reviewed = await walletService.reviewPayout(payout._id, 'admin-1', 'approve', '', 'REF-999');
  assert.equal(reviewed.status, 'paid');
  assert.equal(reviewed.reference, 'REF-999');

  const refreshedWallet = await walletRepo.findByProviderId(providerId);
  assert.equal(refreshedWallet.lockedBalance, 0);
  assert.equal(refreshedWallet.withdrawnBalance, 50);
});

test('Payout review: reject returns locked funds to available balance', async () => {
  const providerId = new mongoose.Types.ObjectId();
  const wallet = await walletRepo.getOrCreate(providerId);
  await ProviderWallet.updateOne({ _id: wallet._id }, { $set: { availableBalance: 20, lockedBalance: 30 } });

  const payout = await payoutRepo.create({
    providerId,
    amount: 30,
    payoutAccount: { accountNumber: '123' },
    status: 'pending',
  });

  const reviewed = await walletService.reviewPayout(payout._id, 'admin-1', 'reject', 'Bank account closed');
  assert.equal(reviewed.status, 'rejected');

  const refreshedWallet = await walletRepo.findByProviderId(providerId);
  assert.equal(refreshedWallet.lockedBalance, 0);
  assert.equal(refreshedWallet.availableBalance, 50);
});
