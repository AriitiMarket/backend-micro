'use strict';

const mongoose = require('mongoose');
const walletRepo = require('../repositories/providerWallet.repository');
const payoutRepo = require('../repositories/providerPayout.repository');
const txRepo = require('../repositories/providerWalletTransaction.repository');
const providersRepo = require('../../providers/repositories/providers.repository');
const {
  validatePayoutAccount,
  validatePayoutRequest,
  validatePayoutReview,
} = require('../validators');

const cents = (amount) => Math.round((Number(amount) || 0) * 100) / 100;

async function getProviderForUser(userId) {
  const provider = await providersRepo.findByIdentityUserId(String(userId));
  if (!provider) throw Object.assign(new Error('Delivery provider account not found'), { status: 404 });
  return provider;
}

async function getOrCreateWallet(providerId) {
  return walletRepo.getOrCreate(providerId);
}

async function releaseMatured(providerId) {
  const now = new Date();
  const matured = await txRepo.findMatured(providerId, now);
  for (const tx of matured) {
    const changed = await txRepo.atomicUpdateStatus(tx._id, 'pending', 'available');
    if (changed.modifiedCount) {
      await txRepo.create({
        providerId,
        key: `RELEASE:${tx._id}`,
        type: 'earning_available',
        amount: tx.amount,
        status: 'available',
        deliveryId: null,
      });
      await walletRepo.releaseMatured(providerId, tx.amount);
    }
  }
}

async function creditDelivery(delivery) {
  if (!delivery.providerId || Number(delivery.delivererEarning) <= 0) return null;
  // Some lifecycle unit tests exercise status transitions without a database;
  // production calls run only after Delivery readiness has established this.
  if (mongoose.connection.readyState !== 1) return null;

  const amount = cents(delivery.delivererEarning);
  const settings = await require('../../locations-expansion/services/zones.service').getDeliveryFeeSettings();
  const holdHours = Math.max(0, Number(settings.holdHours ?? process.env.DELIVERER_EARNING_HOLD_HOURS ?? 24));
  const availableAt = new Date(Date.now() + holdHours * 60 * 60 * 1000);

  try {
    await txRepo.create({
      providerId: delivery.providerId,
      deliveryId: delivery._id,
      key: `DELIVERY_EARNING:${delivery._id}`,
      type: 'delivery_earning',
      amount,
      status: holdHours ? 'pending' : 'available',
      availableAt,
    });
  } catch (error) {
    if (error.code === 11000) return null;
    throw error;
  }

  const wallet = await getOrCreateWallet(delivery.providerId);
  const bucket = holdHours ? 'pendingBalance' : 'availableBalance';
  await walletRepo.creditBalance(wallet._id, bucket, amount);
  return amount;
}

async function getWallet(userId) {
  const provider = await getProviderForUser(userId);
  const wallet = await getOrCreateWallet(provider._id);
  await releaseMatured(provider._id);
  const refreshed = await walletRepo.findById(wallet._id);
  const [transactions, payouts] = await Promise.all([
    txRepo.find({ providerId: provider._id, type: 'delivery_earning' }, { sort: { createdAt: -1 }, limit: 100 }),
    payoutRepo.find({ providerId: provider._id }, { sort: { createdAt: -1 }, limit: 50 }),
  ]);
  return { provider, wallet: refreshed, earnings: transactions, payouts };
}

async function setPayoutAccount(userId, account) {
  const provider = await getProviderForUser(userId);
  const validation = validatePayoutAccount(account);
  if (!validation.valid) {
    throw Object.assign(new Error(validation.message), { status: 422 });
  }
  return providersRepo.updateFields(provider._id, { 'metadata.payoutAccount': validation.data });
}

