// Initialize MongoDB database with collections and indexes
db.createCollection("users");
db.createCollection("products");
db.createCollection("orders");
db.createCollection("reviews");
db.createCollection("sellers");
db.createCollection("deliveries");
db.createCollection("categories");
db.createCollection("wishlist");
db.createCollection("carts");
db.createCollection("disputes");
db.createCollection("notifications");

// Create indexes
db.users.createIndex({ email: 1 }, { unique: true });
db.users.createIndex({ createdAt: -1 });
db.users.createIndex({ role: 1 });

db.products.createIndex({ name: "text", description: "text" });
db.products.createIndex({ sellerId: 1 });
db.products.createIndex({ category: 1 });
db.products.createIndex({ price: 1 });
db.products.createIndex({ rating: -1 });
db.products.createIndex({ createdAt: -1 });
db.products.createIndex({ status: 1 });

db.orders.createIndex({ buyerId: 1, createdAt: -1 });
db.orders.createIndex({ sellerId: 1, createdAt: -1 });
db.orders.createIndex({ status: 1 });
db.orders.createIndex({ orderNumber: 1 }, { unique: true });
db.orders.createIndex({ createdAt: -1 });

db.reviews.createIndex({ productId: 1 });
db.reviews.createIndex({ buyerId: 1 });
db.reviews.createIndex({ sellerId: 1 });
db.reviews.createIndex({ rating: -1 });
db.reviews.createIndex({ createdAt: -1 });

db.sellers.createIndex({ userId: 1 }, { unique: true });
db.sellers.createIndex({ shopName: 1 });
db.sellers.createIndex({ rating: -1 });
db.sellers.createIndex({ status: 1 });

db.deliveries.createIndex({ orderId: 1 }, { unique: true });
db.deliveries.createIndex({ providerId: 1 });
db.deliveries.createIndex({ status: 1 });
db.deliveries.createIndex({ estimatedDeliveryDate: 1 });
db.deliveries.createIndex({ createdAt: -1 });

db.wishlist.createIndex({ buyerId: 1 });
db.wishlist.createIndex({ productId: 1 });
db.wishlist.createIndex({ createdAt: -1 });
db.wishlist.createIndex({ buyerId: 1, productId: 1 }, { unique: true });

db.carts.createIndex({ buyerId: 1 }, { unique: true });
db.carts.createIndex({ updatedAt: -1 });

db.disputes.createIndex({ orderId: 1 });
db.disputes.createIndex({ status: 1 });
db.disputes.createIndex({ createdAt: -1 });

db.notifications.createIndex({ userId: 1 });
db.notifications.createIndex({ createdAt: -1 });
db.notifications.createIndex({ read: 1 });

print("✓ Database initialized with collections and indexes");
