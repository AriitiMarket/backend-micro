'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const registry = require('../registry');
const attachSocket = require('../index');
const { emitRequestEvent } = require('../emit');
const { _setPemCache, _resetCache } = require('../../utils/jwks');

describe('Socket Registry & Session Management', () => {
  beforeEach(() => {
    registry.reset();
  });

  test('registers sockets for user and tracks multiple socket connections', () => {
    registry.registerSocket('user-1', 'sock-101');
    registry.registerSocket('user-1', 'sock-102');
    registry.registerSocket('user-2', 'sock-201');

    assert.deepStrictEqual(registry.getSocketsForUser('user-1'), ['sock-101', 'sock-102']);
    assert.deepStrictEqual(registry.getSocketsForUser('user-2'), ['sock-201']);
    assert.deepStrictEqual(registry.getAllActiveUsers().sort(), ['user-1', 'user-2']);
  });

  test('unregistering socket cleans up user map when all sockets disconnect', () => {
    registry.registerSocket('user-1', 'sock-101');
    registry.registerSocket('user-1', 'sock-102');

    const removed1 = registry.unregisterSocket('sock-101');
    assert.strictEqual(removed1, 'user-1');
    assert.deepStrictEqual(registry.getSocketsForUser('user-1'), ['sock-102']);
    assert.deepStrictEqual(registry.getAllActiveUsers(), ['user-1']);

    const removed2 = registry.unregisterSocket('sock-102');
    assert.strictEqual(removed2, 'user-1');
    assert.deepStrictEqual(registry.getSocketsForUser('user-1'), []);
    assert.deepStrictEqual(registry.getAllActiveUsers(), []);
  });

  test('handles unknown socket id unregistration gracefully', () => {
    const res = registry.unregisterSocket('non-existent');
    assert.strictEqual(res, null);
  });

  test('setIo and getIo properly store server instance', () => {
    const mockIo = { name: 'mock-io' };
    registry.setIo(mockIo);
    assert.strictEqual(registry.getIo(), mockIo);
  });
});

describe('Socket Handshake Authentication & Room Subscriptions', () => {
  let privateKey;
  let publicKeyPem;
  const kid = 'test-socket-key-1';

  beforeEach(() => {
    registry.reset();
    _resetCache();

    const keyPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    privateKey = keyPair.privateKey;
    publicKeyPem = keyPair.publicKey.export({ type: 'spki', format: 'pem' });
    _setPemCache({ [kid]: publicKeyPem });
  });

  function createToken(payload = {}) {
    return jwt.sign(
      {
        sub: 'user-default',
        type: 'access',
        role: 'buyer',
        ...payload,
      },
      privateKey,
      {
        algorithm: 'RS256',
        keyid: kid,
        issuer: process.env.ISSUER || 'aritii-identity',
        audience: process.env.AUDIENCE || 'aritii-market',
        expiresIn: '1h',
      }
    );
  }

  test('handshake middleware rejects connection without auth token', async () => {
    const mockServer = { on: () => {}, listeners: () => [] };
    const io = attachSocket(mockServer, '*');

    // Find the middleware registered via io.use
    const authMiddleware = io.sockets._fns[0];
    assert.ok(authMiddleware, 'Auth middleware must be registered');

    const socket = {
      handshake: { auth: {}, headers: {} },
      data: {},
    };

    let caughtErr;
    await authMiddleware(socket, (err) => {
      caughtErr = err;
    });

    assert.ok(caughtErr);
    assert.strictEqual(caughtErr.message, 'unauthorized');
  });

  test('handshake middleware rejects connection with invalid/expired token', async () => {
    const mockServer = { on: () => {}, listeners: () => [] };
    const io = attachSocket(mockServer, '*');
    const authMiddleware = io.sockets._fns[0];

    const socket = {
      handshake: { auth: { token: 'invalid.jwt.token' }, headers: {} },
      data: {},
    };

    let caughtErr;
    await authMiddleware(socket, (err) => {
      caughtErr = err;
    });

    assert.ok(caughtErr);
    assert.strictEqual(caughtErr.message, 'unauthorized');
  });

  test('handshake middleware accepts valid token and populates socket.data', async () => {
    const mockServer = { on: () => {}, listeners: () => [] };
    const io = attachSocket(mockServer, '*');
    const authMiddleware = io.sockets._fns[0];

    const token = createToken({
      sub: 'usr_789',
      role: 'seller',
      roles: ['seller'],
      shopId: 'shop_456',
      providerId: 'prov_123',
    });

    const socket = {
      handshake: { auth: { token }, headers: {} },
      data: {},
    };

    let caughtErr = null;
    await authMiddleware(socket, (err) => {
      caughtErr = err;
    });

    assert.strictEqual(caughtErr, undefined);
    assert.strictEqual(socket.data.userId, 'usr_789');
    assert.strictEqual(socket.data.role, 'seller');
    assert.deepStrictEqual(socket.data.roles, ['seller']);
    assert.strictEqual(socket.data.shopId, 'shop_456');
    assert.strictEqual(socket.data.providerId, 'prov_123');
  });

  test('connection auto-joins user room and registers in registry', () => {
    const mockServer = { on: () => {}, listeners: () => [] };
    const io = attachSocket(mockServer, '*');

    const joinedRooms = [];
    const eventHandlers = {};

    const socket = {
      id: 'socket-abc-123',
      data: {
        userId: 'usr_seller_1',
        shopId: 'shop_001',
        providerId: 'prov_001',
      },
      join: (room) => joinedRooms.push(room),
      leave: (room) => {
        const idx = joinedRooms.indexOf(room);
        if (idx !== -1) joinedRooms.splice(idx, 1);
      },
      on: (event, handler) => {
        eventHandlers[event] = handler;
      },
      emit: () => {},
    };

    // Simulate connection event
    io.sockets.emitReserved('connection', socket);

    assert.ok(joinedRooms.includes('user:usr_seller_1'));
    assert.ok(joinedRooms.includes('shop:shop_001'));
    assert.ok(joinedRooms.includes('provider:prov_001'));
    assert.deepStrictEqual(registry.getSocketsForUser('usr_seller_1'), ['socket-abc-123']);

    // Test shop:subscribe authorization
    let emittedError = null;
    socket.emit = (event, data) => {
      if (event === 'error') emittedError = data;
    };

    // Cannot subscribe to third-party shop without admin role
    eventHandlers['shop:subscribe']({ shopId: 'unauthorized_shop_999' });
    assert.ok(emittedError);
    assert.strictEqual(emittedError.message, 'Unauthorized room subscription');

    // Disconnect cleans up registry
    eventHandlers['disconnect']();
    assert.deepStrictEqual(registry.getSocketsForUser('usr_seller_1'), []);
  });
});