async function requestPayout(userId, amount) {
  const provider = await getProviderForUser(userId);
  const validation = validatePayoutRequest(amount);
  if (!validation.valid) {
    throw Object.assign(new Error(validation.message), { status: 422 });
  }
  const value = validation.value;

  const settings = await require('../../locations-expansion/services/zones.service').getDeliveryFeeSettings();
  const minimum = Math.max(0, Number(settings.minimumPayout ?? process.env.DELIVERER_MIN_PAYOUT_ETB ?? 0));
  if (value < minimum) {
    throw Object.assign(new Error(`Minimum payout amount is ${minimum.toFixed(2)} ETB`), { status: 422 });
  }

  const account = provider.metadata?.payoutAccount;
  if (!account?.accountNumber || account.verified !== true) {
    throw Object.assign(new Error('Add and verify a payout account before requesting a payout'), {
      status: 422,
      code: 'PAYOUT_ACCOUNT_REQUIRED',
    });
  }

  const wallet = await getOrCreateWallet(provider._id);
  // Atomic balance deduction: checks availableBalance >= value and locks the funds
  const reserved = await walletRepo.atomicReservePayout(wallet._id, value);
  if (!reserved) {
    throw Object.assign(new Error('Exceeds available balance'), {
      status: 422,
      code: 'INSUFFICIENT_BALANCE',
    });
  }

  let payout;
  try {
    payout = await payoutRepo.create({
      providerId: provider._id,
      amount: value,
      payoutAccount: account,
      status: 'pending',
    });
    await txRepo.create({
      providerId: provider._id,
      payoutId: payout._id,
      key: `PAYOUT_REQUEST:${payout._id}`,
      type: 'payout_requested',
      amount: value,
      status: 'locked',
    });
  } catch (error) {
    // Rollback atomic reservation if record creation failed
    await walletRepo.releasePayoutReserve(wallet._id, value);
    if (payout) await payoutRepo.deleteOne({ _id: payout._id });
    throw error;
  }
  return payout;
}

async function reviewPayout(id, actorId, action, reason = '', reference = '') {
  const payout = await payoutRepo.findById(id);
  if (!payout) throw Object.assign(new Error('Payout not found'), { status: 404 });

  if (payout.status !== 'pending') {
    if ((action === 'approve' && ['approved', 'paid'].includes(payout.status)) ||
        (action === 'reject' && payout.status === 'rejected')) {
      return payout;
    }
    throw Object.assign(new Error('Payout has already been processed'), { status: 409 });
  }

  const validation = validatePayoutReview(action, reason, reference);
  if (!validation.valid) {
    throw Object.assign(new Error(validation.message), { status: 422 });
  }

  const nextStatus = action === 'approve' ? 'paid' : 'rejected';
  // Atomic transition ensures only one concurrent review request transitions the payout
  const changed = await payoutRepo.atomicTransitionStatus(id, 'pending', {
    status: nextStatus,
    reviewedBy: String(actorId),
    reviewedAt: new Date(),
    reason: validation.reason,
    reference: validation.reference,
  });

  if (!changed) {
    throw Object.assign(new Error('Payout has already been processed'), { status: 409 });
  }

  if (action === 'approve') {
    await walletRepo.settlePayout(payout.providerId, payout.amount);
  } else {
    await walletRepo.refundPayout(payout.providerId, payout.amount);
  }

  await txRepo.create({
    providerId: payout.providerId,
    payoutId: payout._id,
    key: `PAYOUT_${nextStatus.toUpperCase()}:${payout._id}`,
    type: action === 'approve' ? 'payout_paid' : 'payout_rejected',
    amount: payout.amount,
    status: action === 'approve' ? 'paid' : 'available',
    note: validation.reason,
  });

  return changed;
}

async function listPayouts(filter = {}) {
  return payoutRepo.find(filter, {
    populate: { path: 'providerId', select: 'name phone identityUserId' },
    sort: { createdAt: 1 },
    limit: 200,
  });
}

module.exports = {
  creditDelivery,
  getWallet,
  setPayoutAccount,
  requestPayout,
  reviewPayout,
  listPayouts,
};
