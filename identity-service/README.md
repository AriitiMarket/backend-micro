# Identity Service

User authentication, authorization, and account management for Aritii Marketplace.

## Overview

The Identity Service handles user lifecycle management, authentication tokens, roles & permissions, and account operations. It's the single source of truth for user identity across the platform.

## Key Features

### Authentication
- Email/password registration and login
- JWT token generation and validation
- Refresh token management
- Session tracking
- Account lockout after failed attempts
- Password reset via email

### Authorization
- Role-based access control (RBAC)
- Permission management
- Scope-based authorization
- Admin approval workflows

### Account Management
- User profile management
- Email verification
- Password changes
- Account deactivation/deletion
- Login history tracking
- Device management

### Roles & Permissions

**Roles:**
- `BUYER` - Default role for all users, can purchase items
- `SELLER` - Approved sellers, can list and sell products
- `ADMIN` - Administrative access, approves sellers

**Permissions:**
- `user:create` - Create account
- `user:read` - View own profile
- `user:update` - Update own profile
- `seller:apply` - Apply to become seller
- `seller:approve` - Admin: approve seller applications
- `seller:manage` - Seller: manage own shop

## API Endpoints

### Authentication

```http
POST /api/auth/register
{
  "name": "John Doe",
  "email": "john@example.com",
  "password": "SecurePass123!"
}
Response: {
  "user": { "id", "name", "email", "role" },
  "token": "eyJhbGc...",
  "refreshToken": "refresh..."
}

POST /api/auth/login
{
  "email": "john@example.com",
  "password": "SecurePass123!"
}
Response: { "user", "token", "refreshToken" }

POST /api/auth/refresh
{
  "refreshToken": "refresh..."
}
Response: { "token" }

POST /api/auth/logout
Response: { "message": "Logged out" }
```

### User Management

```http
GET /api/users/:id
Response: {
  "id": "user_123",
  "name": "John Doe",
  "email": "john@example.com",
  "role": "BUYER",
  "createdAt": "2026-01-15T10:30:00Z",
  "lastLogin": "2026-09-15T03:40:00Z"
}

PATCH /api/users/:id
{
  "name": "Jane Doe",
  "phone": "+251911234567"
}
Response: { "user": { ... } }

POST /api/users/:id/password
{
  "currentPassword": "OldPass123!",
  "newPassword": "NewPass456!"
}
Response: { "message": "Password updated" }
```

### Seller Management

```http
POST /api/seller-application
{
  "businessName": "My Shop",
  "businessCategory": "Electronics",
  "description": "Quality electronics store"
}
Response: {
  "applicationId": "app_123",
  "status": "PENDING_REVIEW",
  "submittedAt": "2026-09-15T03:40:00Z"
}

GET /api/seller-application/:id
Response: {
  "id": "app_123",
  "userId": "user_123",
  "status": "PENDING_REVIEW",
  "businessInfo": { ... },
  "submittedAt": "2026-09-15T03:40:00Z"
}

POST /api/seller-application/:id/approve
Response: {
  "user": { "role": "SELLER", "shopId": "shop_123" },
  "message": "Seller application approved"
}

POST /api/seller-application/:id/reject
{
  "reason": "Documents incomplete"
}
Response: { "message": "Application rejected" }
```

### Admin Operations

```http
GET /api/admin/seller-applications?status=PENDING_REVIEW
Response: {
  "applications": [ ... ],
  "total": 15,
  "pending": 15
}

GET /api/admin/users?role=SELLER
Response: {
  "users": [ ... ],
  "total": 248,
  "filters": { "role": "SELLER" }
}

PATCH /api/admin/users/:id/role
{
  "role": "ADMIN"
}
Response: { "user": { ... } }
```

## Database Schema

### Users Table
```sql
CREATE TABLE users (
  id UUID PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('BUYER', 'SELLER', 'ADMIN') DEFAULT 'BUYER',
  status ENUM('active', 'inactive', 'suspended') DEFAULT 'active',
  phone VARCHAR(20),
  avatar_url TEXT,
  email_verified BOOLEAN DEFAULT FALSE,
  last_login TIMESTAMP,
  failed_login_attempts INT DEFAULT 0,
  locked_until TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  INDEX (email),
  INDEX (role),
  INDEX (created_at)
);
```

### Seller Applications Table
```sql
CREATE TABLE seller_applications (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  status ENUM('PENDING_REVIEW', 'APPROVED', 'REJECTED') DEFAULT 'PENDING_REVIEW',
  business_name VARCHAR(255) NOT NULL,
  business_category VARCHAR(100),
  description TEXT,
  phone VARCHAR(20),
  city VARCHAR(100),
  documents JSON,
  rejection_reason TEXT,
  submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  reviewed_at TIMESTAMP,
  reviewed_by UUID REFERENCES users(id),
  updated_at TIMESTAMP,
  
  INDEX (status),
  INDEX (user_id),
  INDEX (submitted_at)
);
```

