'use strict';

/**
 * Product Response DTO Mapper
 * Formats public and seller product payloads, stripping internal fields and __v.
 */

function toProductResponse(product) {
  if (!product) return null;
  const doc = typeof product.toObject === 'function' ? product.toObject() : { ...product };

  delete doc.__v;

  return {
    id: doc._id || doc.id,
    name: doc.name || doc.title,
    title: doc.name || doc.title,
    slug: doc.slug,
    description: doc.description,
    category: doc.category,
    subCategory: doc.subCategory,
    tags: doc.tags,
    sku: doc.sku,
    originalPrice: doc.originalPrice,
    discountPrice: doc.discountPrice,
    price: doc.discountPrice !== undefined ? doc.discountPrice : doc.price,
    stock: doc.stock,
    reserved: doc.reserved || 0,
    sold_out: doc.sold_out || 0,
    images: doc.images || [],
    shopId: doc.shopId,
    sellerId: doc.sellerId,
    shop: doc.shop,
    status: doc.status,
    isActive: Boolean(doc.isActive),
    ratings: doc.ratings || 0,
    numOfReviews: doc.numOfReviews || 0,
    reviews: (doc.reviews || []).map((r) => ({
      id: r._id || r.id,
      user: r.user,
      rating: r.rating,
      comment: r.comment,
      moderationStatus: r.moderationStatus || 'approved',
      createdAt: r.createdAt,
    })),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    publishedAt: doc.publishedAt,
    archivedAt: doc.archivedAt,
  };
}

function toProductListResponse(products) {
  if (!Array.isArray(products)) return [];
  return products.map(toProductResponse).filter(Boolean);
}

module.exports = {
  toProductResponse,
  toProductListResponse,
};
