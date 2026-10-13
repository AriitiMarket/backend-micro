# Multi-stage build for Node.js services
FROM node:latest AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY packages ./packages
COPY identity-service/package.json ./identity-service/package.json
COPY commerce-service/package.json ./commerce-service/package.json
COPY delivery-service/package.json ./delivery-service/package.json
COPY api-gateway/package.json ./api-gateway/package.json

# Install dependencies
RUN npm ci && \
    npm --prefix identity-service install && \
    npm --prefix commerce-service install && \
    npm --prefix delivery-service install && \
    npm --prefix api-gateway install

# Copy source code
COPY . .

# Build if needed
RUN npm run build || true

# Production image
FROM node:latest

WORKDIR /app

# Install curl for health checks (using apt for Debian-based node:latest)
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app /app

# Set environment
ENV NODE_ENV=production

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:${PORT:-3000}/health || exit 1

# Start the service named by SERVICE_NAME (set per container in docker-compose.yml)
CMD ["sh", "-c", "npm --prefix \"${SERVICE_NAME:?SERVICE_NAME must name a service directory, e.g. commerce-service}\" start"]