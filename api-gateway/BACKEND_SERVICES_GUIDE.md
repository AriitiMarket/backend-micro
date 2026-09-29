# Backend Services Guide

**Architecture:** Microservices with API Gateway pattern  
**Services:** 3 (API Gateway, Identity Service, Commerce Service)  
**Databases:** PostgreSQL + MongoDB  
**Language:** Node.js + Express.js

---

## 🏗️ System Overview

```
Frontend (Port 3000)
    ↓ HTTPS/HTTP
API Gateway (Port 8000)
    ↓           ↓
Identity (3001) Commerce (3002)
    ↓               ↓
PostgreSQL      MongoDB
```

---

## 🚪 API Gateway (Port 8000)

**Location:** `/api-gateway/`  
**Purpose:** Request routing, authentication, error handling

### Key Responsibilities

1. **JWT Validation** - Verify tokens on protected routes
2. **Route Proxying** - Forward requests to appropriate services
3. **CORS Handling** - Allow frontend requests
4. **Error Standardization** - Consistent error responses
5. **Logging** - Request/response logging

### Configuration (api-gateway/.env)

```env
PORT=8000
IDENTITY_SERVICE_URL=http://localhost:3001
COMMERCE_SERVICE_URL=http://localhost:3002
JWT_SECRET=your_secret_key
NODE_ENV=development
```

### Health Check

```bash
GET http://localhost:8000/health

Response: { status: "OK" }
```

### Route Structure

```javascript
// User routes (→ Identity Service)
/api/user/*

// Product routes (→ Commerce Service)
/api/product/*
/api/order/*
/api/shop/*
/api/cart/*
/api/wishlist/*
/api/address/*
/api/review/*
/api/category/*
/api/event/*
/api/coupon/*
```

### Error Handling

```javascript
// Standard error response
{
  success: false,
  message: "Error description",
  code: "ERROR_CODE",
  status: 400
}

// Common error codes
- AUTH_FAILED: Authentication failed
- TOKEN_EXPIRED: JWT token expired
- UNAUTHORIZED: User not authorized
- VALIDATION_ERROR: Input validation failed
- NOT_FOUND: Resource not found
- INTERNAL_ERROR: Server error
```

---

## 👤 Identity Service (Port 3001)

**Location:** `/identity-service/`  
**Database:** PostgreSQL  
**Port:** 3001

### Purpose

- User authentication
- User management
- Role management
- Session handling
- JWT token generation

### Configuration

```env
# .env
PORT=3001
DATABASE_URL=postgres://user:password@localhost:5432/aritii_identity
JWT_SECRET=your_secret_key
JWT_EXPIRY=7d
NODE_ENV=development
```

### Database Schema

```sql
-- Users table
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) UNIQUE NOT NULL,
  password VARCHAR(255) NOT NULL,
  name VARCHAR(255),
  phone VARCHAR(20),
  avatar VARCHAR(500),
  role VARCHAR(50) DEFAULT 'BUYER',
  sellerStatus VARCHAR(50),           -- PENDING, APPROVED, REJECTED
  createdAt TIMESTAMP DEFAULT NOW(),
  updatedAt TIMESTAMP DEFAULT NOW()
);

-- Seller Applications
CREATE TABLE seller_applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  userId UUID REFERENCES users(id) ON DELETE CASCADE,
  shopName VARCHAR(255),
  description TEXT,
  status VARCHAR(50) DEFAULT 'PENDING',
  createdAt TIMESTAMP DEFAULT NOW(),
  updatedAt TIMESTAMP DEFAULT NOW()
);

-- Sessions
CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  userId UUID REFERENCES users(id) ON DELETE CASCADE,
  token TEXT,
  expiresAt TIMESTAMP,
  createdAt TIMESTAMP DEFAULT NOW()
);
```

### Key Endpoints

#### Authentication

```
POST /api/user/create-user
  Body: { email, password, name, phone }
  Response: { user: {...}, token: "jwt..." }

POST /api/user/login-user
  Body: { email, password }
  Response: { user: {...}, token: "jwt..." }

POST /api/user/logout
  Headers: Authorization: Bearer <token>
  Response: { success: true }
```

#### User Management

```
GET /api/user/getuser
  Headers: Authorization: Bearer <token>
  Response: { user: {...} }

PUT /api/user/update-user-info
  Headers: Authorization: Bearer <token>
  Body: { name, phone, ... }
  Response: { user: {...} }

PUT /api/user/update-avatar
  Headers: Authorization: Bearer <token>
  Body: FormData with avatar file
  Response: { user: {...} }
```

