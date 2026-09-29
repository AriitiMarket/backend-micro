// Uploaded media proxy: serves every file through the gateway no matter which
// microservice stores it. Commerce is tried first (product/shop/category
// images); when the file is not found there the request falls back to the
// Identity Service (user avatar uploads). This keeps ALL media behind the
// single public gateway entry point instead of exposing service ports.
const http = require('http');
const env = require('../config/env');

function fetchFrom(base, targetPath, onResponse) {
  const url = new URL(base);
  const req = http.request(
    {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: targetPath,
      method: 'GET',
      timeout: env.proxyTimeoutMs,
    },
    onResponse
  );
  req.on('error', () => onResponse(null));
  req.on('timeout', () => {
    req.destroy();
    onResponse(null);
  });
  req.end();
}

function uploadsProxy(req, res) {
  // Inside the router the /api mount prefix is stripped; strip defensively too.
  const targetPath = req.url.startsWith('/api') ? req.url.substring(4) : req.url;

  fetchFrom(env.commerceServiceUrl, targetPath, (commerceRes) => {
    if (commerceRes && commerceRes.statusCode === 200) {
      res.writeHead(commerceRes.statusCode, commerceRes.headers);
      return commerceRes.pipe(res);
    }
    if (commerceRes) commerceRes.resume(); // drain the unused response

    // Not on Commerce -> try Identity (user avatars live there).
    fetchFrom(env.identityServiceUrl, targetPath, (identityRes) => {
      if (identityRes && identityRes.statusCode === 200) {
        res.writeHead(identityRes.statusCode, identityRes.headers);
        return identityRes.pipe(res);
      }
      if (identityRes) identityRes.resume();

      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          success: false,
          code: 'FILE_NOT_FOUND',
          message: 'Uploaded file not found',
          errors: [],
        })
      );
    });
  });
}

module.exports = uploadsProxy;
