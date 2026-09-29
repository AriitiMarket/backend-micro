const subscriptionRepository = require('../repositories/subscriptions.repository');

class ApiError extends Error { constructor(message, statusCode) { super(message); this.statusCode = statusCode; } }

const TIER_PRICES = {
  BASIC: { MONTHLY: 0, YEARLY: 0 },
  BUSINESS: { MONTHLY: 29.99, YEARLY: 299.99 },
  PRO: { MONTHLY: 99.99, YEARLY: 999.99 },
};

const TIER_FEATURES = {
  BASIC: ['5 products', 'Basic analytics', 'Email support'],
  BUSINESS: ['Unlimited products', 'Advanced analytics', 'Priority support', 'Custom domain'],
  PRO: ['Unlimited products', 'Advanced analytics', 'Priority support', 'Custom domain', 'API access', 'Dedicated manager'],
};

class SubscriptionService {
  async createSubscription(payload) {
    const existing = await subscriptionRepository.findByStore(payload.storeId);
    if (existing) throw new ApiError('Subscription already exists for this store', 400);
    const amount = TIER_PRICES[payload.tier]?.[payload.billingCycle] ?? 0;
    const features = TIER_FEATURES[payload.tier] ?? [];
    const startDate = new Date();
    const endDate = new Date(startDate);
    if (payload.billingCycle === 'YEARLY') endDate.setFullYear(endDate.getFullYear() + 1);
    else endDate.setMonth(endDate.getMonth() + 1);
    return subscriptionRepository.create({
      storeId: payload.storeId,
      tier: payload.tier || 'BASIC',
      billingCycle: payload.billingCycle || 'MONTHLY',
      amount,
      features,
      startDate,
      endDate,
      autoRenew: payload.autoRenew ?? true,
    });
  }

  getSubscription(id) { return subscriptionRepository.findById(id); }
  getSubscriptionByStore(storeId) { return subscriptionRepository.findByStore(storeId); }
  getAllSubscriptions() { return subscriptionRepository.findAll(); }
  getActiveSubscriptions() { return subscriptionRepository.findActive(); }

  async updateSubscription(id, data) {
    const subscription = await subscriptionRepository.findById(id);
    if (!subscription) throw new ApiError('Subscription not found', 404);
    if (data.tier || data.billingCycle) {
      const tier = data.tier || subscription.tier;
      const cycle = data.billingCycle || subscription.billingCycle;
      data.amount = TIER_PRICES[tier]?.[cycle] ?? subscription.amount;
      data.features = TIER_FEATURES[tier] ?? subscription.features;
    }
    const updated = await subscriptionRepository.findByIdAndUpdate(id, data);
    return updated;
  }

  async cancelSubscription(id) {
    const updated = await subscriptionRepository.findByIdAndUpdate(id, { status: 'CANCELLED', autoRenew: false });
    if (!updated) throw new ApiError('Subscription not found', 404);
    return updated;
  }

  async deleteSubscription(id) {
    const result = await subscriptionRepository.findByIdAndDelete(id);
    if (!result) throw new ApiError('Subscription not found', 404);
    return { message: 'Subscription deleted successfully!' };
  }
}

module.exports = new SubscriptionService();
