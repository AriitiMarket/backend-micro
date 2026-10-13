#!/usr/bin/env node
// Commerce service seed — Categories, Shops, Products
// Usage:
//   COMPOSE_PROJECT_NAME=aritii-v2 docker compose exec commerce-service node src/seed/seed-commerce.js

const mongoose = require('mongoose');
const Category = require('../modules/catalog/models/Categories');
const Shop = require('../modules/selling/models/Shops');
const Product = require('../modules/catalog/models/Products');

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/ariti_commerce';

// ─── Categories ───────────────────────────────────────────────────────────────
const CATEGORIES = [
  // Product categories
  { title: 'Electronics', description: 'Electronic devices, gadgets, and accessories', type: 'product', sortOrder: 1 },
  { title: 'Fashion', description: 'Clothing, shoes, and fashion accessories', type: 'product', sortOrder: 2 },
  { title: 'Home & Living', description: 'Furniture, decor, and household items', type: 'product', sortOrder: 3 },
  { title: 'Beauty & Personal Care', description: 'Cosmetics, skincare, and personal care products', type: 'product', sortOrder: 4 },
  { title: 'Groceries & Food', description: 'Food, beverages, and grocery items', type: 'product', sortOrder: 5 },
  { title: 'Handcrafts & Local Products', description: 'Handmade and locally sourced products', type: 'product', sortOrder: 6 },
  // Business categories
  { title: 'Retail', description: 'General retail and reselling businesses', type: 'business', sortOrder: 7 },
  { title: 'Food & Beverage', description: 'Restaurants, cafes, and food services', type: 'business', sortOrder: 8 },
  { title: 'Services', description: 'Professional and personal services', type: 'business', sortOrder: 9 },
  { title: 'Manufacturing', description: 'Production and assembly businesses', type: 'business', sortOrder: 10 },
  { title: 'Agriculture', description: 'Farming and agricultural products', type: 'business', sortOrder: 11 },
  { title: 'Technology', description: 'Software, IT, and tech services', type: 'business', sortOrder: 12 },
  { title: 'Sports Equipment', description: 'Sports gear, fitness equipment, and outdoor gear', type: 'product', sortOrder: 13 },
  { title: 'Books & Magazines', description: 'Books, e-books, and publications', type: 'product', sortOrder: 14 },
];

// ─── Shops ────────────────────────────────────────────────────────────────────
const SHOPS = [
  {
    name: 'TechHub Electronics',
    email: 'shop1@aritii.com',
    ownerId: 'seller1-identity-id', // Will be replaced with actual ID from identity-service
    description: 'Latest gadgets and electronics at competitive prices',
    category: 'Retail',
    address: '100 Tech Street, Addis Ababa',
    phoneNumber: 55510001,
    zipCode: 10001,
    status: 'APPROVED',
  },
  {
    name: 'Fashion Forward',
    email: 'shop2@aritii.com',
    ownerId: 'seller2-identity-id',
    description: 'Trendy clothing and fashion accessories',
    category: 'Retail',
    address: '200 Fashion Ave, Addis Ababa',
    phoneNumber: 55510002,
    zipCode: 10002,
    status: 'APPROVED',
  },
  {
    name: 'Harar Fresh Market',
    email: 'shop3@aritii.com',
    ownerId: 'seller3-identity-id',
    description: 'Fresh produce and organic food products',
    category: 'Food & Beverage',
    address: '300 Market Road, Harar',
    phoneNumber: 55510003,
    zipCode: 10003,
    status: 'APPROVED',
  },
  {
    name: 'Organic Market',
    email: 'shop4@aritii.com',
    ownerId: 'seller4-identity-id',
    description: 'Organic produce and whole foods',
    category: 'Groceries & Food',
    address: '150 Green Street, Addis Ababa',
    phoneNumber: 55510004,
    zipCode: 10004,
    status: 'APPROVED',
  },
  {
    name: 'Tech Accessories',
    email: 'shop5@aritii.com',
    ownerId: 'seller5-identity-id',
    description: 'Phone cases, chargers, and tech gadgets',
    category: 'Electronics',
    address: '250 Circuit Lane, Addis Ababa',
    phoneNumber: 55510005,
    zipCode: 10005,
    status: 'APPROVED',
  },
];

