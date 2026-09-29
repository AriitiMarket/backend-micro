# Commerce Service

Product catalog, shopping cart, orders, and payments for Aritii Marketplace.

## Overview

The Commerce Service manages the core marketplace operations: seller shops, product listings, customer orders, shopping carts, and payment processing. It handles inventory, pricing, order fulfillment, and financial transactions.

## Key Features

### Shop Management
- Multi-seller shop creation and branding
- Shop customization (name, description, logo, categories)
- Shop analytics and performance metrics
- Seller dashboard
- Shop suspension/deactivation

### Product Catalog
- Product listing creation with images
- Multiple product variants (size, color, etc.)
- Inventory management
- Product search and filtering
- Categories and tagging
- Featured products

### Shopping Cart
- Add/remove items
- Quantity management
- Cart persistence across sessions
- Price calculation with taxes
- Coupon code support

### Orders
- Order creation from cart
- Order status tracking (pending, processing, shipped, delivered)
- Order history
- Order cancellation
- Return/refund processing
- Order-to-delivery integration

### Payments
- Multiple payment methods (card, mobile wallet, bank transfer)
- Payment processing and verification
- Invoice generation
- Receipt management
- Refund processing

## API Endpoints

### Shop Management

```http
POST /api/shops
{
  "name": "Tech Haven",
  "description": "Quality electronics and gadgets",
  "category": "Electronics",
  "logo": "https://...",
  "phone": "+251911234567"
}
Response: {
  "id": "shop_123",
  "sellerId": "user_456",
  "name": "Tech Haven",
  "status": "active",
  "createdAt": "2026-09-15T03:40:00Z"
}

GET /api/shops/:id
Response: {
  "id": "shop_123",
  "name": "Tech Haven",
  "rating": 4.8,
  "totalReviews": 245,
  "followerCount": 1250,
  "productCount": 87,
  "responseTime": "< 2 hours",
  "seller": { "name", "joinDate" }
}

PATCH /api/shops/:id
{
  "description": "Updated description",
  "bannerImage": "https://..."
}
Response: { "shop": { ... } }

GET /api/shops?search=electronics&sort=rating
Response: {
  "shops": [ ... ],
  "total": 245,
  "filters": { "search", "sort" }
}
```

### Product Management

```http
POST /api/shops/:shopId/products
{
  "name": "iPhone 15 Pro",
  "description": "Latest Apple smartphone",
  "category": "Smartphones",
  "price": 45000,
  "discount": 10,
  "stock": 50,
  "images": ["url1", "url2"],
  "variants": [
    { "type": "color", "values": ["Black", "White"] },
    { "type": "storage", "values": ["128GB", "256GB"] }
  ],
  "weight": 0.187,
  "sku": "IPHONE15PRO128GB"
}
Response: {
  "id": "prod_789",
  "shopId": "shop_123",
  "name": "iPhone 15 Pro",
  "status": "active",
  "createdAt": "2026-09-15T03:40:00Z"
}

GET /api/products/:id
Response: {
  "id": "prod_789",
  "name": "iPhone 15 Pro",
  "price": 45000,
  "discount": 10,
  "finalPrice": 40500,
  "rating": 4.7,
  "reviews": 120,
  "stock": 50,
  "shop": { "id", "name", "rating" },
  "variants": [ ... ],
  "images": [ ... ]
}

PATCH /api/products/:id
{
  "price": 44000,
  "stock": 45
}
Response: { "product": { ... } }

DELETE /api/products/:id
Response: { "message": "Product deleted" }

GET /api/products?category=smartphones&sort=popular&page=1&limit=20
Response: {
  "products": [ ... ],
  "total": 5420,
  "page": 1,
  "hasMore": true
}
```

### Shopping Cart

