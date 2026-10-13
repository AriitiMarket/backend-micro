/**
 * Wishlist sharing service
 * Generate shareable links, track shares
 */

class WishlistSharingService {
  /**
   * Generate shareable link
   */
  static generateShareLink(wishlistId) {
    const token = Buffer.from(wishlistId).toString('base64');
    return `/wishlist/shared/${token}`;
  }

  /**
   * Decode shared link
   */
  static decodeShareLink(token) {
    return Buffer.from(token, 'base64').toString();
  }

  /**
   * Share wishlist
   */
  static async shareWishlist(wishlistId, userId, shareData) {
    const share = {
      wishlistId,
      sharedBy: userId,
      recipients: shareData.recipients, // emails or user IDs
      message: shareData.message,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
      createdAt: new Date(),
      clicks: 0
    };

    // Save share record
    await WishlistShare.create(share);

    // Send notifications to recipients
    if (shareData.recipients?.length > 0) {
      await this._notifyRecipients(wishlistId, shareData.recipients, shareData.message);
    }

    return share;
  }

  /**
   * Track share clicks
   */
  static async trackShareClick(shareId) {
    await WishlistShare.updateOne(
      { _id: shareId },
      { $inc: { clicks: 1 }, lastAccessed: new Date() }
    );
  }

  /**
   * Get share analytics
   */
  static async getShareAnalytics(wishlistId) {
    const shares = await WishlistShare.find({ wishlistId });
    
    return {
      totalShares: shares.length,
      totalClicks: shares.reduce((sum, s) => sum + s.clicks, 0),
      byRecipient: shares.map(s => ({
        recipients: s.recipients,
        clicks: s.clicks,
        sharedAt: s.createdAt
      }))
    };
  }

  static async _notifyRecipients(wishlistId, recipients, message) {
    const realtimeClient = require('../../../shared/utils/realtime-client');
    
    for (const recipient of recipients) {
      await realtimeClient.emit('wishlist_shared', {
        wishlistId,
        message,
        link: this.generateShareLink(wishlistId),
        timestamp: new Date()
      });
    }
  }
}

module.exports = WishlistSharingService;