#### Seller Application

```
POST /api/user/apply-to-be-seller
  Headers: Authorization: Bearer <token>
  Body: { shopName, description }
  Response: { application: {...} }

GET /api/user/seller-applications
  Headers: Authorization: Bearer <token> (admin only)
  Response: { applications: [...] }

POST /api/user/approve-seller/:id
  Headers: Authorization: Bearer <token> (admin only)
  Response: { success: true }

GET /api/user/get-user-status
  Headers: Authorization: Bearer <token>
  Response: { user: {...}, sellerStatus: "APPROVED" }
```

### Key Controllers

#### User Controller

```javascript
// controllers/userController.js

export const createUser = async (req, res) => {
  try {
    const { email, password, name, phone } = req.body;
    
    // Validate input
    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password required' });
    }

    // Check if user exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(409).json({ message: 'User already exists' });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create user
    const user = await User.create({
      email,
      password: hashedPassword,
      name,
      phone,
      role: 'BUYER'
    });

    // Generate JWT
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRY }
    );

    return res.json({
      user: { id: user.id, email, name, role: user.role },
      token
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const loginUser = async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const passwordMatch = await bcrypt.compare(password, user.password);
    if (!passwordMatch) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, sellerStatus: user.sellerStatus },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRY }
    );

    return res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        phone: user.phone,
        avatar: user.avatar,
        role: user.role,
        sellerStatus: user.sellerStatus
      },
      token
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
```

### Authentication Middleware

```javascript
// middleware/authenticate.js

export const authenticate = (req, res, next) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) {
      return res.status(401).json({ message: 'No token provided' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ message: 'Invalid token' });
  }
};

export const requireRole = (role) => (req, res, next) => {
  if (req.user.role !== role) {
    return res.status(403).json({ message: 'Access denied' });
  }
  next();
};
```

---

## 🛍️ Commerce Service (Port 3002)

**Location:** `/commerce-service/`  
**Database:** MongoDB  
**Port:** 3002

### Purpose

- Product management
- Order processing
- Shopping cart
- Shop management
- Reviews and ratings

### Configuration

```env
# .env
PORT=3002
MONGODB_URI=mongodb://localhost:27017/aritii_commerce
JWT_SECRET=your_secret_key
NODE_ENV=development
```

### Collections

#### Products Collection

```javascript
{
  _id: ObjectId,
  name: String,
  description: String,
  price: Number,
  discountPrice: Number,
  category: String,
  shop: ObjectId,          // Reference to Shop
  images: [String],        // Array of image URLs
  stock: Number,
  ratings: {
    average: Number,
    count: Number,
    details: [Number]      // Individual ratings
  },
  reviews: [ObjectId],     // Reference to Reviews
  tags: [String],
  isActive: Boolean,
  createdBy: String,       // Seller ID
  createdAt: Date,
  updatedAt: Date
}
```

#### Orders Collection

```javascript
{
  _id: ObjectId,
  orderNumber: String,              // Unique order number
  userId: String,
  seller: ObjectId,
  items: [{
    productId: ObjectId,
    quantity: Number,
    price: Number,
    total: Number,
    productSnapshot: Object         // Save product state at order time
  }],
  subtotal: Number,
  tax: Number,
  shippingCost: Number,
  total: Number,
  status: String,                   // PENDING, CONFIRMED, SHIPPED, DELIVERED, CANCELLED
  deliveryAddress: {
    type: String,
    country: String,
    city: String,
    address1: String,
    address2: String,
    zipCode: String
  },
  paymentMethod: String,            // payment, cbepay, etc
  paymentStatus: String,            // pending, completed, failed
  trackingNumber: String,
  notes: String,
  cancellationReason: String,
  createdAt: Date,
  updatedAt: Date,
  estimatedDelivery: Date
}
```

#### Shops Collection

```javascript
{
  _id: ObjectId,
  sellerId: String,                 // User ID of seller
  name: String,
  slug: String,                     // URL-friendly name
  description: Text,
  logo: String,
  banner: String,
  category: String,
  phone: String,
  email: String,
  address: String,
  website: String,
  rating: {
    average: Number,
    count: Number
  },
  followers: [String],              // Array of user IDs
  products: [ObjectId],
  isVerified: Boolean,
  status: String,                   // ACTIVE, SUSPENDED, CLOSED
  policies: {
    returnPolicy: String,
    shippingPolicy: String,
    privacyPolicy: String
  },
  stats: {
    totalProducts: Number,
    totalOrders: Number,
    totalRevenue: Number,
    averageRating: Number
  },
  createdAt: Date,
  updatedAt: Date
}
```

