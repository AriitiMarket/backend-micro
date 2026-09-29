# API Gateway

Central entry point and reverse proxy for ARITII marketplace microservices.

## Overview

The API Gateway:
- Routes requests to appropriate microservices
- Validates and verifies JWT tokens
- Manages CORS (Cross-Origin Resource Sharing)
- Handles authentication headers
- Provides internal service-to-service communication
- Rate limiting and request logging

## Architecture

```
Client (Frontend/Mobile)
        │
        │ HTTP/HTTPS
        ↓
API Gateway (Port 8000)
│
├─→ [/api/...] Public & Protected Endpoints
│   ├─→ /user/* → Identity Service (8001)
│   ├─→ /products/* → Commerce Service (8002)
│   ├─→ /shops/* → Commerce Service (8002)
│   └─→ /orders/* → Commerce Service (8002)
│
└─→ [/internal/...] Internal Service-Only Endpoints
    ├─→ /internal/users/* → Identity Service (8001)
    └─→ /internal/sellers/* → Identity Service (8001)

Environment:
- Node.js + Express
- No database (proxy only)
- JWT validation
- CORS middleware
```

## Prerequisites

- Node.js >= 18
- npm or yarn
- Identity Service running on 8001
- Commerce Service running on 8002

## Installation

```bash
cd api-gateway

# Install dependencies
npm install

# Create .env file
cp .env.example .env

# Set environment variables
IDENTITY_SERVICE_URL=http://localhost:8001
COMMERCE_SERVICE_URL=http://localhost:8002
JWT_SECRET=your_shared_secret
```

## Environment Variables

```
PORT=8000
NODE_ENV=development
IDENTITY_SERVICE_URL=http://identity-service:8001
COMMERCE_SERVICE_URL=http://commerce-service:8002
JWT_SECRET=shared_secret_key_128_chars_min
CORS_ORIGIN=http://localhost:3000,https://aritii.com
LOG_LEVEL=info # info, warn, error, debug
```

## Running

### Development
```bash
npm run dev
```

### Production
```bash
npm start
```

Gateway runs on `http://localhost:8000`

## Request Flow

### Public/Protected Requests
```
Client Request (with token)
    ↓
API Gateway
├─ Validate JWT signature
├─ Check token expiration
├─ Add Authorization header
└─ Forward to microservice
    ↓
Microservice Response
    ↓
Return to Client
```

### Internal Service Requests
```
Commerce Service
    ↓
API Gateway
├─ Check X-Internal-Token header
├─ Verify token matches JWT_SECRET
├─ Forward to Identity Service
    ↓
Identity Service Response
    ↓
Back to Commerce Service
```

## API Routes

### Public Routes (No Auth Required)

```
GET    /api/products
GET    /api/products/{id}
GET    /api/categories
GET    /api/shops
GET    /api/shops/{id}
POST   /auth/register
POST   /user/login-user
GET    /logout
```

### Protected Routes (Auth Required)

```
GET    /api/user/getuser
PUT    /api/user/update-user-info
POST   /api/user/update-avatar
GET    /api/cart
POST   /api/cart/add
DELETE /api/cart/remove/{id}
PUT    /api/cart/update
POST   /api/checkout
GET    /api/orders
GET    /api/orders/{id}
GET    /api/orders/{id}/track
```

### Seller Routes (Auth + SELLER Role)

```
GET    /api/dashboard
GET    /api/dashboard/products
POST   /api/dashboard/products
PUT    /api/dashboard/products/{id}
DELETE /api/dashboard/products/{id}
GET    /api/dashboard/orders
PUT    /api/dashboard/orders/{id}/status
```

### Admin Routes (Auth + ADMIN Role)

```
GET    /api/seller-application
POST   /api/seller-application/{id}/approve
POST   /api/seller-application/{id}/reject
```

### Internal Routes (X-Internal-Token Required)

```
POST   /internal/sellers/create
POST   /internal/sellers/link-shop
POST   /internal/sellers/grant-role
POST   /internal/sellers/set-status
POST   /internal/sellers/suspend
POST   /internal/sellers/reactivate
```

## Security

### Authentication

#### JWT Token Validation
- Token extracted from `Authorization: Bearer <token>` header or `token` cookie
- Signature verified with `JWT_SECRET`
- Expiration checked
- Claims extracted and added to request context

#### Token in Cookie
```javascript
// Client sends:
Cookie: token=eyJhbGciOiJIUzI1NiIs...

// Gateway validates and uses for authentication
```

#### Token in Header
```javascript
// Client sends:
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...

// Gateway validates and uses for authentication
```

### Internal Service Authentication

```javascript
// Commerce Service calls Identity Service:
X-Internal-Token: {shared_JWT_SECRET}

// Gateway verifies token matches JWT_SECRET
// Only allows /internal/* routes between services
```

### CORS (Cross-Origin Resource Sharing)

```javascript
// Configured origins:
CORS_ORIGIN=http://localhost:3000,https://aritii.com

// Allowed methods: GET, POST, PUT, DELETE, OPTIONS
// Allowed headers: Content-Type, Authorization
// Credentials: true (cookies allowed)
```

## Development

