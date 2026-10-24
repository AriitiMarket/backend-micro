// Streams a gateway request to a downstream microservice.
//
// Responsibilities:
//   * verify the Bearer JWT via JWKS (RS256) and inject x-user-id/email/role
//   * NEVER trust a client-supplied identity or service header: the gateway
//     always re-signs outbound traffic as itself (x-internal-service: gateway)
//     with its own cluster credential, so a client cannot impersonate another
//     service or assert a user identity
//   * refuse to route into a service currently marked unavailable
//   * cap the buffered body size and stream the upstream response back
// No cookies. No server sessions. Pure token-based.
const http = require('http');
const { verifyToken } = require('../utils/jwks');
const env = require('../config/env');
const { outbound, serviceNameForUrl } = require('../config/services');
const availability = require('../utils/serviceAvailability');

function extractIdentityFromHeader(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return Promise.resolve(null);
  const token = authHeader.split(' ')[1];
  return verifyToken(token)
    .then((payload) => ({
      id: payload.sub,
      email: payload.email || null,
      role: payload.role || null,
      // Multi-actor capability set. Carries no authority of its own: it tells the
      // services that ONE account holds several actor roles (seller + provider),
      // which the single `role` claim cannot express.
      capabilities: Array.isArray(payload.capabilities) ? payload.capabilities : null,
      // Membership STATUS per actor role ({ SELLER: 'PENDING', ... }). Relayed so
      // each service's authorize() can distinguish "not approved yet" from
      // "not allowed at all" (ROLE_NOT_APPROVED vs ROLE_REQUIRED).
      roleStatuses: payload.role_statuses && typeof payload.role_statuses === 'object'
        ? payload.role_statuses
        : null,
    }))
    .catch(() => null);
}