// ─── Products ─────────────────────────────────────────────────────────────────
const PRODUCTS = [
  // TechHub Electronics
  { name: 'Wireless Bluetooth Headphones', description: 'Premium noise-cancelling headphones with 30hr battery', category: 'Electronics', originalPrice: 199.99, discountPrice: 149.99, stock: 50, shopIndex: 0 },
  { name: 'Smartphone 128GB', description: 'Latest smartphone with 5G, 128GB storage, 6.5" display', category: 'Electronics', originalPrice: 799.99, discountPrice: 699.99, stock: 30, shopIndex: 0 },
  { name: 'Laptop 15.6" 16GB RAM', description: 'High-performance laptop with Intel i7, 512GB SSD', category: 'Electronics', originalPrice: 1099.99, discountPrice: 899.99, stock: 20, shopIndex: 0 },
  { name: '4K Smart TV 55"', description: 'Ultra HD Smart TV with HDR, built-in streaming apps', category: 'Electronics', originalPrice: 549.99, discountPrice: 449.99, stock: 15, shopIndex: 0 },
  { name: 'Wireless Charging Pad', description: 'Fast wireless charger compatible with all Qi devices', category: 'Electronics', originalPrice: 39.99, discountPrice: 29.99, stock: 100, shopIndex: 0 },

  // Fashion Forward
  { name: 'Classic Denim Jacket', description: 'Timeless denim jacket with modern fit', category: 'Fashion', originalPrice: 99.99, discountPrice: 79.99, stock: 40, shopIndex: 1 },
  { name: 'Running Shoes Pro', description: 'Lightweight running shoes with responsive cushioning', category: 'Fashion', originalPrice: 149.99, discountPrice: 119.99, stock: 35, shopIndex: 1 },
  { name: 'Organic Cotton T-Shirt', description: '100% organic cotton, sustainable and comfortable', category: 'Fashion', originalPrice: 34.99, discountPrice: 24.99, stock: 100, shopIndex: 1 },
  { name: 'Leather Crossbody Bag', description: 'Genuine leather bag with adjustable strap', category: 'Fashion', originalPrice: 229.99, discountPrice: 189.99, stock: 25, shopIndex: 1 },
  { name: 'Winter Wool Coat', description: 'Warm wool blend coat with classic styling', category: 'Fashion', originalPrice: 259.99, discountPrice: 199.99, stock: 20, shopIndex: 1 },

  // Harar Fresh Market
  { name: 'Organic Coffee Beans 1kg', description: 'Single origin, medium roast, fair trade', category: 'Groceries & Food', originalPrice: 29.99, discountPrice: 24.99, stock: 80, shopIndex: 2 },
  { name: 'Artisan Dark Chocolate 85%', description: 'Bean-to-bar, ethically sourced cacao', category: 'Groceries & Food', originalPrice: 11.99, discountPrice: 8.99, stock: 60, shopIndex: 2 },
  { name: 'Extra Virgin Olive Oil 500ml', description: 'Cold pressed, organic, peppery finish', category: 'Groceries & Food', originalPrice: 24.99, discountPrice: 19.99, stock: 45, shopIndex: 2 },
  { name: 'Mixed Nuts Premium 500g', description: 'Roasted almonds, cashews, pistachios', category: 'Groceries & Food', originalPrice: 18.99, discountPrice: 14.99, stock: 70, shopIndex: 2 },
  { name: 'Organic Green Tea 100 bags', description: 'Premium Japanese sencha, antioxidant rich', category: 'Groceries & Food', originalPrice: 16.99, discountPrice: 12.99, stock: 90, shopIndex: 2 },
  // Additional products
  { name: 'Yoga Mat', description: 'Extra-thick non-slip yoga mat for home practice', category: 'Sports Equipment', originalPrice: 39.99, discountPrice: 29.99, stock: 45, shopIndex: 0 },
  { name: 'Running Shoes', description: 'Breathable running shoes for long-distance training', category: 'Sports Equipment', originalPrice: 99.99, discountPrice: 79.99, stock: 30, shopIndex: 0 },
  { name: 'Kindle E-Reader', description: 'Lightweight e-reader with high-resolution display and weeks of battery', category: 'Books & Magazines', originalPrice: 149.99, discountPrice: 129.99, stock: 25, shopIndex: 1 },
  { name: 'Hardcover Novel Set', description: 'Collection of 3 classic literature novels in one volume', category: 'Books & Magazines', originalPrice: 49.99, discountPrice: 34.99, stock: 20, shopIndex: 1 },
  { name: 'Lego Star Wars Millennium Falcon', description: '1351-piece building set for Star Wars fans', category: 'Toys & Games', originalPrice: 199.99, discountPrice: 179.99, stock: 15, shopIndex: 0 },
];