```http
POST /api/cart/items
{
  "productId": "prod_789",
  "quantity": 2,
  "variantChoices": { "color": "Black", "storage": "256GB" }
}
Response: {
  "cartId": "cart_user_456",
  "items": [
    {
      "id": "item_1",
      "productId": "prod_789",
      "quantity": 2,
      "price": 40500,
      "subtotal": 81000
    }
  ],
  "total": 81000,
  "tax": 8100,
  "grandTotal": 89100
}

GET /api/cart
Response: {
  "cartId": "cart_user_456",
  "items": [ ... ],
  "subtotal": 150000,
  "tax": 15000,
  "shipping": 100,
  "discount": 5000,
  "grandTotal": 160100,
  "currency": "ETB"
}

PATCH /api/cart/items/:itemId
{
  "quantity": 3
}
Response: { "cart": { ... } }

DELETE /api/cart/items/:itemId
Response: { "message": "Item removed from cart" }

POST /api/cart/coupon
{
  "code": "SAVE10"
}
Response: {
  "coupon": { "code", "discount", "type" },
  "cart": { ... }
}
```

### Orders

```http
POST /api/orders
{
  "cartId": "cart_user_456",
  "shippingAddressId": "addr_789",
  "paymentMethod": "card"
}
Response: {
  "id": "order_123",
  "orderNumber": "ORD-2026-09-001",
  "status": "pending_payment",
  "items": [ ... ],
  "total": 160100,
  "createdAt": "2026-09-15T03:40:00Z",
  "paymentUrl": "https://payment-gateway.com/..."
}

GET /api/orders/:id
Response: {
  "id": "order_123",
  "orderNumber": "ORD-2026-09-001",
  "status": "processing",
  "items": [ ... ],
  "total": 160100,
  "shipping": { "address", "carrier", "trackingNumber" },
  "payment": { "method", "status", "transactionId" },
  "timeline": [
    { "event": "order_created", "timestamp": "..." },
    { "event": "payment_confirmed", "timestamp": "..." },
    { "event": "order_shipped", "timestamp": "..." }
  ]
}

GET /api/orders?status=delivered&sort=recent
Response: {
  "orders": [ ... ],
  "total": 24,
  "filters": { "status", "sort" }
}

PATCH /api/orders/:id/cancel
Response: { "message": "Order cancelled" }

POST /api/orders/:id/return
{
  "reason": "Defective product",
  "comment": "Screen has dead pixels"
}
Response: {
  "returnId": "return_456",
  "status": "initiated",
  "refundAmount": 160100
}
```

### Payments

```http
POST /api/payments
{
  "orderId": "order_123",
  "method": "card",
  "amount": 160100,
  "currency": "ETB"
}
Response: {
  "paymentId": "pay_789",
  "status": "pending",
  "orderId": "order_123",
  "amount": 160100,
  "redirectUrl": "https://payment-gateway.com/checkout/..."
}

GET /api/payments/:id
Response: {
  "id": "pay_789",
  "orderId": "order_123",
  "status": "completed",
  "method": "card",
  "amount": 160100,
  "transactionId": "txn_12345",
  "timestamp": "2026-09-15T03:45:00Z",
  "receipt": { "url", "filename" }
}

POST /api/payments/:id/refund
{
  "amount": 160100,
  "reason": "Order cancelled"
}
Response: {
  "refundId": "refund_111",
  "status": "processing",
  "amount": 160100,
  "estimatedCompletion": "2026-09-17T03:40:00Z"
}
```

## Database Schema

### Shops Table
```sql
CREATE TABLE shops (
  id UUID PRIMARY KEY,
  seller_id UUID REFERENCES users(id),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  category VARCHAR(100),
  logo_url TEXT,
  banner_url TEXT,
  phone VARCHAR(20),
  city VARCHAR(100),
  rating DECIMAL(3, 2),
  total_reviews INT DEFAULT 0,
  follower_count INT DEFAULT 0,
  status ENUM('active', 'inactive', 'suspended'),
  response_time_minutes INT,
  created_at TIMESTAMP,
  updated_at TIMESTAMP,
  
  INDEX (seller_id),
  INDEX (category),
  INDEX (rating)
);
```