#### Carts Collection

```javascript
{
  _id: ObjectId,
  userId: String,
  items: [{
    productId: ObjectId,
    quantity: Number,
    addedAt: Date,
    price: Number                   // Price at time of adding
  }],
  total: Number,
  updatedAt: Date,
  expiresAt: Date                   // Auto-delete after 30 days
}
```

#### Wishlist Collection

```javascript
{
  _id: ObjectId,
  userId: String,
  products: [ObjectId],
  addedAt: [Date],                  // Parallel array for date added
  updatedAt: Date
}
```

### Key Endpoints

#### Products

```
GET /api/product/get-all-products
  Query: { category, priceMin, priceMax, rating, page, limit }
  Response: { products: [...], total, pages }

GET /api/product/get-product/:id
  Response: { product: {...} }

POST /api/product/create-product
  Headers: Authorization: Bearer <token>
  Body: FormData { name, description, price, images[], ... }
  Response: { product: {...} }

PUT /api/product/update-product/:id
  Headers: Authorization: Bearer <token>
  Body: { name, price, stock, ... }
  Response: { product: {...} }

DELETE /api/product/delete-product/:id
  Headers: Authorization: Bearer <token>
  Response: { success: true }
```

#### Orders

```
POST /api/order/create-order
  Headers: Authorization: Bearer <token>
  Body: { items, total, deliveryAddressId, paymentMethod }
  Response: { order: {...} }

GET /api/order/get-all-orders/user/:userId
  Headers: Authorization: Bearer <token>
  Response: { orders: [...] }

GET /api/order/get-all-orders/shop/:shopId
  Headers: Authorization: Bearer <token>
  Response: { orders: [...] }

GET /api/order/:id
  Headers: Authorization: Bearer <token>
  Response: { order: {...} }

POST /api/order/cancel/:id
  Headers: Authorization: Bearer <token>
  Body: { reason }
  Response: { order: {...} }

PUT /api/order/:id
  Headers: Authorization: Bearer <token>
  Body: { status }
  Response: { order: {...} }
```

#### Shops

```
GET /api/shop/get-all-shops
  Query: { page, limit, sort }
  Response: { shops: [...] }

GET /api/shop/get-shop-info/:id
  Response: { shop: {...} }

POST /api/shop/create-shop
  Headers: Authorization: Bearer <token>
  Body: { name, description, logo, ... }
  Response: { shop: {...} }

PUT /api/shop/update-shop/:id
  Headers: Authorization: Bearer <token>
  Body: { name, description, ... }
  Response: { shop: {...} }
```

#### Cart

```
GET /api/cart/get-cart/:userId
  Headers: Authorization: Bearer <token>
  Response: { cart: { items: [...], total } }

POST /api/cart/add-item
  Headers: Authorization: Bearer <token>
  Body: { productId, quantity }
  Response: { cart: {...} }

PUT /api/cart/update-item
  Headers: Authorization: Bearer <token>
  Body: { productId, quantity }
  Response: { cart: {...} }

DELETE /api/cart/remove-item
  Headers: Authorization: Bearer <token>
  Body: { productId }
  Response: { cart: {...} }
```

#### Addresses

```
GET /api/address/list
  Headers: Authorization: Bearer <token>
  Response: { addresses: [...] }

POST /api/address/add
  Headers: Authorization: Bearer <token>
  Body: { addressType, country, city, address1, zipCode }
  Response: { address: {...} }

PUT /api/address/:id
  Headers: Authorization: Bearer <token>
  Body: { addressType, country, city, ... }
  Response: { address: {...} }

DELETE /api/address/:id
  Headers: Authorization: Bearer <token>
  Response: { success: true }
```

### Key Controllers

#### Product Controller

