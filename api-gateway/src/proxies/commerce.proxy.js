// Manual HTTP forward proxy -> commerce Service. Strips the /api prefix.
const { forward } = require('./forward');
const env = require('../config/env');

function commerceProxy(req, res) {
  return forward(req, res, env.commerceServiceUrl);
}

module.exports = commerceProxy;
