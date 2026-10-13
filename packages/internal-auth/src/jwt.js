/**
 * Internal Authentication - JWT Token Handling
 * Shared across all microservices
 */

const crypto = require('crypto');

class JWTHandler {
  /**
   * Parse token map from credentials
   */
  static parseTokenMap(credentialsMap) {
    const tokenMap = new Map();

    for (const [serviceName, credentials] of Object.entries(credentialsMap)) {
      if (!credentials.token) {
        throw new Error(`Missing token for service: ${serviceName}`);
      }

      const parts = credentials.token.split('.');
      if (parts.length !== 3) {
        throw new Error(`Invalid token format for ${serviceName}`);
      }

      tokenMap.set(serviceName, {
        token: credentials.token,
        issued: credentials.issued || new Date(),
        expires: credentials.expires || new Date(Date.now() + 24 * 60 * 60 * 1000)
      });
    }

    return tokenMap;
  }

  /**
   * Decode JWT without verification (for inspection)
   */
  static decode(token) {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) throw new Error('Invalid token format');

      const payload = JSON.parse(
        Buffer.from(parts[1], 'base64').toString()
      );

      return payload;
    } catch (error) {
      throw new Error(`Failed to decode token: ${error.message}`);
    }
  }

  /**
   * Verify token signature (if secret is available)
   */
  static verify(token, secret) {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) throw new Error('Invalid token format');

      const [header, payload, signature] = parts;

      // Recreate signature
      const message = `${header}.${payload}`;
      const expectedSignature = crypto
        .createHmac('sha256', secret)
        .update(message)
        .digest('base64url');

      if (!this.timingSafeEqual(signature, expectedSignature)) {
        throw new Error('Invalid signature');
      }

      const decoded = JSON.parse(
        Buffer.from(payload, 'base64').toString()
      );

      if (decoded.exp && decoded.exp < Math.floor(Date.now() / 1000)) {
        throw new Error('Token expired');
      }

      return decoded;
    } catch (error) {
      throw new Error(`Token verification failed: ${error.message}`);
    }
  }

  /**
   * Create JWT token
   */
  static create(payload, secret, expiresIn = 86400) {
    const header = {
      alg: 'HS256',
      typ: 'JWT'
    };

    const issuedAt = Math.floor(Date.now() / 1000);
    const expiresAt = issuedAt + expiresIn;

    const tokenPayload = {
      ...payload,
      iat: issuedAt,
      exp: expiresAt
    };

    const headerEncoded = Buffer.from(JSON.stringify(header)).toString('base64url');
    const payloadEncoded = Buffer.from(JSON.stringify(tokenPayload)).toString('base64url');

    const message = `${headerEncoded}.${payloadEncoded}`;
    const signature = crypto
      .createHmac('sha256', secret)
      .update(message)
      .digest('base64url');

    return `${message}.${signature}`;
  }

  /**
   * Timing-safe comparison
   */
  static timingSafeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') {
      throw new TypeError('Both arguments must be strings');
    }

    const bufferA = Buffer.from(a, 'utf8');
    const bufferB = Buffer.from(b, 'utf8');

    if (bufferA.length !== bufferB.length) {
      return false;
    }

    return crypto.timingSafeEqual(bufferA, bufferB);
  }

  /**
   * Mask token for logging
   */
  static maskToken(token) {
    if (!token || token.length < 10) return '***';
    return `${token.substring(0, 5)}...${token.substring(token.length - 5)}`;
  }
}

module.exports = JWTHandler;
