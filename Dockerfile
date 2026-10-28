# Multi-stage Dockerfile for Aritii Market microservices platform
# Stage 1: Install production dependencies
FROM node:20-bookworm-slim AS deps

WORKDIR /app

# Copy root manifest and shared internal monorepo packages first
COPY package*.json ./
COPY packages/ ./packages/

# Copy package manifests for each microservice
COPY identity-service/package*.json ./identity-service/
COPY commerce-service/package*.json ./commerce-service/
COPY delivery-service/package*.json ./delivery-service/
COPY api-gateway/package*.json ./api-gateway/

# Install ONLY production dependencies (--omit=dev) for minimal image footprint
RUN npm --prefix identity-service ci --omit=dev --no-audit --prefer-offline && \
    npm --prefix commerce-service ci --omit=dev --no-audit --prefer-offline && \
    npm --prefix delivery-service ci --omit=dev --no-audit --prefer-offline && \
    npm --prefix api-gateway ci --omit=dev --no-audit --prefer-offline

# Stage 2: Production runner base
FROM node:20-bookworm-slim AS runner

WORKDIR /app

# Install curl for container healthchecks
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production

# Create runtime directories owned by node user
RUN mkdir -p \
    /app/commerce-service/src/uploads \
    /app/identity-service/src/uploads \
    /app/identity-service/src/config/keys \
    && chown -R node:node /app

# Copy root manifest and shared internal monorepo packages
COPY --chown=node:node package*.json ./
COPY --chown=node:node packages/ ./packages/

# Copy pruned production dependencies from deps stage
COPY --chown=node:node --from=deps /app/identity-service/node_modules ./identity-service/node_modules
COPY --chown=node:node --from=deps /app/commerce-service/node_modules ./commerce-service/node_modules
COPY --chown=node:node --from=deps /app/delivery-service/node_modules ./delivery-service/node_modules
COPY --chown=node:node --from=deps /app/api-gateway/node_modules ./api-gateway/node_modules

# Copy service application code
COPY --chown=node:node identity-service/ ./identity-service/
COPY --chown=node:node commerce-service/ ./commerce-service/
COPY --chown=node:node delivery-service/ ./delivery-service/
COPY --chown=node:node api-gateway/ ./api-gateway/

# Switch to non-root user
USER node

# Default healthcheck
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:${PORT:-3000}/health || exit 1

# Default CMD (dynamically routes based on SERVICE_NAME)
CMD ["sh", "-c", "npm --prefix \"${SERVICE_NAME:?SERVICE_NAME must be set, e.g. commerce-service}\" start"]

# Service-specific target stages for targeted builds
FROM runner AS commerce-service
ENV PORT=3001
ENV SERVICE_NAME=commerce-service
EXPOSE 3001
CMD ["npm", "--prefix", "commerce-service", "start"]

FROM runner AS delivery-service
ENV PORT=3002
ENV SERVICE_NAME=delivery-service
EXPOSE 3002
CMD ["npm", "--prefix", "delivery-service", "start"]

FROM runner AS identity-service
ENV PORT=3003
ENV SERVICE_NAME=identity-service
EXPOSE 3003
CMD ["npm", "--prefix", "identity-service", "start"]

FROM runner AS api-gateway
ENV PORT=3000
ENV SERVICE_NAME=api-gateway
EXPOSE 3000
CMD ["npm", "--prefix", "api-gateway", "start"]

# Default stage when built without specifying target
FROM runner AS final
