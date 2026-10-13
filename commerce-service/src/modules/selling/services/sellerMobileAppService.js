/**
 * Seller mobile app service
 * Order management, inventory, customer messages
 */

class SellerMobileAppService {
  /**
   * Get seller mobile dashboard
   */
  static async getSellerDashboard(sellerId) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [todayOrders, todayRevenue, pendingOrders, lowStock] = await Promise.all([
      Order.countDocuments({ sellerId, createdAt: { $gte: today } }),
      Order.aggregate([
        { $match: { sellerId, createdAt: { $gte: today } } },
        { $group: { _id: null, total: { $sum: '$totalPrice' } } }
      ]),
      Order.countDocuments({ sellerId, status: 'CONFIRMED' }),
      Product.find({ sellerId, stock: { $lt: 10 } }).select(['_id', 'name', 'stock']).limit(5)
    ]);

    return {
      todayOrders,
      todayRevenue: todayRevenue[0]?.total || 0,
      pendingOrders,
      lowStockItems: lowStock.length,
      topAction: pendingOrders > 0 ? 'review_orders' : 'add_products'
    };
  }

  /**
   * Get orders for mobile view (paginated)
   */
  static async getSellerOrders(sellerId, options = {}) {
    const { page = 1, limit = 10, filter = 'all' } = options;
    const skip = (page - 1) * limit;

    const query = { sellerId };
    if (filter !== 'all') {
      query.status = filter;
    }

    const [orders, total] = await Promise.all([
      Order.find(query)
        .select(['_id', 'buyerName', 'totalPrice', 'status', 'items', 'createdAt'])
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Order.countDocuments(query)
    ]);

    return {
      orders: orders.map(o => ({
        id: o._id,
        buyer: o.buyerName,
        total: o.totalPrice,
        status: o.status,
        itemCount: o.items?.length || 0,
        time: o.createdAt
      })),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) }
    };
  }

  /**
   * Quick order actions
   */
  static async updateOrderStatus(sellerId, orderId, newStatus) {
    const order = await Order.findOne({ _id: orderId, sellerId });
    if (!order) throw new Error('Order not found');

    const validTransitions = {
      'CONFIRMED': ['READY_FOR_PICKUP'],
      'READY_FOR_PICKUP': ['PICKED_UP', 'CANCELLED'],
      'PICKED_UP': ['DELIVERED']
    };

    if (!validTransitions[order.status]?.includes(newStatus)) {
      throw new Error('Invalid status transition');
    }

    order.status = newStatus;

    // Update timestamps
    const timestampMap = {
      'READY_FOR_PICKUP': 'readyForPickupAt',
      'PICKED_UP': 'pickedUpAt',
      'DELIVERED': 'deliveredAt'
    };

    if (timestampMap[newStatus]) {
      order[timestampMap[newStatus]] = new Date();
    }

    await order.save();
    return order;
  }

  /**
   * Manage inventory from mobile
   */
  static async updateInventory(sellerId, productId, quantity) {
    const product = await Product.findOne({ _id: productId, sellerId });
    if (!product) throw new Error('Product not found');

    product.stock = quantity;
    await product.save();

    return {
      productId,
      stock: quantity,
      message: quantity === 0 ? 'Product marked out of stock' : `Stock updated to ${quantity}`
    };
  }

  /**
   * Get customer messages (mobile chat)
   */
  static async getCustomerMessages(sellerId, limit = 20) {
    return Message.find({ recipientId: sellerId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .select(['_id', 'senderId', 'content', 'createdAt', 'read'])
      .lean();
  }

  /**
   * Mark messages as read
   */
  static async markMessagesAsRead(sellerId, messageIds) {
    await Message.updateMany(
      { _id: { $in: messageIds }, recipientId: sellerId },
      { read: true }
    );

    return { updated: messageIds.length };
  }

  /**
   * Get sellers quick filters
   */
  static getQuickFilters() {
    return [
      { label: 'All', value: 'all' },
      { label: 'Pending', value: 'CONFIRMED' },
      { label: 'Shipped', value: 'PICKED_UP' },
      { label: 'Delivered', value: 'DELIVERED' },
      { label: 'Cancelled', value: 'CANCELLED' }
    ];
  }
}

module.exports = SellerMobileAppService;