describe('Realtime Event Ingest Validation & Fanout', () => {
  beforeEach(() => {
    registry.reset();
  });

  function createMockRes() {
    return {
      statusCode: 200,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.body = payload;
        return this;
      },
    };
  }

  test('rejects request when socket layer is not attached (503)', async () => {
    const req = {
      body: {
        type: 'request.status.updated',
        requestId: 'req_123',
        recipients: ['usr_1', 'usr_2'],
        data: { status: 'CONFIRMED' },
      },
    };
    const res = createMockRes();

    await emitRequestEvent(req, res);
    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.body.code, 'REALTIME_UNAVAILABLE');
  });

  test('validates event type schema (rejects invalid type format)', async () => {
    registry.setIo({ to: () => ({ emit: () => {} }) });
    const req = {
      body: {
        type: 'INVALID_TYPE_FORMAT',
        requestId: 'req_123',
      },
    };
    const res = createMockRes();

    await emitRequestEvent(req, res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'INVALID_EVENT');
  });

  test('validates requestId (rejects missing or malformed requestId)', async () => {
    registry.setIo({ to: () => ({ emit: () => {} }) });
    const req = {
      body: {
        type: 'request.order.created',
        requestId: '',
      },
    };
    const res = createMockRes();

    await emitRequestEvent(req, res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'INVALID_EVENT');
  });

  test('validates data object (rejects non-object data)', async () => {
    registry.setIo({ to: () => ({ emit: () => {} }) });
    const req = {
      body: {
        type: 'request.order.created',
        requestId: 'req_123',
        data: 'not-an-object',
      },
    };
    const res = createMockRes();

    await emitRequestEvent(req, res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'INVALID_EVENT');
  });

  test('successfully fans out event to recipient rooms and request room', async () => {
    let targetedRooms = null;
    let emittedEvent = null;

    const mockIo = {
      to: (rooms) => {
        targetedRooms = rooms;
        return {
          emit: (name, payload) => {
            emittedEvent = { name, payload };
          },
        };
      },
    };
    registry.setIo(mockIo);

    const req = {
      body: {
        type: 'request.message.created',
        requestId: 'req_order_456',
        recipients: ['usr_buyer_1', 'usr_seller_2'],
        actorId: 'usr_buyer_1',
        data: { text: 'Hello, when will it ship?' },
      },
    };
    const res = createMockRes();

    await emitRequestEvent(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.code, 'EMITTED');

    assert.deepStrictEqual(targetedRooms, [
      'user:usr_buyer_1',
      'user:usr_seller_2',
      'request:req_order_456',
    ]);
    assert.strictEqual(emittedEvent.name, 'request:event');
    assert.strictEqual(emittedEvent.payload.type, 'request.message.created');
    assert.strictEqual(emittedEvent.payload.requestId, 'req_order_456');
    assert.strictEqual(emittedEvent.payload.actorId, 'usr_buyer_1');
    assert.deepStrictEqual(emittedEvent.payload.data, { text: 'Hello, when will it ship?' });
    assert.ok(emittedEvent.payload.at);
  });
});
