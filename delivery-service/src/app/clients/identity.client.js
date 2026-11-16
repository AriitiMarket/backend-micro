'use strict';

/**
 * Service-to-service client for the Identity Service's /internal/* API.
 *
 * Canonical path: src/app/clients/identity.client.js
 * Delegates dynamically to src/shared/utils/identity-client.js so tests stubbing
 * that path in require.cache are fully respected.
 */

const identityUtils = require('../../shared/utils/identity-client');

module.exports = new Proxy(identityUtils, {
  get(_target, prop) {
    const current = require('../../shared/utils/identity-client');
    return current[prop];
  },
  apply(_target, thisArg, argumentsList) {
    const current = require('../../shared/utils/identity-client');
    return Reflect.apply(current, thisArg, argumentsList);
  },
});