### Products Table
```sql
CREATE TABLE products (
  id UUID PRIMARY KEY,
  shop_id UUID REFERENCES shops(id),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  category VARCHAR(100),
  price DECIMAL(10, 2) NOT NULL,
  discount_percent INT DEFAULT 0,
  stock INT DEFAULT 0,
  sku VARCHAR(100) UNIQUE,
  weight DECIMAL(5, 3),
  rating DECIMAL(3, 2),
  review_count INT DEFAULT 0,
  view_count INT DEFAULT 0,
  status ENUM('active', 'inactive', 'archived'),
  created_at TIMESTAMP,
  updated_at TIMESTAMP,
  
  INDEX (shop_id),
  INDEX (category),
  INDEX (price),
  INDEX (created_at)
);

CREATE TABLE product_images (
  id UUID PRIMARY KEY,
  product_id UUID REFERENCES products(id),
  image_url TEXT NOT NULL,
  alt_text VARCHAR(255),
  display_order INT,
  created_at TIMESTAMP
);

CREATE TABLE product_variants (
  id UUID PRIMARY KEY,
  product_id UUID REFERENCES products(id),
  type VARCHAR(50),
  values JSON,
  created_at TIMESTAMP
);
```

### Cart Table
```sql
CREATE TABLE carts (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  status ENUM('active', 'converted', 'abandoned'),
  created_at TIMESTAMP,
  updated_at TIMESTAMP,
  expires_at TIMESTAMP,
  
  UNIQUE (user_id),
  INDEX (status),
  INDEX (expires_at)
);

CREATE TABLE cart_items (
  id UUID PRIMARY KEY,
  cart_id UUID REFERENCES carts(id),
  product_id UUID REFERENCES products(id),
  quantity INT NOT NULL,
  price DECIMAL(10, 2),
  variant_choices JSON,
  added_at TIMESTAMP
);
```

### Orders Table
```sql
CREATE TABLE orders (
  id UUID PRIMARY KEY,
  order_number VARCHAR(50) UNIQUE,
  user_id UUID REFERENCES users(id),
  status ENUM('pending_payment', 'processing', 'shipped', 'delivered', 'cancelled'),
  total DECIMAL(10, 2),
  tax DECIMAL(10, 2),
  shipping_cost DECIMAL(10, 2),
  discount DECIMAL(10, 2),
  grand_total DECIMAL(10, 2),
  shipping_address_id UUID,
  payment_id UUID,
  created_at TIMESTAMP,
  updated_at TIMESTAMP,
  estimated_delivery TIMESTAMP,
  
  INDEX (user_id),
  INDEX (status),
  INDEX (created_at)
);

CREATE TABLE order_items (
  id UUID PRIMARY KEY,
  order_id UUID REFERENCES orders(id),
  product_id UUID REFERENCES products(id),
  shop_id UUID REFERENCES shops(id),
  quantity INT,
  price DECIMAL(10, 2),
  subtotal DECIMAL(10, 2)
);
```

### Payments Table
```sql
CREATE TABLE payments (
  id UUID PRIMARY KEY,
  order_id UUID REFERENCES orders(id),
  user_id UUID REFERENCES users(id),
  amount DECIMAL(10, 2),
  currency VARCHAR(3) DEFAULT 'ETB',
  method ENUM('card', 'mobile_wallet', 'bank_transfer'),
  status ENUM('pending', 'completed', 'failed', 'refunded'),
  transaction_id VARCHAR(100),
  receipt_url TEXT,
  created_at TIMESTAMP,
  completed_at TIMESTAMP,
  
  INDEX (order_id),
  INDEX (user_id),
  INDEX (status)
);
```

## Order Processing Flow

```
1. USER ADDS ITEMS TO CART
   POST /api/cart/items
   → Items stored in cart
   → Cart total calculated

2. USER CHECKS OUT
   POST /api/orders
   → Validate cart
   → Create order record (status: pending_payment)
   → Reserve inventory
   → Generate payment URL

3. USER MAKES PAYMENT
   → Redirected to payment gateway
   → Payment processed
   → Webhook received

4. PAYMENT CONFIRMED
   → Order status: processing
   → Emit order:created event
   → Notification sent to seller
   → Cart cleared

5. SELLER PREPARES ITEM
   → Seller dashboard shows order
   → Seller packs item
   → Seller marks ready

6. ORDER HANDED TO DELIVERY
   → Delivery Service notified
   → Carrier assigned
   → Order status: shipped
   → Tracking provided

7. DELIVERY IN PROGRESS
   → Customer gets tracking updates
   → Real-time location

8. DELIVERY COMPLETE
   → Order status: delivered
   → Delivery confirmed
   → Customer review requested

9. SETTLEMENT
   → Seller payment processed
   → Transaction complete
```

