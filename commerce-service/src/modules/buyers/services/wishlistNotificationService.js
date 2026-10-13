/**
 * Wishlist notification system
 * Handles price drops, back-in-stock alerts
 */

const realtimeClient = require('../../../shared/utils/realtime-client');

class WishlistNotificationService {
  /**
   * Monitor product price changes
   */
  static async notifyPriceDrop(productId, buyerId, oldPrice, newPrice) {
    const discount = Math.round(((oldPrice - newPrice) / oldPrice) * 100);

    if (discount < 5) return; // Minimum 5% discount

    await realtimeClient.emit('wishlist_price_drop', {
      productId,
      buyerId,
      oldPrice,
      newPrice,
      discount,
      timestamp: new Date(),
      actionUrl: `/products/${productId}`
    });
  }

  /**
   * Notify back-in-stock
   */
  static async notifyBackInStock(productId, buyerId, productName) {
    await realtimeClient.emit('wishlist_back_in_stock', {
      productId,
      buyerId,
      productName,
      timestamp: new Date(),
      actionUrl: `/products/${productId}`,
      priority: 'HIGH'
    });
  }

  /**
   * Notify seller response to wishlist inquiry
   */
  static async notifySellerMessage(wishlistId, buyerId, message) {
    await realtimeClient.emit('wishlist_seller_message', {
      wishlistId,
      buyerId,
      message,
      timestamp: new Date()
    });
  }

  /**
   * Batch notify price changes (daily job)
   */
  static async processDailyPriceNotifications(wishlistRepository, productRepository) {
    const wishlists = await wishlistRepository.find({ notifications: true });
    const notifications = [];

    for (const wishlist of wishlists) {
      for (const item of wishlist.items) {
        const product = await productRepository.findById(item.productId);
        if (!product) continue;

        const priceDropPercent = ((item.addedPrice - product.price) / item.addedPrice) * 100;

        if (priceDropPercent >= 5) {
          await this.notifyPriceDrop(
            item.productId,
            wishlist.userId,
            item.addedPrice,
            product.price
          );

          notifications.push({
            wishlistId: wishlist._id,
            productId: product._id,
            type: 'PRICE_DROP',
            discount: priceDropPercent
          });
        }
      }
    }

    return notifications;
  }
}

module.exports = WishlistNotificationService;
