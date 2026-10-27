#!/usr/bin/env bash
# Generate RS256 2048-bit key pair for Identity Service JWT signing.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
KEYS_DIR="${ROOT_DIR}/identity-service/src/config/keys"

mkdir -p "${KEYS_DIR}"

PRIVATE_KEY="${KEYS_DIR}/private.pem"
PUBLIC_KEY="${KEYS_DIR}/public.pem"

if [ -f "${PRIVATE_KEY}" ] && [ -s "${PRIVATE_KEY}" ]; then
  echo "RS256 private key already exists at: ${PRIVATE_KEY}"
else
  echo "Generating 2048-bit RS256 RSA private key at: ${PRIVATE_KEY}..."
  openssl genrsa -out "${PRIVATE_KEY}" 2048
  chmod 600 "${PRIVATE_KEY}"
  echo "Generated private key with 0600 permissions."
fi

if [ -f "${PUBLIC_KEY}" ] && [ -s "${PUBLIC_KEY}" ]; then
  echo "RS256 public key already exists at: ${PUBLIC_KEY}"
else
  echo "Deriving public key from private key at: ${PUBLIC_KEY}..."
  openssl rsa -in "${PRIVATE_KEY}" -pubout -out "${PUBLIC_KEY}"
  chmod 644 "${PUBLIC_KEY}"
  echo "Derived public key with 0644 permissions."
fi

echo "✓ Identity Service RS256 key pair ready."
