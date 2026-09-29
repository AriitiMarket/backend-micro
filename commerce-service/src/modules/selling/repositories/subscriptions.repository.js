const Subscription = require('../models/Subscriptions');

class SubscriptionRepository {
  create(data) { return Subscription.create(data); }
  findById(id) { return Subscription.findById(id); }
  findByStore(storeId) { return Subscription.findOne({ storeId }); }
  findByUser(userId) { return Subscription.find({ userId }); }
  findAll() { return Subscription.find({}).sort({ createdAt: -1 }); }
  findActive() { return Subscription.find({ status: 'ACTIVE' }); }
  findByIdAndUpdate(id, data) { return Subscription.findByIdAndUpdate(id, data, { new: true }); }
  findByIdAndDelete(id) { return Subscription.findByIdAndDelete(id); }
}

module.exports = new SubscriptionRepository();