async function seed() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log('Connected to MongoDB:', MONGO_URI);

    // ─── Categories ────────────────────────────────────────────────────────
    console.log('\n── Seeding Categories ──');
    let catCount = 0;
    for (const cat of CATEGORIES) {
      const existing = await Category.findOne({ title: cat.title });
      if (existing) {
        console.log(`  ✓ Category "${cat.title}" already exists`);
      } else {
        await Category.create(cat);
        console.log(`  + Created category: ${cat.title} (${cat.type})`);
        catCount++;
      }
    }
    console.log(`  Total categories: ${await Category.countDocuments()}`);

    // ─── Shops ─────────────────────────────────────────────────────────────
    console.log('\n── Seeding Shops ──');
    const shops = [];
    for (const shop of SHOPS) {
      const existing = await Shop.findOne({ email: shop.email });
      if (existing) {
        console.log(`  ✓ Shop "${shop.name}" already exists (id: ${existing._id})`);
        shops.push(existing);
      } else {
        const created = await Shop.create({
          ...shop,
          avatar: {
            public_id: `shop_${shop.name.toLowerCase().replace(/\s+/g, '_')}`,
            url: `https://ui-avatars.com/api/?name=${encodeURIComponent(shop.name)}&background=4f46e5&color=fff&size=200`,
          },
        });
        console.log(`  + Created shop: ${shop.name} (id: ${created._id})`);
        shops.push(created);
      }
    }

    // User -> Seller Actor -> Business -> Shop: seeded shops must belong to a
    // business before any product/order points at them.
    const { resolveShopBusinessId } = require('../modules/selling/services/business.service');
    for (const shop of shops) {
      if (shop.ownerId && !shop.businessId) await resolveShopBusinessId(shop);
    }

    // ─── Products ──────────────────────────────────────────────────────────
    console.log('\n── Seeding Products ──');
    let prodCount = 0;
    for (const prod of PRODUCTS) {
      const existing = await Product.findOne({ name: prod.name });
      if (existing) {
        console.log(`  ✓ Product "${prod.name}" already exists`);
        continue;
      }
      const shop = shops[prod.shopIndex];
      if (!shop) continue;

      // Schema defaults status to DRAFT (invisible). Seeds are demo content —
      // publish them explicitly so they pass the public visibility gate.
      await Product.create({
        name: prod.name,
        description: prod.description,
        category: prod.category,
        originalPrice: prod.originalPrice,
        discountPrice: prod.discountPrice,
        stock: prod.stock,
        reserved: 0,
        status: 'PUBLISHED',
        publishedAt: new Date(),
        images: [
          `https://ui-avatars.com/api/?name=${encodeURIComponent(prod.name)}&background=10b981&color=fff&size=500`,
        ],
        shopId: shop._id.toString(),
        shop: {
          _id: shop._id,
          name: shop.name,
          email: shop.email,
          ownerId: shop.ownerId,
          address: shop.address,
          phoneNumber: shop.phoneNumber,
          role: 'Seller',
          zipCode: shop.zipCode,
          availableBalance: 0,
          transections: [],
          avatar: shop.avatar,
          createdAt: shop.createdAt,
        },
        sellerId: shop.ownerId,
        sold_out: Math.floor(Math.random() * 20),
        ratings: (Math.random() * 1.5 + 3.5).toFixed(1),
      });
      console.log(`  + Created product: ${prod.name}`);
      prodCount++;
    }

    // ─── Summary ──────────────────────────────────────────────────────────
    console.log('\n' + '='.repeat(60));
    console.log('COMMERCE SEED COMPLETE');
    console.log('='.repeat(60));
    console.log(`  Categories: ${await Category.countDocuments()} total`);
    console.log(`  Shops:      ${await Shop.countDocuments()} total`);
    console.log(`  Products:   ${await Product.countDocuments()} total`);
    console.log('='.repeat(60));

  } catch (error) {
    console.error('Commerce seed failed:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }
}

seed().then(() => process.exit(0));
