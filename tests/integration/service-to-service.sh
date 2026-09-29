#!/usr/bin/env bash
#
# Service-to-service verification on the private network.
#
# The backend services publish no ports, so the only way to verify that
# Commerce -> Delivery / Identity works — and that an unauthorised peer is
# refused — is to run the checks from INSIDE a service container.
#
#   ./tests/integration/service-to-service.sh
#
# Requires the stack to be up:  docker compose up -d --build
set -euo pipefail

cd "$(dirname "$0")/../.."

CONTAINER="commerce-service"
CHECKS="tests/integration/service-to-service.checks.js"
REMOTE="/tmp/aritii-s2s-checks.js"

if ! docker compose ps --status running --services | grep -qx "$CONTAINER"; then
  echo "error: '$CONTAINER' is not running. Start the stack first: docker compose up -d --build" >&2
  exit 1
fi

echo "→ copying $CHECKS into $CONTAINER"
docker compose cp "$CHECKS" "$CONTAINER:$REMOTE" >/dev/null

echo "→ running service-to-service checks inside $CONTAINER"
docker compose exec -T "$CONTAINER" node "$REMOTE"
