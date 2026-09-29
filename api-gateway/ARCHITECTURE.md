# Aritii Market - Architecture & Design

## System Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     FRONTEND (Vite/React)                   │
│                   http://localhost:3000                     │
└─────────────────────────────┬───────────────────────────────┘
                              │
                    HTTP/REST │ CORS Enabled
                              │
┌─────────────────────────────┴───────────────────────────────┐
│              API GATEWAY (Node.js/Express)                  │
│                 http://localhost:8000/api                   │
│  Routes: JWT validation, header injection, request routing  │
└──────────┬──────────────────────────────────┬────────────────┘
           │                                  │
           │                                  │
    ┌──────▼──────────┐           ┌──────────▼──────┐
    │ IDENTITY SERVICE │           │ COMMERCE SERVICE │
    │  (Node/Express)  │           │  (Node/Express)  │
    │  :8001           │           │  :8002           │
    └──────┬──────────┘            └──────────┬──────┘
           │                                  │
    ┌──────▼──────────┐           ┌──────────▼──────┐
    │  PostgreSQL     │           │    MongoDB      │
    │  (Identity DB)  │           │ (Commerce DB)   │
    │  :5432          │           │  :27017         │
    └─────────────────┘           └─────────────────┘
```

## Services Architecture

### 1. API Gateway (Port 8000)

**Responsibilities:**
- JWT token verification and identity extraction
- Route forwarding to microservices
- Header injection (x-user-id, x-user-role, x-user-email)
- CORS management
- Error handling and response formatting

**Key Features:**
- Extracts JWT from cookies (token, seller_token)
- Injects identity headers to downstream services
- Handles multipart/form-data for file uploads
- Implements timeout and error recovery

**Routes:**
```
/api/user/*              → Identity Service
/api/seller-application  → Commerce Service
/api/product/*           → Commerce Service
/api/shop/*              → Commerce Service
/api/order/*             → Commerce Service
/api/cart/*              → Commerce Service
/api/wishlist/*          → Commerce Service
/api/internal/*          → Service-to-service only
```

### 2. Identity Service (Port 8001)

**Database:** PostgreSQL

**Responsibilities:**
- User registration and authentication
- JWT token generation
- User profile management
- Role management (CUSTOMER, SELLER, ADMIN, AGENT)
- Password encryption

**Tables:**
- `users` - User accounts with roles
- `addresses` - Buyer addresses
- `roles` - Role definitions
- `auth_logs` - Authentication history (optional)

**Key Endpoints:**
```
POST /user/create-user        - Register
POST /user/login-user         - Login
GET  /user/getuser            - Get profile
GET  /logout                  - Logout
PUT  /user/update-profile     - Update profile
POST /address/add             - Add address
GET  /address/list            - List addresses
```

**Authentication Flow:**
1. User registers with email/password
2. Password hashed with bcrypt
3. JWT signed with JWT_SECRET
4. Token returned to client
5. Token stored in cookie
6. Gateway extracts and injects as header

### 3. Commerce Service (Port 8002)

**Database:** MongoDB

**Responsibilities:**
- Product catalog management
- Shop/seller business management
- Order processing
- Cart management
- Seller application handling
- Inventory tracking

**Collections:**
- `products` - Product catalog
- `shops` - Seller businesses
- `orders` - Customer orders
- `carts` - Shopping carts
- `sellerapplications` - Seller onboarding
- `wishlist` - Saved products
- `reviews` - Product reviews
- `stockmovements` - Inventory history

**Key Endpoints:**
```
// Products
POST   /product/create-product
GET    /product/get-all-products
GET    /product/get-product/{id}
PUT    /product/update-product/{id}
DELETE /product/delete-shop-product/{id}

// Seller Applications
POST   /seller-application
GET    /seller-application
POST   /seller-application/{id}/approve
POST   /seller-application/{id}/reject

// Orders
POST   /order/create-order
GET    /order/get-all-orders/user/{userId}
GET    /order/get-all-orders/seller/{sellerId}
PUT    /order/update-order-status/{orderId}

// Shops
GET    /shop/get-shop-info/{id}
PUT    /shop/update-shop-info
PUT    /shop/update-shop-avatar

// Cart
GET    /cart
POST   /cart/add
PUT    /cart/update
DELETE /cart/remove
```

## Data Models

### User (Identity Service)

```json
{
  "id": "uuid",
  "email": "user@example.com",
  "password": "hashed-password",
  "name": "User Name",
  "role": "CUSTOMER|SELLER|ADMIN|AGENT",
  "avatar": {
    "public_id": "cloudinary-id",
    "url": "https://..."
  },
  "addresses": ["address-id-1", "address-id-2"],
  "shopId": "shop-id (if seller)",
  "status": "active|inactive|suspended",
  "sellerStatus": "INACTIVE|PENDING|APPROVED|REJECTED|SUSPENDED",
  "phoneNumber": "+251...",
  "isVerified": false,
  "createdAt": "2026-09-14T...",
  "updatedAt": "2026-09-14T...",
  "lastLogin": "2026-09-14T..."
}
```

### Product (Commerce Service)

```json
{
  "_id": "mongo-id",
  "name": "Product Name",
  "description": "Detailed description",
  "category": "Electronics",
  "tags": "tag1,tag2,tag3",
  "sku": "SKU-123",
  "originalPrice": 999.99,
  "discountPrice": 899.99,
  "stock": 100,
  "reserved": 5,
  "lowStockThreshold": 5,
  "images": ["url1", "url2"],
  "shopId": "shop-mongo-id",
  "shop": { /* full shop object */ },
  "sellerId": "user-id",
  "reviews": [
    {
      "user": { /* user object */ },
      "rating": 5,
      "comment": "Great product!",
      "productId": "product-id"
    }
  ],
  "ratings": 4.5,
  "sold_out": 50,
  "createdAt": "2026-09-14T...",
  "updatedAt": "2026-09-14T..."
}
```

### Order (Commerce Service)

```json
{
  "_id": "mongo-id",
  "customerId": "user-id",
  "sellerId": "seller-user-id",
  "cart": [
    {
      "_id": "product-id",
      "shopId": "shop-id",
      "qty": 1,
      "price": 899.99,
      "sellerId": "seller-id"
    }
  ],
  "shippingAddress": {
    "street": "Street Address",
    "city": "City",
    "country": "Country",
    "zipCode": "12345"
  },
  "totalPrice": 899.99,
  "status": "PENDING|CONFIRMED|PROCESSING|COMPLETED|CANCELLED",
  "paymentStatus": "PENDING|CONFIRMED",
  "paymentInfo": {
    "method": "stripe|paypal",
    "transactionId": "txn-id",
    "status": "confirmed"
  },
  "user": { /* buyer info */ },
  "paidAt": "2026-09-14T...",
  "deliveredAt": null,
  "createdAt": "2026-09-14T...",
  "updatedAt": "2026-09-14T..."
}
```

### Shop (Commerce Service)

```json
{
  "_id": "mongo-id",
  "name": "Shop Name",
  "description": "Shop description",
  "email": "shop@example.com",
  "ownerId": "user-id (seller)",
  "avatar": {
    "public_id": "cloudinary-id",
    "url": "https://..."
  },
  "address": "Shop address",
  "phoneNumber": "+251...",
  "zipCode": "12345",
  "role": "Seller",
  "availableBalance": 50000.00,
  "transections": ["txn-id-1", "txn-id-2"],
  "createdAt": "2026-09-14T...",
  "updatedAt": "2026-09-14T..."
}
```

### Seller Application (Commerce Service)

```json
{
  "_id": "mongo-id",
  "ownerId": "user-id",
  "sellerType": "INDIVIDUAL|BUSINESS",
  "status": "DRAFT|PENDING_REVIEW|APPROVED|REJECTED|SUSPENDED",
  "businessInformation": {
    "businessName": "Business Name",
    "businessDescription": "Description",
    "businessType": "GENERAL_MERCHANT",
    "businessPhone": "+251...",
    "businessEmail": "business@example.com",
    "businessWebsite": "https://..."
  },
  "shopInformation": {
    "shopName": "Shop Name",
    "shopDescription": "Shop description",
    "logo": { "public_id": "id", "url": "https://..." }
  },
  "location": {
    "country": "Ethiopia",
    "city": "Addis Ababa",
    "region": "Region",
    "zipCode": "12345"
  },
  "shopId": "shop-mongo-id (after approval)",
  "submittedAt": "2026-09-14T...",
  "reviewedAt": "2026-09-14T...",
  "reviewedBy": "admin-user-id",
  "review": { "approved": true, "reason": "..." },
  "createdAt": "2026-09-14T...",
  "updatedAt": "2026-09-14T..."
}
```

## Authentication Flow

```
┌──────────────┐
│   Frontend   │
└──────┬───────┘
       │ 1. POST /api/user/create-user
       │    { email, password, name }
       │
       ├──────────────────────────────────┐
       │                                  │
       │ API Gateway                      │
       │ - Extract auth (none yet)        │
       │ - Route to Identity              │
       │                                  │
       │ Identity Service                 │
       │ - Validate email (unique)        │
       │ - Hash password with bcrypt      │
       │ - Create user with CUSTOMER role │
       │ - Sign JWT token                 │
       │                                  │
       │ Return JWT                       │
       │                                  │
       └──────┬───────────────────────────┘
              │ 2. Response
              │ { token, user }
              │
       ┌──────▼────────┐
       │ Store JWT in: │
       │ - Cookie      │
       │ - localStorage│
       │ - Header      │
       └───────────────┘
       │
       │ 3. Subsequent requests with JWT
       │    Authorization: Bearer {token}
       │    Cookie: token={token}
       │
       ├──────────────────────────────────┐
       │                                  │
       │ API Gateway                      │
       │ - Extract token from cookie      │
       │ - Verify JWT signature           │
       │ - Decode JWT                     │
       │ - Extract user data:             │
       │   - id (user ID)                 │
       │   - role (CUSTOMER|SELLER|ADMIN) │
       │   - email                        │
       │ - Inject headers:                │
       │   - x-user-id                    │
       │   - x-user-role                  │
       │   - x-user-email                 │
       │ - Forward to service             │
       │                                  │
       │ Service (Commerce/Identity)      │
       │ - Read headers (no JWT parsing)  │
       │ - Use headers for auth/z         │
       │ - Return data                    │
       │                                  │
       └──────┬───────────────────────────┘
              │ 4. Response
              │ { success, data }
              │
       ┌──────▼────────┐
       │ Display data  │
       │ or error      │
       └───────────────┘
