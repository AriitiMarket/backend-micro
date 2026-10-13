/**
 * Credentials Loading & Management
 */

const fs = require('fs');
const path = require('path');

class CredentialsManager {
  /**
   * Load credentials from environment or file
   */
  static loadCredentials(serviceName) {
    // First try environment variables
    const tokenEnv = process.env[`${serviceName.toUpperCase()}_TOKEN`];
    const secretEnv = process.env[`${serviceName.toUpperCase()}_SECRET`];

    if (tokenEnv && secretEnv) {
      return {
        token: tokenEnv,
        secret: secretEnv,
        source: 'environment'
      };
    }

    // Fall back to credentials file
    const credFile = path.join(process.env.CONFIG_DIR || './config', 'credentials.json');

    try {
      if (fs.existsSync(credFile)) {
        const credentials = JSON.parse(fs.readFileSync(credFile, 'utf8'));
        const serviceCredentials = credentials[serviceName];

        if (serviceCredentials) {
          return {
            token: serviceCredentials.token,
            secret: serviceCredentials.secret,
            source: 'file'
          };
        }
      }
    } catch (error) {
      console.warn(`Failed to load credentials from file: ${error.message}`);
    }

    throw new Error(`No credentials found for service: ${serviceName}`);
  }

  /**
   * Load all service credentials
   */
  static loadAllCredentials() {
    const services = [
      'commerce-service',
      'delivery-service',
      'identity-service',
      'api-gateway'
    ];

    const credentials = {};

    for (const service of services) {
      try {
        credentials[service] = this.loadCredentials(service);
      } catch (error) {
        console.warn(`Warning: ${error.message}`);
      }
    }

    return credentials;
  }

  /**
   * Validate credentials structure
   */
  static validate(credentials) {
    if (!credentials || typeof credentials !== 'object') {
      throw new Error('Credentials must be an object');
    }

    for (const [serviceName, creds] of Object.entries(credentials)) {
      if (!creds.token || typeof creds.token !== 'string') {
        throw new Error(`Invalid token for ${serviceName}`);
      }

      if (!creds.secret || typeof creds.secret !== 'string') {
        throw new Error(`Invalid secret for ${serviceName}`);
      }
    }

    return true;
  }

  /**
   * Get service name in canonical format
   */
  static canonicalServiceName(name) {
    return name
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '');
  }

  /**
   * Check if service is known
   */
  static isKnownService(serviceName) {
    const canonical = this.canonicalServiceName(serviceName);
    const knownServices = [
      'commerce-service',
      'delivery-service',
      'identity-service',
      'api-gateway'
    ];

    return knownServices.includes(canonical);
  }
}

module.exports = CredentialsManager;
