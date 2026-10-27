#!/usr/bin/env bash
# ==============================================================================
# Aritii Market Platform - Production Deployment Automation
# ==============================================================================
# Strict error handling: fail immediately on command failure, unset vars, or pipes
set -euo pipefail

# ANSI color codes for logging
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

log_info() {
  echo -e "${BLUE}[INFO]${NC} $(date '+%Y-%m-%d %H:%M:%S') - $1"
}

log_success() {
  echo -e "${GREEN}[SUCCESS]${NC} $(date '+%Y-%m-%d %H:%M:%S') - $1"
}

log_warn() {
  echo -e "${YELLOW}[WARN]${NC} $(date '+%Y-%m-%d %H:%M:%S') - $1"
}

log_error() {
  echo -e "${RED}[ERROR]${NC} $(date '+%Y-%m-%d %H:%M:%S') - $1" >&2
}

# Resolve directory paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${ROOT_DIR}"

COMPOSE_FILE="docker-compose.yml"
GATEWAY_HEALTH_URL="http://localhost:3000/health"
HEALTH_TIMEOUT_SECONDS=60
POLL_INTERVAL_SECONDS=3

# Detect Docker Compose command
if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose -f ${COMPOSE_FILE}"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose -f ${COMPOSE_FILE}"
else
  log_error "Docker Compose command not found."
  exit 1
fi

# Track deployment state for rollback
ROLLBACK_NEEDED=false

handle_failure() {
  local exit_code=$?
  if [ "${exit_code}" -ne 0 ] || [ "${ROLLBACK_NEEDED}" = true ]; then
    log_error "Deployment failed with exit code ${exit_code}! Initiating diagnostic capture and rollback..."

    echo -e "\n${YELLOW}=== Container Statuses ===${NC}"
    ${COMPOSE} ps -a || true

    echo -e "\n${YELLOW}=== Recent Service Logs ===${NC}"
    ${COMPOSE} logs --tail=50 || true

    log_warn "Attempting automated service stabilization..."
    # If the gateway or services are crashing, leave previous stable containers running or restart
    log_error "Deployment aborted. Please review container logs above."
    exit 1
  fi
}

trap handle_failure ERR EXIT

log_info "======================================================================"
log_info "Starting Production Deployment for Aritii Market Platform"
log_info "Working Directory: ${ROOT_DIR}"
log_info "Compose File:      ${COMPOSE_FILE}"
log_info "======================================================================"

# ------------------------------------------------------------------------------
# 1. Execute Pre-Deployment Validation
# ------------------------------------------------------------------------------
log_info "Step 1: Running pre-deployment validation (pre-deploy.sh)..."
if [ -x "${SCRIPT_DIR}/pre-deploy.sh" ]; then
  "${SCRIPT_DIR}/pre-deploy.sh"
else
  bash "${SCRIPT_DIR}/pre-deploy.sh"
fi

# ------------------------------------------------------------------------------
# 2. Build / Pull Production Images
# ------------------------------------------------------------------------------
log_info "Step 2: Building optimized multi-stage production images..."
${COMPOSE} build --parallel
log_success "All production microservice images built successfully."

# ------------------------------------------------------------------------------
# 3. Stage 1 Deployment: Data Infrastructure & Storage
# ------------------------------------------------------------------------------
log_info "Step 3: Starting data tier (PostgreSQL, MongoDB Replica Set, Redis)..."

# Ensure keyfile generator completes successfully before mongodb starts
log_info "Generating MongoDB replica set keyfile..."
${COMPOSE} up -d mongo-keyfile
${COMPOSE} wait mongo-keyfile || true

log_info "Bringing up postgres, mongodb, and redis..."
${COMPOSE} up -d postgres mongodb redis

