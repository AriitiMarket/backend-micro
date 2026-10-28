const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const cors = require('cors');
const corsConfig = require('../config/cors');
const attachSocket = require('../socket');

test('CORS: allows requests from all frontend URLs and origins when wildcard or default', async () => {
  const app = express();
  app.use(cors(corsConfig));
  app.get('/api/test', (_req, res) => res.json({ ok: true }));

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  const testOrigins = [
    'http://localhost:3000', // customer-frontend
    'http://localhost:4000', // admin-web
    'http://localhost:4173', // admin-web preview
    'http://localhost:4200', // development frontend
    'http://localhost:4273', // development preview
    'http://localhost:5173', // vite default
    'http://127.0.0.1:3000',
    'http://127.0.0.1:4000',
    'https://aritii.example.com',
  ];

  try {
    for (const origin of testOrigins) {
      // Test GET request
      const getRes = await new Promise((resolve, reject) => {
        const req = http.request({
          port,
          path: '/api/test',
          method: 'GET',
          headers: { origin },
        }, (res) => {
          resolve({
            statusCode: res.statusCode,
            allowOrigin: res.headers['access-control-allow-origin'],
          });
        });
        req.on('error', reject);
        req.end();
      });

      assert.equal(getRes.statusCode, 200);
      assert.equal(getRes.allowOrigin, origin, `Failed for origin: ${origin}`);

      // Test preflight OPTIONS request
      const optionsRes = await new Promise((resolve, reject) => {
        const req = http.request({
          port,
          path: '/api/test',
          method: 'OPTIONS',
          headers: {
            origin,
            'access-control-request-method': 'POST',
            'access-control-request-headers': 'authorization, content-type, x-custom-header',
          },
        }, (res) => {
          resolve({
            statusCode: res.statusCode,
            allowOrigin: res.headers['access-control-allow-origin'],
            allowMethods: res.headers['access-control-allow-methods'],
            allowHeaders: res.headers['access-control-allow-headers'],
          });
        });
        req.on('error', reject);
        req.end();
      });

      assert.equal(optionsRes.statusCode, 204);
      assert.equal(optionsRes.allowOrigin, origin, `OPTIONS failed for origin: ${origin}`);
      assert.ok(optionsRes.allowMethods.includes('GET'));
      assert.ok(optionsRes.allowMethods.includes('POST'));
      assert.ok(optionsRes.allowHeaders.includes('authorization'));
    }
  } finally {
    server.close();
  }
});

test('CORS: allows requests with no Origin header (same-origin / curl)', async () => {
  const app = express();
  app.use(cors(corsConfig));
  app.get('/api/test', (_req, res) => res.json({ ok: true }));

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    const res = await new Promise((resolve, reject) => {
      const req = http.request({
        port,
        path: '/api/test',
        method: 'GET',
      }, (res) => {
        resolve({ statusCode: res.statusCode });
      });
      req.on('error', reject);
      req.end();
    });

    assert.equal(res.statusCode, 200);
  } finally {
    server.close();
  }
});

test('Socket.IO CORS: allows frontend connections across polling and preflight', async () => {
  const server = http.createServer();
  // attachSocket must support ['*'], '*', or array of origins without rejecting
  attachSocket(server, ['*']);

  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  const testOrigins = [
    'http://localhost:3000',
    'http://localhost:4000',
    'http://localhost:4200',
    'https://custom-frontend.dev',
  ];

  try {
    for (const origin of testOrigins) {
      // Preflight check
      const optRes = await new Promise((resolve, reject) => {
        const req = http.request({
          port,
          path: '/socket.io/?EIO=4&transport=polling',
          method: 'OPTIONS',
          headers: {
            origin,
            'access-control-request-method': 'GET',
          },
        }, (res) => {
          resolve({
            statusCode: res.statusCode,
            allowOrigin: res.headers['access-control-allow-origin'],
          });
        });
        req.on('error', reject);
        req.end();
      });

      assert.equal(optRes.statusCode, 204);
      assert.equal(optRes.allowOrigin, origin);

      // GET polling check
      const getRes = await new Promise((resolve, reject) => {
        const req = http.request({
          port,
          path: '/socket.io/?EIO=4&transport=polling',
          method: 'GET',
          headers: { origin },
        }, (res) => {
          resolve({
            statusCode: res.statusCode,
            allowOrigin: res.headers['access-control-allow-origin'],
          });
        });
        req.on('error', reject);
        req.end();
      });

      assert.equal(getRes.statusCode, 200);
      assert.equal(getRes.allowOrigin, origin);
    }
  } finally {
    server.close();
  }
});
