/**
 * Internal Request Verification
 */

const JWTHandler = require('./jwt');

class RequestVerifier {
  /**
   * Verify internal service request
   */
  static verify(request, knownServices) {
    const authHeader = request.headers['x-internal-auth'];
    const serviceHeader = request.headers['x-service-name'];

    if (!authHeader) {
      throw new Error('Missing internal auth token');
    }

    if (!serviceHeader) {
      throw new Error('Missing service name');
    }

    // Verify service is known
    if (!knownServices.includes(serviceHeader)) {
      throw new Error(`Unknown service: ${serviceHeader}`);
    }

    return {
      token: authHeader,
      serviceName: serviceHeader,
      timestamp: Date.now()
    };
  }

  /**
   * Middleware for Express
   */
  static middleware(credentialsMap) {
    return (req, res, next) => {
      try {
        const verified = this.verify(req, Array.from(credentialsMap.keys()));

        // Verify token with service's secret
        const serviceCredentials = credentialsMap.get(verified.serviceName);
        if (!serviceCredentials) {
          return res.status(401).json({ error: 'Service not configured' });
        }

        const decoded = JWTHandler.verify(
          verified.token,
          serviceCredentials.secret
        );

        // Attach to request
        req.internalAuth = {
          serviceName: verified.serviceName,
          payload: decoded,
          verified: true
        };

        next();
      } catch (error) {
        res.status(401).json({ error: error.message });
      }
    };
  }

  /**
   * Create authenticated request headers
   */
  static createHeaders(serviceName, token) {
    return {
      'x-internal-auth': token,
      'x-service-name': serviceName,
      'x-request-id': this.generateRequestId(),
      'x-timestamp': Date.now().toString()
    };
  }

  /**
   * Generate request ID
   */
  static generateRequestId() {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
}

module.exports = RequestVerifier;