## Inventory Management

### Stock Tracking
```javascript
// On product creation
stock: 100

// On order placed (before payment)
reserved_stock: 2
available_stock: 98

// On payment confirmed
stock: 98 (reserved deducted)

// On order cancelled
stock: 100 (reserved released)

// Low stock alert
if (stock < reorder_level) {
  notifySeller("Stock low: only X items remaining");
}
```

### Stock Validation
```javascript
// Before adding to cart
if (product.stock < quantity) {
  return error("Only X items available");
}

// Before order creation
if (product.stock < cartItem.quantity) {
  return error("Item out of stock");
}
```

## Pricing & Discounts

### Price Calculation
```javascript
const basePrice = product.price;
const discountAmount = (basePrice * product.discount) / 100;
const finalPrice = basePrice - discountAmount;

// Cart totals
subtotal = sum(items.finalPrice * quantity);
tax = subtotal * TAX_RATE;
shipping = calculateShipping(address);
coupon_discount = applyCoupon(code);
total = subtotal + tax + shipping - coupon_discount;
```

### Discount Types
- Fixed percentage (e.g., 10% off)
- Fixed amount (e.g., 500 ETB off)
- Time-limited (seasonal sales)
- Category-specific
- Coupon codes

## Payment Methods

### Supported Methods
1. **Card** (Visa, MasterCard)
   - Via payment gateway (Stripe, Flutterwave)
   - Secure tokenization
   
2. **Mobile Money** (Telebirr, MPesa)
   - SMS confirmation
   - Phone number verification
   
3. **Bank Transfer**
   - Manual verification
   - For large orders

## Service Integration

### With Identity Service
```
User registration → Identity Service
    ↓
Listen to user:created event
    ↓
Create buyer profile
Create empty cart
```

### With Delivery Service
```
Order payment confirmed → Commerce Service
    ↓
Emit order:paid event
    ↓
Delivery Service listens
    ↓
Create delivery order
Assign carrier
```

## Error Handling

```javascript
{
  "code": "PRODUCT_OUT_OF_STOCK",
  "message": "Only 5 items available",
  "status": 409,
  "availableQuantity": 5
}

{
  "code": "INVALID_CART",
  "message": "Cart is expired or invalid",
  "status": 400
}

{
  "code": "PAYMENT_FAILED",
  "message": "Payment could not be processed",
  "status": 402,
  "transactionId": "txn_123"
}

{
  "code": "COUPON_INVALID",
  "message": "Coupon code is not valid or has expired",
  "status": 400
}
```

## Monitoring & Analytics

### Metrics to Track
- Total orders per day/week/month
- Average order value
- Cart abandonment rate
- Payment success rate
- Top products
- Top sellers
- Refund rate
- Revenue by category

## Development

### Setup
```bash
npm install
npm run seed:test-data
npm run dev
```

### Testing
```bash
npm test
npm run test:integration
npm run test:payment-flow
```

### Environment Variables
```
MONGODB_URI=mongodb://localhost:27017/aritii_commerce
JWT_SECRET=your_secret_key
STRIPE_SECRET_KEY=sk_test_...
STRIPE_PUBLIC_KEY=pk_test_...
PAYMENT_GATEWAY_URL=https://...
DELIVERY_SERVICE_URL=http://delivery-service:3003
IDENTITY_SERVICE_URL=http://identity-service:3001
```

## Future Enhancements

- AI-powered recommendations
- Wishlist functionality
- Product reviews and ratings
- Seller ratings and trust score
- B2B wholesale ordering
- Subscription products
- Digital products (instant delivery)
- Advanced analytics and reporting
