# Backend Services - Docker Setup

**Complete Docker configuration for all backend services**

---

## ✅ Files Created

### Docker Configuration
- ✅ `Dockerfile` - Multi-stage Node.js build
- ✅ `docker-compose.yml` - All 6 services (MongoDB, Redis, 4 microservices)
- ✅ `.dockerignore` - Optimize build context
- ✅ `.env.example` - Environment variables template
- ✅ `Makefile` - Easy command shortcuts

### Database
- ✅ `scripts/mongo-init.js` - Database initialization with indexes

### Documentation
- ✅ `README-DOCKER.md` (this file)

---

## 🚀 QUICK START

### 1. Create Environment File
```bash
cp .env.example .env
```

### 2. Start All Services
```bash
docker-compose up -d
```

### 3. Check Health
```bash
make health
# Or:
curl http://localhost:3000/health
```

### 4. View Logs
```bash
docker-compose logs -f
# Or with Makefile:
make logs
```

---

## 📦 SERVICES INCLUDED

| Service | Port | Purpose |
|---------|------|---------|
| API Gateway | 3000 | Request routing, WebSocket |
| Commerce | 3001 | Products, orders, reviews |
| Delivery | 3002 | Delivery tracking |
| Identity | 3003 | Authentication, users |
| MongoDB | 27017 | Database |
| Redis | 6379 | Cache layer |

---

## 🛠️ MAKEFILE COMMANDS

### Start/Stop
```bash
make up              # Start all services
make down            # Stop all services
make restart         # Restart services
make clean           # Remove stopped containers
```

### Logs
```bash
make logs            # Follow all logs
make logs-prod       # Follow production services
make ps              # Show service status
make health          # Check service health
```

### Database
```bash
make db-shell        # Access MongoDB
make db-backup       # Backup database
make db-init         # Initialize database
```

### Development
```bash
make build           # Build images
make test            # Run tests
make dev             # Full dev setup
```

### Useful
```bash
make help            # Show all commands
make info            # Show config
make version         # Show versions
```

---

## 🔧 Docker Compose Commands

### Direct Commands
```bash
# Start
docker-compose up -d

# Stop
docker-compose stop

# View logs
docker-compose logs -f commerce-service

# Execute command
docker-compose exec api-gateway npm test

# Restart specific service
docker-compose restart commerce-service

# View status
docker-compose ps

# Full cleanup
docker-compose down -v
```

---

## 📊 Services Details

### MongoDB
- **Port:** 27017
- **Collections:** Users, Products, Orders, Reviews, Sellers, Deliveries, etc.
- **Indexes:** Auto-created on startup
- **Credentials:** admin/admin123 (change in production)
- **Backup location:** `backups/` folder

### Redis
- **Port:** 6379
- **Purpose:** Caching, sessions
- **Password:** redis123 (change in production)
- **Persistence:** Enabled (AOF)

### Services Network
- **Network Name:** aritii-network
- **Type:** Bridge network for service-to-service communication
- **Services can communicate:** commerce-service, delivery-service, identity-service, api-gateway

---

## 🔐 Production Setup

### Security Updates

1. **Update Passwords**
```bash
# Generate random passwords
MONGO_PASSWORD=$(openssl rand -hex 16)
REDIS_PASSWORD=$(openssl rand -hex 16)
JWT_SECRET=$(openssl rand -hex 32)

# Update .env file with strong values
```

2. **Update docker-compose.yml**
```bash
# Remove volume mounts for source code
# Add resource limits
# Set restart policies to 'no' for debugging
```

3. **Environment Variables**
```bash
NODE_ENV=production
LOG_LEVEL=warn
DEBUG=
```

---

## 🧪 Testing

### Health Checks
```bash
# API Gateway
curl http://localhost:3000/health

# Commerce
curl http://localhost:3001/health

# All services
make health
```

### API Testing
```bash
# Get products
curl http://localhost:3000/api/products

# Create product
curl -X POST http://localhost:3000/api/products \
  -H "Content-Type: application/json" \
  -d '{"name":"Test","price":99.99}'

# Test endpoints
make test-api
```

### Database Testing
```bash
# Access MongoDB
make db-shell

# Inside MongoDB:
use aritii
db.products.find().limit(5)
db.collections()
```

---

## 🆘 Troubleshooting

### Service Won't Start
```bash
# Check logs
docker-compose logs <service>

# Rebuild
docker-compose build --no-cache <service>

# Restart
docker-compose restart <service>
```

### Port Conflicts
```bash
# Check what's using port
lsof -i :3001

# Kill process
kill -9 <PID>
```

### Database Issues
```bash
# Check MongoDB
make db-shell
# Or:
docker-compose exec mongodb mongosh

# Verify connection in service logs
docker-compose logs commerce-service | grep -i mongo
```

### Memory Issues
```bash
# Check usage
docker-compose stats

# Cleanup
docker system prune -a --volumes
```

---

## 📋 Checklist Before Deployment

- [ ] `.env` file created with strong passwords
- [ ] All services start: `make up`
- [ ] Health checks pass: `make health`
- [ ] Database initialized: `make db-init`
- [ ] API endpoints working: `make test-api`
- [ ] Redis connected: `make redis-shell`
- [ ] Logs displaying correctly: `make logs`
- [ ] Services can communicate
- [ ] Volume mounts correct
- [ ] Backup strategy in place

---

## 📖 More Information

**Detailed Docker Guide:** See `DOCKER-SETUP-GUIDE.md` in guides folder

**Commands Reference:**
```bash
make help
```

**Docker Docs:** https://docs.docker.com/compose/

---

## ✅ Status

✓ Dockerfile created (multi-stage build)
✓ Docker Compose configured (all 6 services)
✓ MongoDB initialized with collections & indexes
✓ Redis cache configured
✓ Environment variables ready
✓ Makefile with 30+ helpful commands
✓ Ready for development & production

**Next:** `make up` to start all services