### Sessions Table
```sql
CREATE TABLE sessions (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  refresh_token VARCHAR(500),
  device_info JSON,
  ip_address VARCHAR(45),
  user_agent TEXT,
  expires_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  INDEX (user_id),
  INDEX (expires_at)
);
```

## Authentication Flow

### Registration
```
1. User submits email/password
2. Validate input (strong password, unique email)
3. Hash password (bcrypt)
4. Create user record (role: BUYER by default)
5. Generate JWT token
6. Send verification email
7. Return token + refresh token
```

### Login
```
1. Verify email exists
2. Check if account is active
3. Verify password hash
4. Check login attempts (max 5)
5. Generate new session
6. Return JWT token
7. Record login timestamp
```

### Token Refresh
```
1. Validate refresh token
2. Check session expiry
3. Verify user still exists and is active
4. Generate new JWT token
5. Return new token
```

## JWT Token Structure

```javascript
// JWT Payload
{
  "sub": "user_123",           // Subject (user ID)
  "name": "John Doe",
  "email": "john@example.com",
  "role": "BUYER",
  "iat": 1694779200,           // Issued at
  "exp": 1694865600,           // Expires in 24 hours
  "aud": "aritii-marketplace"
}

// Token expiry
Access Token: 24 hours
Refresh Token: 30 days
```

## Seller Approval Workflow

### Application States
```
PENDING_REVIEW
    ↓
[Admin Reviews]
    ↓
    ├─→ APPROVED (user gets SELLER role + shopId)
    └─→ REJECTED (reason provided to user)

REJECTED
    ↓
User can reapply after 30 days
```

### Admin Actions
```http
1. List pending applications
   GET /api/admin/seller-applications?status=PENDING_REVIEW

2. Review application details
   GET /api/admin/seller-applications/:id

3. Approve
   POST /api/admin/seller-applications/:id/approve
   → Creates Shop record in Commerce Service
   → Activates SELLER role
   → Sends approval email

4. Reject
   POST /api/admin/seller-applications/:id/reject
   → Stores rejection reason
   → Sends rejection email
   → User can reapply later
```

## Security Features

### Password Security
- Minimum 8 characters
- Must include uppercase, lowercase, number, special character
- Hashed with bcrypt (salt rounds: 10)
- Never stored in plain text

### Account Protection
- Account lockout after 5 failed login attempts (30 min cooldown)
- Email verification required
- Suspicious login alerts
- Session invalidation on logout
- Automatic session expiry

### Token Security
- JWT signed with RS256
- Tokens include expiry
- Refresh tokens rotated on use
- Device fingerprinting in sessions

### Rate Limiting
- Login: 5 attempts per 15 minutes
- Registration: 3 per hour per IP
- Password reset: 1 per hour

## Service Integration

### With Commerce Service
```
User registration → Identity Service
    ↓
Send user event (user:created)
    ↓
Commerce Service listens
    ↓
Create buyer profile
```

### With Delivery Service
```
Seller approval → Identity Service
    ↓
Update user role to SELLER
    ↓
Create Shop in Commerce Service
    ↓
Delivery Service notified (shop:created)
```

## Error Handling

```javascript
// Common errors
{
  "code": "INVALID_CREDENTIALS",
  "message": "Email or password is incorrect",
  "status": 401
}

{
  "code": "EMAIL_ALREADY_EXISTS",
  "message": "An account with this email already exists",
  "status": 409
}

{
  "code": "ACCOUNT_LOCKED",
  "message": "Account is locked. Try again after 30 minutes",
  "status": 423
}

{
  "code": "INVALID_TOKEN",
  "message": "Token is invalid or expired",
  "status": 401
}

{
  "code": "UNAUTHORIZED",
  "message": "You do not have permission to access this resource",
  "status": 403
}
```

## Development

### Setup
```bash
npm install
npm run seed:test-users
npm run dev
```

### Testing
```bash
npm test
npm run test:integration
npm run test:e2e
```

### Environment Variables
```
DATABASE_URL=postgres://user:pass@localhost:5432/aritii_identity
JWT_SECRET=your_secret_key
JWT_EXPIRY=24h
REFRESH_TOKEN_EXPIRY=30d
EMAIL_SERVICE_URL=http://email-service:3001
ADMIN_EMAIL=admin@aritii.com
```

## Monitoring

- Track login success/failure rates
- Monitor account lockouts
- Alert on unusual access patterns
- Audit admin actions
- Log all authentication events

## Future Enhancements

- Two-factor authentication (2FA)
- OAuth2 / Social login
- Passwordless authentication
- Biometric login support
- Advanced fraud detection
- Geographic login restrictions
