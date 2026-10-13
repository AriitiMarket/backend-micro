.PHONY: help up down restart logs build test clean env

help:
	@echo "Aritii Backend Services - Docker Commands"
	@echo "==========================================="
	@echo ""
	@echo "Quick Start:"
	@echo "  make env          - Create .env file from example"
	@echo "  make up           - Start all services"
	@echo "  make down         - Stop all services"
	@echo "  make restart      - Restart all services"
	@echo ""
	@echo "Logs & Monitoring:"
	@echo "  make logs         - View all logs (follow mode)"
	@echo "  make logs-prod    - View production logs"
	@echo "  make logs-db      - View database logs"
	@echo "  make logs-redis   - View Redis logs"
	@echo "  make ps           - Show service status"
	@echo "  make stats        - Show resource usage"
	@echo ""
	@echo "Database:"
	@echo "  make db-shell     - Access MongoDB shell"
	@echo "  make db-backup    - Backup MongoDB"
	@echo "  make db-restore   - Restore MongoDB"
	@echo "  make db-init      - Initialize database"
	@echo ""
	@echo "Cache:"
	@echo "  make redis-shell  - Access Redis CLI"
	@echo "  make redis-flush  - Flush Redis cache"
	@echo ""
	@echo "Development:"
	@echo "  make build        - Build Docker images"
	@echo "  make clean        - Remove stopped containers"
	@echo "  make test         - Run tests in container"
	@echo "  make lint         - Run linter"
	@echo ""
	@echo "Services:"
	@echo "  make start-commerce   - Start commerce service"
	@echo "  make start-delivery   - Start delivery service"
	@echo "  make start-identity   - Start identity service"
	@echo "  make start-gateway    - Start API gateway"
	@echo ""
	@echo "Health:"
	@echo "  make health       - Check service health"
	@echo "  make test-api     - Test API endpoints"

# Quick start
env:
	@test -f .env || cp .env.example .env
	@echo "✓ Created .env file"

up:
	docker-compose up -d
	@echo "✓ Services started"
	@sleep 5
	@make health

down:
	docker-compose down
	@echo "✓ Services stopped"

restart:
	docker-compose restart
	@echo "✓ Services restarted"

# Logs
logs:
	docker-compose logs -f

logs-prod:
	docker-compose logs -f commerce-service delivery-service identity-service api-gateway

logs-db:
	docker-compose logs -f mongodb

logs-redis:
	docker-compose logs -f redis

ps:
	docker-compose ps

stats:
	docker-compose stats

# Database
db-shell:
	docker-compose exec mongodb mongosh

db-backup:
	@mkdir -p backups
	@docker-compose exec mongodb mongodump --archive > backups/backup-$$(date +%Y%m%d-%H%M%S).archive
	@echo "✓ Backup created"

db-restore:
	@test -f backups/backup.archive || { echo "No backup file found"; exit 1; }
	docker-compose exec mongodb mongorestore --archive < backups/backup.archive
	@echo "✓ Backup restored"

db-init:
	docker-compose exec mongodb mongosh /docker-entrypoint-initdb.d/init.js
	@echo "✓ Database initialized"

# Cache
redis-shell:
	docker-compose exec redis redis-cli

redis-flush:
	docker-compose exec redis redis-cli FLUSHALL
	@echo "✓ Redis cache flushed"

# Build
build:
	docker-compose build --no-cache
	@echo "✓ Images built"

build-fast:
	docker-compose build
	@echo "✓ Images built (with cache)"

# Cleanup
clean:
	docker-compose down -v
	docker image prune -af
	docker volume prune -af
	@echo "✓ Cleaned up containers and images"

# Testing
test:
	docker-compose exec api-gateway npm test
	@echo "✓ Tests completed"

test-services:
	docker-compose exec commerce-service npm test
	docker-compose exec delivery-service npm test
	docker-compose exec identity-service npm test
	docker-compose exec api-gateway npm test
	@echo "✓ All service tests completed"

lint:
	docker-compose exec api-gateway npm run lint
	@echo "✓ Linting completed"

# Individual services
start-commerce:
	docker-compose up -d commerce-service
	@echo "✓ Commerce service started"

start-delivery:
	docker-compose up -d delivery-service
	@echo "✓ Delivery service started"

start-identity:
	docker-compose up -d identity-service
	@echo "✓ Identity service started"

start-gateway:
	docker-compose up -d api-gateway
	@echo "✓ API gateway started"

# Health checks
health:
	@echo "Checking service health..."
	@curl -s http://localhost:3000/health | jq '.' || echo "API Gateway: ✗ Not responding"
	@curl -s http://localhost:3001/health | jq '.' || echo "Commerce: ✗ Not responding"
	@curl -s http://localhost:3002/health | jq '.' || echo "Delivery: ✗ Not responding"
	@curl -s http://localhost:3003/health | jq '.' || echo "Identity: ✗ Not responding"
	@echo ""
	@echo "Database check:"
	@docker-compose exec -T mongodb mongosh --eval "db.adminCommand({ping:1})" 2>/dev/null && echo "MongoDB: ✓ Connected" || echo "MongoDB: ✗ Not responding"
	@echo ""
	@echo "Cache check:"
	@docker-compose exec -T redis redis-cli ping 2>/dev/null && echo "Redis: ✓ Connected" || echo "Redis: ✗ Not responding"

test-api:
	@echo "Testing API endpoints..."
	@echo ""
	@echo "1. Get Products:"
	@curl -s http://localhost:3000/api/products | jq '.' || echo "Failed"
	@echo ""
	@echo "2. Health Check:"
	@curl -s http://localhost:3000/health | jq '.'
	@echo ""
	@echo "3. Gateway Status:"
	@curl -s http://localhost:3000 | jq '.' || echo "No response"

# Development helpers
logs-tail:
	@read -p "How many lines? (default: 50): " lines; \
	docker-compose logs --tail=$${lines:-50}

exec-commerce:
	docker-compose exec commerce-service sh

exec-delivery:
	docker-compose exec delivery-service sh

exec-identity:
	docker-compose exec identity-service sh

exec-gateway:
	docker-compose exec api-gateway sh

exec-db:
	docker-compose exec mongodb mongosh

# Info
info:
	@echo "=== Docker Compose Configuration ==="
	docker-compose config

version:
	@echo "Docker versions:"
	@docker --version
	@docker-compose --version
	@docker-compose exec -T api-gateway node --version 2>/dev/null || echo "Node: Not available"

# Monitoring
monitor:
	watch -n 1 'docker-compose ps'

prune:
	docker system prune -a --volumes
	@echo "✓ System pruned"

# Common workflows
dev: env up health
	@echo "✓ Development environment ready"

prod-build:
	docker-compose build
	@echo "✓ Production build complete"

full-restart: down up health
	@echo "✓ Full restart complete"

db-reset: db-backup
	docker-compose exec mongodb mongosh << EOF
use aritii
db.dropDatabase()
EOF
	@make db-init
	@echo "✓ Database reset complete"