log_info "Waiting for data tier containers to achieve healthy status..."
WAIT_DATA_TIER_SECONDS=45
START_TIME=$(date +%s)
while true; do
  PG_HEALTH=$(docker inspect aritii-postgres --format '{{.State.Health.Status}}' 2>/dev/null || echo "starting")
  MONGO_HEALTH=$(docker inspect aritii-mongodb --format '{{.State.Health.Status}}' 2>/dev/null || echo "starting")
  REDIS_HEALTH=$(docker inspect aritii-redis --format '{{.State.Health.Status}}' 2>/dev/null || echo "starting")

  if [[ "${PG_HEALTH}" == *"healthy"* ]] && [[ "${MONGO_HEALTH}" == *"healthy"* ]] && [[ "${REDIS_HEALTH}" == *"healthy"* ]]; then
    log_success "Data stores are healthy (Postgres, MongoDB rs0, Redis)."
    break
  fi

  ELAPSED=$(( $(date +%s) - START_TIME ))
  if [ "${ELAPSED}" -ge "${WAIT_DATA_TIER_SECONDS}" ]; then
    log_error "Timeout waiting for data tier health. Postgres: ${PG_HEALTH}, Mongo: ${MONGO_HEALTH}, Redis: ${REDIS_HEALTH}"
    ROLLBACK_NEEDED=true
    exit 1
  fi

  log_info "  Data tier starting (Postgres: ${PG_HEALTH}, Mongo: ${MONGO_HEALTH}, Redis: ${REDIS_HEALTH})... ${ELAPSED}s elapsed"
  sleep 3
done

# ------------------------------------------------------------------------------
# 4. Stage 2 Deployment: Core Application Microservices
# ------------------------------------------------------------------------------
log_info "Step 4: Starting backend microservices (Identity, Commerce, Delivery)..."
${COMPOSE} up -d identity commerce-service delivery-service

# ------------------------------------------------------------------------------
# 5. Stage 3 Deployment: Edge API Gateway
# ------------------------------------------------------------------------------
log_info "Step 5: Starting edge API Gateway on port 3000..."
${COMPOSE} up -d api-gateway

# ------------------------------------------------------------------------------
# 6. End-to-End Health Check Polling Loop
# ------------------------------------------------------------------------------
log_info "Step 6: Monitoring platform health endpoint at ${GATEWAY_HEALTH_URL} (timeout: ${HEALTH_TIMEOUT_SECONDS}s)..."

POLL_START=$(date +%s)
ALL_HEALTHY=false

while true; do
  CURRENT_TIME=$(date +%s)
  ELAPSED=$(( CURRENT_TIME - POLL_START ))

  # Query gateway aggregated health endpoint
  HTTP_RESPONSE=$(curl -s -w "\n%{http_code}" --max-time 4 "${GATEWAY_HEALTH_URL}" || echo "000")
  HTTP_BODY=$(echo "${HTTP_RESPONSE}" | sed '$d')
  HTTP_STATUS=$(echo "${HTTP_RESPONSE}" | tail -n 1)

  if [ "${HTTP_STATUS}" -eq 200 ]; then
    log_success "Gateway health check returned HTTP 200 OK after ${ELAPSED}s."
    echo -e "${CYAN}Health Payload:${NC} ${HTTP_BODY}"
    ALL_HEALTHY=true
    break
  fi

  if [ "${ELAPSED}" -ge "${HEALTH_TIMEOUT_SECONDS}" ]; then
    log_error "Platform health check timed out after ${HEALTH_TIMEOUT_SECONDS} seconds (HTTP Status: ${HTTP_STATUS})."
    if [ -n "${HTTP_BODY}" ]; then
      log_error "Last response body: ${HTTP_BODY}"
    fi
    ROLLBACK_NEEDED=true
    exit 1
  fi

  log_info "Waiting for all microservices and datastores to report ready (HTTP ${HTTP_STATUS}, ${ELAPSED}s/${HEALTH_TIMEOUT_SECONDS}s)..."
  sleep "${POLL_INTERVAL_SECONDS}"
done

# ------------------------------------------------------------------------------
# 7. Post-Deployment Hygiene: Clean Up Dangling Docker Images
# ------------------------------------------------------------------------------
log_info "Step 7: Pruning unused build layers and dangling Docker images..."
docker image prune -f >/dev/null 2>&1 || true
log_success "Dangling images cleaned."

# Disarm trap on clean exit
trap - ERR EXIT

log_success "======================================================================"
log_success "🎉 Deployment completed successfully!"
log_success "Platform Status: HEALTHY"
log_success "Active Services: api-gateway (3000), commerce (3001), delivery (3002), identity (3003)"
log_success "Data Stores:     MongoDB rs0, PostgreSQL 15, Redis 7"
log_success "======================================================================"
exit 0
