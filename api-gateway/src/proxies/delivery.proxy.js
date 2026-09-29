// Manual HTTP forward proxy -> delivery Service. Strips the /api prefix.
const { forward } = require('./forward');
const env = require('../config/env');

function deliveryProxy(req, res) {
  return forward(req, res, env.deliveryServiceUrl);
}

module.exports = deliveryProxy;
