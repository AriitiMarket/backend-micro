#!/usr/bin/env bash
# Generate high-entropy INTERNAL_SERVICE_TOKENS for cluster service authentication.
set -euo pipefail

GW_TOKEN=$(openssl rand -hex 32)
ID_TOKEN=$(openssl rand -hex 32)
CO_TOKEN=$(openssl rand -hex 32)
DL_TOKEN=$(openssl rand -hex 32)

echo "=== Generated INTERNAL_SERVICE_TOKENS ==="
echo ""
echo "Compact format (recommended for .env and docker-compose):"
echo "INTERNAL_SERVICE_TOKENS=gateway:${GW_TOKEN},identity:${ID_TOKEN},commerce:${CO_TOKEN},delivery:${DL_TOKEN}"
echo ""
echo "JSON format:"
echo "INTERNAL_SERVICE_TOKENS={\"gateway\":\"${GW_TOKEN}\",\"identity\":\"${ID_TOKEN}\",\"commerce\":\"${CO_TOKEN}\",\"delivery\":\"${DL_TOKEN}\"}"
echo ""
echo "Copy and paste either format into your .env file."