```javascript
// controllers/productController.js

export const getAllProducts = async (req, res) => {
  try {
    const { category, priceMin, priceMax, rating, page = 1, limit = 10 } = req.query;

    let filter = { isActive: true };

    if (category) filter.category = category;
    if (priceMin || priceMax) {
      filter.price = {};
      if (priceMin) filter.price.$gte = parseFloat(priceMin);
      if (priceMax) filter.price.$lte = parseFloat(priceMax);
    }
    if (rating) filter['ratings.average'] = { $gte: parseFloat(rating) };

    const products = await Product.find(filter)
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .sort({ createdAt: -1 });

    const total = await Product.countDocuments(filter);

    return res.json({
      products,
      total,
      pages: Math.ceil(total / limit),
      currentPage: page
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
```

#### Order Controller

```javascript
// controllers/orderController.js

export const createOrder = async (req, res) => {
  try {
    const { items, total, deliveryAddressId, paymentMethod } = req.body;
    const userId = req.user.id;

    // Validate items
    for (let item of items) {
      const product = await Product.findById(item.productId);
      if (!product) {
        return res.status(404).json({ message: `Product not found: ${item.productId}` });
      }
      if (product.stock < item.quantity) {
        return res.status(400).json({ message: `Insufficient stock for ${product.name}` });
      }
    }

    // Create order
    const order = await Order.create({
      userId,
      items,
      total,
      deliveryAddressId,
      paymentMethod,
      status: 'PENDING',
      orderNumber: generateOrderNumber()
    });

    // Reduce stock
    for (let item of items) {
      await Product.findByIdAndUpdate(
        item.productId,
        { $inc: { stock: -item.quantity } }
      );
    }

    // Clear cart
    await Cart.deleteOne({ userId });

    return res.json({ order, message: 'Order created successfully' });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const cancelOrder = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const order = await Order.findById(id);
    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    if (order.status !== 'PENDING') {
      return res.status(400).json({ message: 'Only pending orders can be cancelled' });
    }

    // Update order
    order.status = 'CANCELLED';
    order.cancellationReason = reason;
    await order.save();

    // Restore stock
    for (let item of order.items) {
      await Product.findByIdAndUpdate(
        item.productId,
        { $inc: { stock: item.quantity } }
      );
    }

    return res.json({ order, message: 'Order cancelled successfully' });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
```

---

## 📊 Database Maintenance

### PostgreSQL Backups

```bash
# Backup
pg_dump -U user aritii_identity > backup.sql

# Restore
psql -U user aritii_identity < backup.sql

# Automated daily backup
0 2 * * * pg_dump -U user aritii_identity > /backups/identity_$(date +\%Y\%m\%d).sql
```

### MongoDB Backups

```bash
# Backup
mongodump --uri="mongodb://localhost:27017/aritii_commerce" --out=/backups

# Restore
mongorestore --uri="mongodb://localhost:27017" /backups

# Automated daily backup
0 2 * * * mongodump --uri="mongodb://localhost:27017/aritii_commerce" --out=/backups/$(date +\%Y\%m\%d)
```

---

## 🔐 Security Best Practices

1. **Password Hashing** - Use bcrypt with salt rounds ≥ 10
2. **JWT Secrets** - Use strong, random secrets (32+ characters)
3. **Environment Variables** - Never commit secrets, use .env files
4. **HTTPS Only** - Enforce HTTPS in production
5. **Rate Limiting** - Implement to prevent abuse
6. **Input Validation** - Validate all incoming data
7. **SQL Injection Prevention** - Use parameterized queries
8. **CORS Configuration** - Restrict to trusted origins only
9. **Admin Routes** - Require admin role and token verification
10. **Logging** - Log security events and errors

---

## 🧪 Testing

```bash
# Unit tests
npm test

# Integration tests
npm run test:integration

# E2E tests
npm run test:e2e

# Coverage report
npm run test:coverage
```

---

## 📈 Performance Optimization

1. **Database Indexing** - Index frequently queried fields
2. **Caching** - Use Redis for frequently accessed data
3. **Pagination** - Always paginate large result sets
4. **Connection Pooling** - Reuse database connections
5. **Compression** - Enable gzip compression
6. **CDN** - Use CDN for static assets
7. **Query Optimization** - Use projection to fetch only needed fields
8. **Async/Await** - Use async operations properly

---

## 🚀 Deployment

```bash
# Build services
docker compose build

# Start services
docker compose up -d

# Scale commerce service
docker compose up -d --scale commerce-service=3

# View logs
docker compose logs -f identity-service
docker compose logs -f commerce-service

# Stop services
docker compose down
```

---

**Document Version:** 1.0  
**Last Updated:** 2026-09-14  
**Maintainer:** Development Team