```

## Authorization Flow

```
Request arrives at service with headers:
  x-user-id: user-123
  x-user-role: SELLER

┌─────────────────────────────────┐
│ Middleware: authenticate()      │
├─────────────────────────────────┤
│ 1. Read x-user-id header        │
│ 2. If found:                    │
│    - Set req.user.id            │
│    - Set req.user.role          │
│    - Allow next()               │
│ 3. If not found:                │
│    - Return 401 Unauthorized    │
└─────────────────────────────────┘
       │
       ├─ PASS ─┐
       │        │
    ┌──▼──────────────────┐
    │ Middleware:         │
    │ authorize('SELLER') │
    ├─────────────────────┤
    │ Check req.user.role │
    │ if role === 'SELLER'│
    │   → next()          │
    │ else                │
    │   → 403 Forbidden   │
    └─────────────────────┘
       │
       └─ PASS ─→ Controller logic
                 (may have ownership check)
                 
Ownership check example:
  if (product.sellerId !== req.user.id)
    return 403 Forbidden
```

## Workflow: Buyer Becomes Seller

```
1. Register (CUSTOMER role)
   POST /user/create-user
   ├─ Create user in Identity DB
   ├─ Role: CUSTOMER
   ├─ sellerStatus: INACTIVE
   └─ Return JWT token

