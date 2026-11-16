const test = require('node:test');
const assert = require('node:assert/strict');
const authService = require('../../services/auth.service');
const passwordResetService = require('../../services/passwordReset.service');
const refreshTokensRepo = require('../../repositories/refreshTokens.repository');
const usersRepository = require('../../repositories/users.repository');
const passwordResetsRepo = require('../../repositories/passwordResets.repository');
const { setPool } = require('../../config/database');
const { auditAuth } = require('../../services/auditLog.service');
const { createRateLimiter } = require('../../middleware/rateLimiter');

function createMockPool() {
  const client = {
    async query(sql) {
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  return {
    client,
    async connect() {
      return client;
    },
    async query() {
      return { rows: [], rowCount: 1 };
    },
  };
}

test.beforeEach(() => {
  setPool(createMockPool());
});

test.afterEach(() => {
  setPool(null);
});

test('Refresh token rotation: normal rotation issues a new token and revokes old', async () => {
  const origFindRefreshToken = refreshTokensRepo.findRefreshToken;
  const origRotateRefreshToken = refreshTokensRepo.rotateRefreshToken;
  const origFindById = usersRepository.findById;

  let rotateCalledWith = null;

  try {
    refreshTokensRepo.findRefreshToken = async (token) => {
      assert.equal(token, 'old-valid-refresh-token');
      return {
        id: 'token-uuid-1',
        user_id: 'user-123',
        family_id: 'family-abc',
        revoked_at: null,
        expires_at: new Date(Date.now() + 86400000).toISOString(),
      };
    };

    usersRepository.findById = async (id) => {
      assert.equal(id, 'user-123');
      return {
        id: 'user-123',
        role: 'BUYER',
        status: 'active',
        name: 'Test Buyer',
        email: 'buyer@test.com',
      };
    };

    refreshTokensRepo.rotateRefreshToken = async (params) => {
      rotateCalledWith = params;
      return {
        id: 'new-token-uuid-2',
        userId: params.userId,
        familyId: params.familyId,
        expiresAt: new Date(Date.now() + 86400000),
      };
    };

    const result = await authService.refreshTokens('old-valid-refresh-token');

    assert.ok(result.accessToken, 'Must return accessToken');
    assert.ok(result.refreshToken, 'Must return new refreshToken');
    assert.notEqual(result.refreshToken, 'old-valid-refresh-token');
    assert.equal(rotateCalledWith.userId, 'user-123');
    assert.equal(rotateCalledWith.familyId, 'family-abc');
    assert.ok(rotateCalledWith.client, 'Must pass transactional client to rotateRefreshToken');
  } finally {
    refreshTokensRepo.findRefreshToken = origFindRefreshToken;
    refreshTokensRepo.rotateRefreshToken = origRotateRefreshToken;
    usersRepository.findById = origFindById;
  }
});

test('Refresh token reuse detection: replaying a revoked token revokes all active tokens and audits critical event', async () => {
  const origFindRefreshToken = refreshTokensRepo.findRefreshToken;
  const origRevokeAllForUser = refreshTokensRepo.revokeAllForUser;
  const origTokenReuseDetected = auditAuth.tokenReuseDetected;

  let revokedUser = null;
  let auditPayload = null;

  try {
    refreshTokensRepo.findRefreshToken = async (token) => {
      return {
        id: 'token-uuid-replayed',
        user_id: 'user-hacked-456',
        family_id: 'family-hacked',
        revoked_at: new Date(Date.now() - 60000).toISOString(), // already revoked
        expires_at: new Date(Date.now() + 86400000).toISOString(),
      };
    };

    refreshTokensRepo.revokeAllForUser = async (userId, client) => {
      revokedUser = { userId, client };
    };

    auditAuth.tokenReuseDetected = (userId, meta) => {
      auditPayload = { userId, meta };
    };

    await assert.rejects(
      async () => {
        await authService.refreshTokens('replayed-token');
      },
      (err) => {
        assert.equal(err.statusCode, 401);
        assert.match(err.message, /Refresh token reuse detected\. All sessions revoked\./);
        return true;
      }
    );

    assert.ok(revokedUser, 'Must call revokeAllForUser on reuse detection');
    assert.equal(revokedUser.userId, 'user-hacked-456');
    assert.ok(revokedUser.client, 'Must use transactional client');
    assert.ok(auditPayload, 'Must audit reuse event');
    assert.equal(auditPayload.userId, 'user-hacked-456');
    assert.equal(auditPayload.meta.familyId, 'family-hacked');
  } finally {
    refreshTokensRepo.findRefreshToken = origFindRefreshToken;
    refreshTokensRepo.revokeAllForUser = origRevokeAllForUser;
    auditAuth.tokenReuseDetected = origTokenReuseDetected;
  }
});

test('Refresh token reuse detection: race condition where rotateRefreshToken returns null', async () => {
  const origFindRefreshToken = refreshTokensRepo.findRefreshToken;
  const origRotateRefreshToken = refreshTokensRepo.rotateRefreshToken;
  const origRevokeAllForUser = refreshTokensRepo.revokeAllForUser;
  const origFindById = usersRepository.findById;
  const origTokenReuseDetected = auditAuth.tokenReuseDetected;

  let revokedUser = null;
  let auditPayload = null;

  try {
    refreshTokensRepo.findRefreshToken = async () => ({
      id: 'token-race',
      user_id: 'user-race-789',
      family_id: 'family-race',
      revoked_at: null,
      expires_at: new Date(Date.now() + 86400000).toISOString(),
    });

    usersRepository.findById = async () => ({
      id: 'user-race-789',
      role: 'BUYER',
      status: 'active',
    });

    refreshTokensRepo.rotateRefreshToken = async () => null; // Atomic CAS failed

    refreshTokensRepo.revokeAllForUser = async (userId, client) => {
      revokedUser = { userId, client };
    };

    auditAuth.tokenReuseDetected = (userId, meta) => {
      auditPayload = { userId, meta };
    };

    await assert.rejects(
      async () => {
        await authService.refreshTokens('concurrent-token');
      },
      (err) => {
        assert.equal(err.statusCode, 401);
        assert.match(err.message, /Refresh token reuse detected\. All sessions revoked\./);
        return true;
      }
    );

    assert.ok(revokedUser, 'Must revoke all user sessions when atomic rotation fails');
    assert.equal(revokedUser.userId, 'user-race-789');
    assert.ok(auditPayload, 'Must audit reuse event');
  } finally {
    refreshTokensRepo.findRefreshToken = origFindRefreshToken;
    refreshTokensRepo.rotateRefreshToken = origRotateRefreshToken;
    refreshTokensRepo.revokeAllForUser = origRevokeAllForUser;
    usersRepository.findById = origFindById;
    auditAuth.tokenReuseDetected = origTokenReuseDetected;
  }
});

test('Password reset transaction: atomically updates password, marks reset token used, and revokes all refresh tokens', async () => {
  const origFindValidReset = passwordResetsRepo.findValidReset;
  const origUpdatePassword = usersRepository.updatePassword;
  const origMarkUsed = passwordResetsRepo.markUsed;
  const origRevokeAllForUser = refreshTokensRepo.revokeAllForUser;

  const calls = [];

  try {
    passwordResetsRepo.findValidReset = async (tokenHash, client) => {
      assert.ok(client, 'findValidReset must receive transactional client');
      calls.push('findValidReset');
      return {
        id: 'reset-1',
        user_id: 'user-reset-999',
        email: 'user@test.com',
      };
    };

    usersRepository.updatePassword = async (opts) => {
      assert.equal(opts.id, 'user-reset-999');
      assert.ok(opts.hash);
      assert.ok(opts.client, 'updatePassword must receive transactional client');
      calls.push('updatePassword');
    };

    passwordResetsRepo.markUsed = async (id, client) => {
      assert.equal(id, 'reset-1');
      assert.ok(client, 'markUsed must receive transactional client');
      calls.push('markUsed');
    };

    refreshTokensRepo.revokeAllForUser = async (userId, client) => {
      assert.equal(userId, 'user-reset-999');
      assert.ok(client, 'revokeAllForUser must receive transactional client');
      calls.push('revokeAllForUser');
    };

    const res = await passwordResetService.resetPassword({
      token: 'valid-reset-token-12345',
      newPassword: 'StrongPass123!@#',
      confirmPassword: 'StrongPass123!@#',
    });

    assert.equal(res.success, true);
    assert.deepEqual(calls, ['findValidReset', 'updatePassword', 'markUsed', 'revokeAllForUser']);
  } finally {
    passwordResetsRepo.findValidReset = origFindValidReset;
    usersRepository.updatePassword = origUpdatePassword;
    passwordResetsRepo.markUsed = origMarkUsed;
    refreshTokensRepo.revokeAllForUser = origRevokeAllForUser;
  }
});

test('Rate limiter: enforces max requests and allows under limit', () => {
  const limiter = createRateLimiter({
    windowMs: 1000,
    max: 2,
    message: 'Too many requests',
  });

  let statusSent = null;
  let jsonSent = null;

  const mockRes = () => ({
    status: (code) => {
      statusSent = code;
      return {
        json: (data) => {
          jsonSent = data;
        },
      };
    },
    setHeader: () => {},
  });

  const req1 = { ip: '1.2.3.4', headers: { 'x-test-rate-limit': 'true' } };
  let next1Called = false;
  limiter(req1, mockRes(), () => { next1Called = true; });
  assert.equal(next1Called, true, 'Request 1 should pass');

  const req2 = { ip: '1.2.3.4', headers: { 'x-test-rate-limit': 'true' } };
  let next2Called = false;
  limiter(req2, mockRes(), () => { next2Called = true; });
  assert.equal(next2Called, true, 'Request 2 should pass');

  const req3 = { ip: '1.2.3.4', headers: { 'x-test-rate-limit': 'true' } };
  let next3Called = false;
  limiter(req3, mockRes(), () => { next3Called = true; });
  assert.equal(next3Called, false, 'Request 3 should be blocked');
  assert.equal(statusSent, 429);
  assert.equal(jsonSent.message, 'Too many requests');
});
