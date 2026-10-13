/**
 * Wishlist to cart conversion
 * Move wishlist items to cart with bulk operations
 */

class WishlistCartConversionService {
  /**
   * Add wishlist items to cart
   */
  static async addWishlistToCart(wishlistId, userId, selectedItems = null) {
    const wishlist = await Wishlist.findById(wishlistId);
    if (!wishlist) throw new Error('Wishlist not found');

    let items = wishlist.items;
    if (selectedItems?.length > 0) {
      items = items.filter(i => selectedItems.includes(i._id.toString()));
    }

    const cart = await Cart.findOne({ userId });
    if (!cart) throw new Error('Cart not found');

    // Add to cart
    for (const item of items) {
      const existingItem = cart.items.find(ci => ci.productId === item.productId);
      
      if (existingItem) {
        existingItem.quantity += item.quantity || 1;
      } else {
        cart.items.push({
          productId: item.productId,
          quantity: item.quantity || 1,
          addedAt: new Date()
        });
      }
    }

    await cart.save();

    return {
      cartId: cart._id,
      itemsAdded: items.length,
      cartTotal: cart.items.length
    };
  }

  /**
   * Bulk move wishlist items to cart
   */
  static async moveAllToCart(wishlistId, userId) {
    return this.addWishlistToCart(wishlistId, userId);
  }

  /**
   * Get price comparison before adding to cart
   */
  static async getPriceComparison(wishlistId, productRepository) {
    const wishlist = await Wishlist.findById(wishlistId).populate('items.productId');
    
    const comparison = await Promise.all(
      wishlist.items.map(async (item) => {
        const alternatives = await productRepository.find({
          category: item.productId.category,
          _id: { $ne: item.productId._id }
        })
          .sort({ price: 1 })
          .limit(3)
          .select(['_id', 'name', 'price', 'rating']);

        return {
          productId: item.productId._id,
          productName: item.productId.name,
          currentPrice: item.productId.price,
          alternatives
        };
      })
    );

    return comparison;
  }
}

module.exports = WishlistCartConversionService;
