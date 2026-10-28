#!/usr/bin/env bash
# ==============================================================================
# Aritii Market Platform - Deployment Preflight Validation & Initialization
# ==============================================================================
# Strict error handling: fail immediately on command failure, unset vars, or pipes
set -euo pipefail

# ANSI color codes for legible output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
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

# Resolve repository root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${ROOT_DIR}"

log_info "Starting pre-deployment validation for Aritii Market Platform at: ${ROOT_DIR}"

# ------------------------------------------------------------------------------
# 1. Verify Required Host Tooling
# ------------------------------------------------------------------------------
log_info "Step 1: Checking required host binaries..."

REQUIRED_TOOLS=("docker" "openssl" "curl")
for tool in "${REQUIRED_TOOLS[@]}"; do
  if ! command -v "${tool}" >/dev/null 2>&1; then
    log_error "Required tool '${tool}' is not installed or not in PATH."
    exit 1
  fi
  log_info "  ✓ Found: ${tool} ($(command -v "${tool}"))"
done

# Verify Docker Compose (plugin 'docker compose' or standalone 'docker-compose')
if docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD="docker compose"
  log_info "  ✓ Found Docker Compose plugin: $(docker compose version)"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_CMD="docker-compose"
  log_info "  ✓ Found Docker Compose standalone: $(docker-compose version)"
else
  log_error "Neither 'docker compose' plugin nor 'docker-compose' binary was found."
  exit 1
fi

# Verify Docker daemon is reachable
if ! docker info >/dev/null 2>&1; then
  log_error "Docker daemon is not running or current user lacks docker socket permissions."
  exit 1
fi
log_success "All required host tools are available and Docker daemon is responsive."

# ------------------------------------------------------------------------------
# 2. Environment & Secrets Configuration (.env)
# ------------------------------------------------------------------------------
log_info "Step 2: Validating environment configuration..."

ENV_FILE="${ROOT_DIR}/.env"
if [ ! -f "${ENV_FILE}" ]; then
  log_error "Missing .env file at repository root (${ENV_FILE})."
  log_error "Create one by copying .env.example: cp .env.example .env"
  log_error "Then run ./scripts/generate-tokens.sh and ./scripts/generate-keys.sh."
  exit 1
fi

# Helper function to extract a variable value safely from .env without sourcing
get_env_val() {
  local var_name="$1"
  grep -E "^[[:space:]]*${var_name}=" "${ENV_FILE}" | tail -n 1 | cut -d '=' -f2- | tr -d '\r"' || echo ""
}

REQUIRED_ENV_VARS=(
  "INTERNAL_SERVICE_TOKENS"
  "POSTGRES_PASSWORD"
  "MONGO_PASSWORD"
  "REDIS_PASSWORD"
  "JWT_SECRET"
  "NODE_ENV"
)

MISSING_VARS=()
for var in "${REQUIRED_ENV_VARS[@]}"; do
  val="$(get_env_val "${var}")"
  if [ -z "${val}" ]; then
    MISSING_VARS+=("${var}")
  elif [[ "${val}" == *"replace_"* ]] || [[ "${val}" == *"your_strong_"* ]]; then
    log_warn "Variable '${var}' contains a default placeholder value in .env."
  fi
done

if [ ${#MISSING_VARS[@]} -gt 0 ]; then
  log_error "The following required variables are missing or empty in .env:"
  for missing in "${MISSING_VARS[@]}"; do
    echo "  - ${missing}"
  done
  exit 1
fi

# Validate INTERNAL_SERVICE_TOKENS structure
TOKENS_VAL="$(get_env_val "INTERNAL_SERVICE_TOKENS")"
for svc in "gateway" "identity" "commerce" "delivery"; do
  if [[ "${TOKENS_VAL}" != *"${svc}"* ]]; then
    log_error "INTERNAL_SERVICE_TOKENS does not define a credential for '${svc}'."
    log_error "Generate a complete token map using ./scripts/generate-tokens.sh."
    exit 1
  fi
done

log_success ".env configuration validated successfully."

# ------------------------------------------------------------------------------
# 3. RS256 Keypair Generation for Identity Service
# ------------------------------------------------------------------------------
log_info "Step 3: Verifying RS256 cryptographic keys for Identity Service..."

KEYS_DIR="${ROOT_DIR}/identity-service/src/config/keys"
mkdir -p "${KEYS_DIR}"

PRIVATE_KEY="${KEYS_DIR}/private.pem"
PUBLIC_KEY="${KEYS_DIR}/public.pem"

if [ ! -f "${PRIVATE_KEY}" ] || [ ! -s "${PRIVATE_KEY}" ]; then
  log_info "Generating new 2048-bit RSA RS256 private key at: ${PRIVATE_KEY}..."
  openssl genrsa -out "${PRIVATE_KEY}" 2048
  chmod 600 "${PRIVATE_KEY}"
  log_success "Generated private key with 0600 permissions."
else
  # Enforce restrictive permissions
  chmod 600 "${PRIVATE_KEY}"
  log_info "  ✓ Private key exists: ${PRIVATE_KEY} (permissions set to 0600)"
fi

if [ ! -f "${PUBLIC_KEY}" ] || [ ! -s "${PUBLIC_KEY}" ]; then
  log_info "Deriving public key from private key at: ${PUBLIC_KEY}..."
  openssl rsa -in "${PRIVATE_KEY}" -pubout -out "${PUBLIC_KEY}"
  chmod 644 "${PUBLIC_KEY}"
  log_success "Derived public key with 0644 permissions."
else
  chmod 644 "${PUBLIC_KEY}"
  log_info "  ✓ Public key exists: ${PUBLIC_KEY} (permissions set to 0644)"
fi

log_success "RS256 JWT signing keypair is ready."

# ------------------------------------------------------------------------------
# 4. MongoDB Keyfile & Replica Set Storage Requirements
# ------------------------------------------------------------------------------
log_info "Step 4: Checking MongoDB replica set storage and keyfile requirements..."

# Ensure the named docker volume for mongo_keyfile exists
if ! docker volume inspect mongo_keyfile >/dev/null 2>&1; then
  log_info "Creating Docker volume 'mongo_keyfile' for internal MongoDB auth..."
  docker volume create mongo_keyfile >/dev/null
  log_success "Created volume 'mongo_keyfile'."
else
  log_info "  ✓ Docker volume 'mongo_keyfile' already exists."
fi

# Validate mongo init script exists
if [ ! -f "${ROOT_DIR}/scripts/mongo-init.js" ]; then
  log_error "Missing scripts/mongo-init.js required for MongoDB replica set initialization."
  exit 1
fi
log_info "  ✓ MongoDB init script found at scripts/mongo-init.js."

# ------------------------------------------------------------------------------
# 5. Production Compose File Syntax Verification
# ------------------------------------------------------------------------------
log_info "Step 5: Validating Docker Compose configuration syntax..."

if ! ${COMPOSE_CMD} -f docker-compose.yml config --quiet; then
  log_error "docker-compose.yml failed syntax validation."
  exit 1
fi
log_success "Production docker-compose.yml syntax is valid."

log_success "======================================================================"
log_success "Pre-deployment checks PASSED. System is ready for deploy.sh."
log_success "======================================================================"
exit 0
