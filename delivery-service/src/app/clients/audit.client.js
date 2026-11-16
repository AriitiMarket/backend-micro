'use strict';

/**
 * Audit Client — sends audit log entries from delivery-service to identity-service.
 *
 * Canonical path: src/app/clients/audit.client.js
 * Delegates dynamically to src/shared/utils/audit-client.js so tests stubbing
 * that path in require.cache are fully respected.
 */

const auditUtils = require('../../shared/utils/audit-client');

module.exports = new Proxy(auditUtils, {
  get(_target, prop) {
    const current = require('../../shared/utils/audit-client');
    return current[prop];
  },
  apply(_target, thisArg, argumentsList) {
    const current = require('../../shared/utils/audit-client');
    return Reflect.apply(current, thisArg, argumentsList);
  },
});
