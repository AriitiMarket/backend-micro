// Manual HTTP forward proxy -> identity Service. Strips the /api prefix.
const { forward } = require('./forward');
const env = require('../config/env');

function identityProxy(req, res) {
  return forward(req, res, env.identityServiceUrl);
}

module.exports = identityProxy;