### Project Structure
```
api-gateway/
├── src/
│  ├── middleware/
│  │  ├── authenticate.js    # JWT validation
│  │  ├── cors.js           # CORS configuration
│  │  ├── internalOnly.js   # X-Internal-Token check
│  │  └── errorHandler.js   # Global error handling
│  ├── proxies/
│  │  ├── identity.proxy.js  # Forward to Identity Service
│  │  └── commerce.proxy.js  # Forward to Commerce Service
│  ├── config/
│  │  └── env.js            # Environment variables
│  ├── utils/
│  │  ├── jwt.js           # JWT utilities
│  │  └── response.js      # Response formatting
│  ├── routes.js           # Route definitions
│  ├── app.js              # Express setup
│  └── server.js           # Entry point
└── package.json
```

### Key Middleware

#### Authentication Middleware
```javascript
// Validates JWT token
// Extracts user claims
// Adds user to request context

app.use('/api', authenticateToken);
```

#### Internal Token Middleware
```javascript
// Checks X-Internal-Token header
// Verifies token matches JWT_SECRET
// Allows only internal services

app.use('/internal', requireInternalToken);
```

#### Error Handler
```javascript
// Catches all errors
// Returns consistent error format
// Logs errors for debugging
```

## Request/Response Format

### Success Response
```javascript
{
  "status": 200,
  "data": { /* response data */ },
  "message": "Success"
}
```

### Error Response
```javascript
{
  "status": 400,
  "error": "ERROR_CODE",
  "message": "Error description"
}
```

### Examples

#### Login Request
```
POST http://localhost:8000/api/user/login-user
Content-Type: application/json

{
  "email": "seller@test.com",
  "password": "seller123"
}

Response 200:
{
  "user": {
    "id": "uuid",
    "email": "seller@test.com",
    "sellerStatus": "APPROVED",
    "role": "SELLER"
  },
  "token": "eyJhbGciOiJIUzI1NiIs..."
}

Cookie: token=eyJhbGciOiJIUzI1NiIs...
```

#### Protected Request
```
GET http://localhost:8000/api/user/getuser
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
Cookie: token=eyJhbGciOiJIUzI1NiIs...

Response 200:
{
  "user": {
    "id": "uuid",
    "name": "Seller Name",
    "email": "seller@test.com",
    "role": "SELLER",
    "sellerStatus": "APPROVED"
  }
}
```

#### Internal Service Request
```
POST http://localhost:8000/api/internal/sellers/grant-role
X-Internal-Token: shared_jwt_secret_key
Content-Type: application/json

{
  "userId": "user-uuid"
}

Response 200:
{
  "user": { updated user object }
}
```

## Debugging

### Enable Verbose Logging
```bash
LOG_LEVEL=debug npm start
```

### Check Proxy Targets
```bash
curl -I http://localhost:8000/api/products
# Should proxy to http://localhost:8002/api/products
```

### Verify Token Validation
```bash
# Without token
curl http://localhost:8000/api/user/getuser
# → 401 Unauthorized

# With valid token
curl -H "Authorization: Bearer <token>" http://localhost:8000/api/user/getuser
# → 200 OK with user data
```

### Test Internal Route
```bash
curl -X POST http://localhost:8000/api/internal/sellers/grant-role \
  -H "X-Internal-Token: <JWT_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{"userId": "uuid"}'
```

## Common Issues

### 401 Unauthorized
**Problem**: Token is missing or invalid

**Solution**:
- Check token is in Authorization header or cookie
- Verify token is not expired
- Ensure JWT_SECRET matches across services
- Check token format is correct

### 403 Forbidden
**Problem**: User lacks required role

**Solution**:
- Check user role is SELLER or ADMIN
- Verify sellerStatus is APPROVED for seller routes
- Check route requires correct role

### 502 Bad Gateway
**Problem**: Microservice is down or unreachable

**Solution**:
- Check Identity Service running: `curl http://localhost:8001`
- Check Commerce Service running: `curl http://localhost:8002`
- Verify service URLs in .env
- Check network connectivity

### CORS Error
**Problem**: Frontend blocked by CORS

**Solution**:
- Check CORS_ORIGIN includes frontend URL
- Verify credentials: true is set
- Check request includes required headers

## Performance

### Connection Pooling
- HTTP keep-alive enabled
- Connection reuse to microservices
- Request/response streaming

### Caching
- No caching at gateway level
- Microservices handle caching
- Token validation cached briefly

## Deployment

### Docker
```bash
docker build -t aritii-gateway:latest .
docker run \
  -e IDENTITY_SERVICE_URL=http://identity-service:8001 \
  -e COMMERCE_SERVICE_URL=http://commerce-service:8002 \
  -e JWT_SECRET=... \
  -p 8000:8000 \
  aritii-gateway
```

### Environment Setup
1. Set IDENTITY_SERVICE_URL
2. Set COMMERCE_SERVICE_URL
3. Set JWT_SECRET (min 32 chars)
4. Set CORS_ORIGIN for frontend
5. Start gateway

### Behind Reverse Proxy (Nginx)
```nginx
upstream api_gateway {
  server localhost:8000;
}

server {
  listen 443 ssl http2;
  server_name api.aritii.com;

  ssl_certificate /path/to/cert.pem;
  ssl_certificate_key /path/to/key.pem;

  location / {
    proxy_pass http://api_gateway;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

## Monitoring

### Health Check
```bash
curl http://localhost:8000/health
# 200 OK { "status": "healthy" }
```

### Service Status
```bash
# Check if routing works
curl http://localhost:8000/api/products
# Should return product list
```

## Support

- For Identity Service issues, see `identity-service/README.md`
- For Commerce Service issues, see `commerce-service/README.md`
- For architecture details, see `docs/ARCHITECTURE.md`

## License

ARITII Marketplace © 2024