function forward(req, res, targetUrl) {
  // Which service owns this upstream? Used for availability tracking and for
  // attributing failures in the structured error body. Null for the media proxy,
  // which fans out across two services and therefore has no single owner.
  const targetService = serviceNameForUrl(targetUrl);

  // Never open a socket to a service already known to be down. Answering
  // immediately keeps a struggling service from being buried under queued
  // connections, and the mark expires on its own (see utils/serviceAvailability).
  if (availability.isDown(targetService)) {
    res.writeHead(503, {
      'Content-Type': 'application/json',
      'Retry-After': '2',
      'X-Request-ID': req.id || '',
    });
    return res.end(JSON.stringify({
      success: false,
      code: 'SERVICE_UNAVAILABLE',
      message: targetService + ' is temporarily unavailable, please retry',
      errors: [],
    }));
  }

  const parsed = new URL(targetUrl);
  const pathname = req.url.split('?')[0];
  const rewrittenPath = pathname.startsWith('/api') ? pathname.substring(4) : pathname;
  const query = req.url.includes('?') ? req.url.split('?')[1] : '';
  const targetPath = query ? rewrittenPath + '?' + query : rewrittenPath;

  // Use parsed body if available (express.json()), otherwise read from stream
  let bodyPromise;

  if (req.body !== undefined && req.body !== null) {
    const serialized = typeof req.body === 'string' || Buffer.isBuffer(req.body)
      ? req.body
      : JSON.stringify(req.body);
    bodyPromise = Promise.resolve(Buffer.isBuffer(serialized) ? serialized : Buffer.from(serialized));
  } else if (req.readableEnded) {
    bodyPromise = Promise.resolve(Buffer.alloc(0));
  } else {
    // Buffer the request body so we can forward it after async JWT verification.
    const bodyChunks = [];
    let received = 0;
    let aborted = false;

    bodyPromise = new Promise((resolve, reject) => {
      req.on('data', (chunk) => {
        if (aborted) return;
        received += chunk.length;
        if (received > env.maxBodyBytes) {
          aborted = true;
          if (!res.headersSent) {
            res.writeHead(413, { 'Content-Type': 'application/json', 'X-Request-ID': req.id || '' });
            res.end(JSON.stringify({
              success: false,
              code: 'PAYLOAD_TOO_LARGE',
              message: 'Request body exceeds the ' + Math.floor(env.maxBodyBytes / (1024 * 1024)) + 'MB limit',
              errors: [],
            }));
          }
          req.destroy();
          return;
        }
        bodyChunks.push(chunk);
      });

      req.on('end', () => {
        if (aborted) return;
        resolve(Buffer.concat(bodyChunks));
      });

      req.on('error', reject);
    });
  }

  bodyPromise.then((body) => {
    extractIdentityFromHeader(req.headers.authorization).then((identity) => {
      const headers = {};
      if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];
      if (body.length > 0) headers['Content-Length'] = body.length;
      if (req.id) headers['X-Request-ID'] = req.id;
      // Preserve the public Host so OIDC discovery advertises the gateway
      // issuer/endpoints, not the internal service hostname.
      if (req.headers.host) headers.Host = req.headers.host;
      if (req.headers['x-forwarded-host']) headers['X-Forwarded-Host'] = req.headers['x-forwarded-host'];
      if (req.headers['x-forwarded-proto']) headers['X-Forwarded-Proto'] = req.headers['x-forwarded-proto'];
      if (req.headers['x-forwarded-for']) headers['X-Forwarded-For'] = req.headers['x-forwarded-for'];

      // Cluster credentials: ALWAYS injected by the gateway, never taken from
      // the client. The caller is identified as `gateway` and signed with the
      // gateway's own credential — that is what makes the gateway-injected
      // x-user-* headers trustworthy downstream, and what stops a client (or a
      // compromised peer) from claiming to be another service. A client-supplied
      // x-internal-service is deliberately dropped, even on /api/internal/*.
      headers['X-Internal-Token'] = outbound.token;
      headers['X-Internal-Service'] = outbound.service;

      // Forward the original Authorization header so Identity Service can verify the token.
      if (req.headers['authorization']) headers['Authorization'] = req.headers['authorization'];

      // Identity is rebuilt from the verified token — client-supplied x-user-*
      // headers are deliberately ignored.
      //
      // Only the coarse identity (id/email/role) plus the account's capability set
      // is relayed: every service needs the former for its own authorize() gate,
      // and the latter so it can tell that one account holds several actor roles
      // (seller + provider). Anything else about a user — roles, permissions, RBAC
      // assignments, admin data scopes — stays in the Identity Service, and any
      // service that needs it asks Identity over its /internal/* API through this
      // gateway.
      if (identity) {
        headers['x-user-id'] = identity.id;
        if (identity.email) headers['x-user-email'] = identity.email;
        if (identity.role) headers['x-user-role'] = identity.role;
        if (identity.capabilities && identity.capabilities.length > 0) {
          headers['x-user-capabilities'] = identity.capabilities.join(',');
        }
        if (identity.roleStatuses && Object.keys(identity.roleStatuses).length > 0) {
          headers['x-user-role-statuses'] = JSON.stringify(identity.roleStatuses);
        }
      }

      const proxyReq = http.request({
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: targetPath,
        method: req.method,
        headers,
        timeout: env.proxyTimeoutMs,
      }, (proxyRes) => {
        if (proxyRes.headers && proxyRes.headers.location && typeof proxyRes.headers.location === 'string') {
          const loc = proxyRes.headers.location;
          if (loc.startsWith('http')) {
            const slash = loc.indexOf('/', loc.indexOf('//') + 2);
            proxyRes.headers.location = slash >= 0 ? loc.substring(slash) : '/';
          }
        }
        // A response means the service is alive, so clear any failure mark. A
        // 5xx is NOT treated as unavailability: it may be a business error for
        // this one request, and marking the whole service down for it would let a
        // single failing endpoint take a healthy service out of rotation for
        // every other caller.
        availability.markUp(targetService);

        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      });

      proxyReq.on('timeout', () => {
        const err = new Error('Upstream service timeout');
        err.code = 'ETIMEDOUT';
        proxyReq.destroy(err);
      });

      proxyReq.on('error', (err) => {
        if (res.headersSent || res.writableEnded) return;
        try {
          const timedOut = err.code === 'ETIMEDOUT';
          const status = timedOut ? 504 : 502;
          const code = timedOut ? 'SERVICE_TIMEOUT' : 'SERVICE_UNAVAILABLE';
          const message = timedOut
            ? 'Upstream service timed out'
            : 'Bad Gateway: ' + err.message;
          // Remember the failure briefly so the next queued request fails fast
          // instead of opening another doomed connection.
          availability.markDown(targetService, code);
          res.writeHead(status, {
            'Content-Type': 'application/json',
            'Retry-After': '2',
            'X-Request-ID': req.id || '',
          });
          res.end(JSON.stringify({ success: false, code, message, service: targetService, errors: [] }));
        } catch (writeErr) {
          // The client has already gone away — nothing left to do.
        }
      });

      proxyReq.write(body);
      proxyReq.end();
    });
  });
}

module.exports = { forward };
