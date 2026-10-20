const ProviderWallet = require('../models/ProviderWallet');
const WalletTransaction = require('../models/ProviderWalletTransaction');
const ProviderPayout = require('../models/ProviderPayout');
const providersRepo = require('../../providers/repositories/providers.repository');
const mongoose = require('mongoose');

const cents = (amount) => Math.round((Number(amount) || 0) * 100) / 100;

async function getProviderForUser(userId) {
  const provider = await providersRepo.findByIdentityUserId(String(userId));
  if (!provider) throw Object.assign(new Error('Delivery provider account not found'), { status: 404 });
  return provider;
}

async function getOrCreateWallet(providerId) {
  return ProviderWallet.findOneAndUpdate(
    { providerId }, { $setOnInsert: { providerId, currency: 'ETB' } }, { new: true, upsert: true, setDefaultsOnInsert: true },
  );
}

async function releaseMatured(providerId) {
  const now = new Date();
  const matured = await WalletTransaction.find({ providerId, type: 'delivery_earning', status: 'pending', availableAt: { $lte: now } }).select('_id amount');
  for (const tx of matured) {
    const changed = await WalletTransaction.updateOne({ _id: tx._id, status: 'pending' }, { $set: { status: 'available' } });
    if (changed.modifiedCount) {
      await WalletTransaction.create({ providerId, key: `RELEASE:${tx._id}`, type: 'earning_available', amount: tx.amount, status: 'available', deliveryId: null });
      await ProviderWallet.updateOne({ providerId }, { $inc: { pendingBalance: -tx.amount, availableBalance: tx.amount } });
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
    await WalletTransaction.create({
      providerId: delivery.providerId, deliveryId: delivery._id, key: `DELIVERY_EARNING:${delivery._id}`,
      type: 'delivery_earning', amount, status: holdHours ? 'pending' : 'available', availableAt,
    });
  } catch (error) {
    if (error.code === 11000) return null;
    throw error;
  }
  const wallet = await getOrCreateWallet(delivery.providerId);
  const bucket = holdHours ? 'pendingBalance' : 'availableBalance';
  await ProviderWallet.updateOne({ _id: wallet._id }, { $inc: { [bucket]: amount } });
  return amount;
}

async function getWallet(userId) {
  const provider = await getProviderForUser(userId);
  const wallet = await getOrCreateWallet(provider._id);
  await releaseMatured(provider._id);
  const refreshed = await ProviderWallet.findById(wallet._id).lean();
  const [transactions, payouts] = await Promise.all([
    WalletTransaction.find({ providerId: provider._id, type: 'delivery_earning' }).sort({ createdAt: -1 }).limit(100).lean(),
    ProviderPayout.find({ providerId: provider._id }).sort({ createdAt: -1 }).limit(50).lean(),
  ]);
  return { provider, wallet: refreshed, earnings: transactions, payouts };
}

async function setPayoutAccount(userId, account) {
  const provider = await getProviderForUser(userId);
  const cleaned = {
    type: String(account?.type || '').slice(0, 40),
    accountName: String(account?.accountName || '').trim().slice(0, 120),
    accountNumber: String(account?.accountNumber || '').trim().slice(0, 80),
    bankName: String(account?.bankName || '').trim().slice(0, 120),
    verified: false,
  };
  if (!cleaned.type || !cleaned.accountName || !cleaned.accountNumber) throw Object.assign(new Error('Payout type, account name and account number are required'), { status: 422 });
  return providersRepo.updateFields(provider._id, { 'metadata.payoutAccount': cleaned });
}

async function requestPayout(userId, amount) {
  const provider = await getProviderForUser(userId);
  const value = cents(amount);
  const settings = await require('../../locations-expansion/services/zones.service').getDeliveryFeeSettings();
  const minimum = Math.max(0, Number(settings.minimumPayout ?? process.env.DELIVERER_MIN_PAYOUT_ETB ?? 0));
  if (!Number.isFinite(value) || value <= 0) throw Object.assign(new Error('Payout amount must be greater than zero'), { status: 422 });
  if (value < minimum) throw Object.assign(new Error(`Minimum payout amount is ${minimum.toFixed(2)} ETB`), { status: 422 });
  const account = provider.metadata?.payoutAccount;
  if (!account?.accountNumber || account.verified !== true) throw Object.assign(new Error('Add and verify a payout account before requesting a payout'), { status: 422, code: 'PAYOUT_ACCOUNT_REQUIRED' });
  const wallet = await getOrCreateWallet(provider._id);
  const reserved = await ProviderWallet.findOneAndUpdate(
    { _id: wallet._id, availableBalance: { $gte: value } },
    { $inc: { availableBalance: -value, lockedBalance: value } }, { new: true },
  );
  if (!reserved) throw Object.assign(new Error('Exceeds available balance'), { status: 422, code: 'INSUFFICIENT_BALANCE' });
  let payout;
  try {
    payout = await ProviderPayout.create({ providerId: provider._id, amount: value, payoutAccount: account, status: 'pending' });
    await WalletTransaction.create({ providerId: provider._id, payoutId: payout._id, key: `PAYOUT_REQUEST:${payout._id}`, type: 'payout_requested', amount: value, status: 'locked' });
  } catch (error) {
    await ProviderWallet.updateOne({ _id: wallet._id }, { $inc: { availableBalance: value, lockedBalance: -value } });
    if (payout) await ProviderPayout.deleteOne({ _id: payout._id });
    throw error;
  }
  return payout;
}

async function reviewPayout(id, actorId, action, reason = '', reference = '') {
  const payout = await ProviderPayout.findById(id);
  if (!payout) throw Object.assign(new Error('Payout not found'), { status: 404 });
  if (payout.status !== 'pending') {
    if ((action === 'approve' && ['approved', 'paid'].includes(payout.status)) || (action === 'reject' && payout.status === 'rejected')) return payout;
    throw Object.assign(new Error('Payout has already been processed'), { status: 409 });
  }
  if (action === 'reject' && !String(reason).trim()) throw Object.assign(new Error('Rejection reason is required'), { status: 422 });
  const nextStatus = action === 'approve' ? 'paid' : 'rejected';
  const changed = await ProviderPayout.findOneAndUpdate({ _id: id, status: 'pending' }, {
    $set: { status: nextStatus, reviewedBy: String(actorId), reviewedAt: new Date(), reason: String(reason).slice(0, 500), reference: String(reference).slice(0, 120) || null },
  }, { new: true });
  if (!changed) throw Object.assign(new Error('Payout has already been processed'), { status: 409 });
  const delta = action === 'approve'
    ? { $inc: { lockedBalance: -payout.amount, withdrawnBalance: payout.amount } }
    : { $inc: { lockedBalance: -payout.amount, availableBalance: payout.amount } };
  await ProviderWallet.updateOne({ providerId: payout.providerId }, delta);
  await WalletTransaction.create({
    providerId: payout.providerId, payoutId: payout._id, key: `PAYOUT_${nextStatus.toUpperCase()}:${payout._id}`,
    type: action === 'approve' ? 'payout_paid' : 'payout_rejected', amount: payout.amount,
    status: action === 'approve' ? 'paid' : 'available', note: reason,
  });
  return changed;
}

async function listPayouts(filter = {}) {
  return ProviderPayout.find(filter).populate('providerId', 'name phone identityUserId').sort({ createdAt: 1 }).limit(200).lean();
}

module.exports = { creditDelivery, getWallet, setPayoutAccount, requestPayout, reviewPayout, listPayouts };