2. Apply as Seller (POST /seller-application)
   ├─ Create application in Commerce DB
   ├─ status: DRAFT (if no submit flag)
   ├─ status: PENDING_REVIEW (if submit: true)
   ├─ Cannot create products yet (403)
   └─ Awaits admin review

3. Admin Approves (POST /seller-application/{id}/approve)
   ├─ Update application status: APPROVED
   ├─ Create Shop in Commerce DB
   ├─ Link shop to seller (ownerId)
   ├─ Call Identity Service: grant SELLER role
   │  POST /internal/sellers/upgrade-role
   │  - Update user role: CUSTOMER → SELLER
   │  - Update sellerStatus: INACTIVE → APPROVED
   └─ Application stores shopId

4. Seller Re-login (POST /user/login-user)
   ├─ Fresh JWT with role: SELLER
   ├─ Gateway injects x-user-role: SELLER
   ├─ Commerce validates role for seller endpoints
   └─ Can now create products

5. Create Product (POST /product/create-product)
   ├─ Middleware checks role: SELLER ✓
   ├─ Middleware checks shopId ownership
   ├─ Create product document
   ├─ Link to shop & seller
   ├─ Initialize stock & pricing
   └─ Product appears in marketplace
```

## Security Measures

### Authentication
- JWT tokens with 7-day expiry
- Passwords hashed with bcrypt
- Token verification on every request
- Secure cookie storage (httpOnly)

### Authorization
- Role-based access control (RBAC)
- Ownership checks (users can only manage own data)
- Header-based authorization (no repeated JWT parsing)
- Admin-only endpoints properly guarded

### Data Protection
- Email uniqueness enforced
- Input validation on all endpoints
- Duplicate email rejection
- No sensitive data in error messages

### API Security
- CORS properly configured
- No service-to-service URLs exposed
- Internal endpoints restricted
- Rate limiting ready (not implemented)

## Deployment Checklist

- [ ] Update JWT_SECRET (production value)
- [ ] Enable HTTPS on all services
- [ ] Configure production database URLs
- [ ] Set CORS_ORIGIN to production frontend
- [ ] Enable rate limiting
- [ ] Set up monitoring and logging
- [ ] Configure email service (optional)
- [ ] Set up backup strategy
- [ ] Enable database encryption
- [ ] Configure CDN for static assets
- [ ] Set up health checks
- [ ] Configure auto-scaling

## Performance Considerations

- Database indexing on frequently queried fields
- JWT validation cached where possible
- Connection pooling for database
- Caching layer for product listings (optional)
- CDN for product images
- Load balancing across service instances

## Extensibility

The architecture supports adding new services:
1. Create new service (Node.js/Express)
2. Add routes prefix to API Gateway
3. Add authentication middleware
4. Update routing rules in gateway
5. Document new endpoints in API.md
