'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const twoFactorService = require('../../services/twoFactor.service');
const { setPool } = require('../../config/database');
const agentsService = require('../../services/agents.service');
const usersRepository = require('../../repositories/users.repository');
const agentsRepository = require('../../repositories/agents.repository');

function createMockPool(handler) {
  const client = {
    async query(sql, params) {
      if (handler) return handler(sql, params);
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  return {
    client,
    async connect() {
      return client;
    },
    async query(sql, params) {
      if (handler) return handler(sql, params);
      return { rows: [], rowCount: 1 };
    },
  };
}

test('twoFactor.service: verifyOTP validates correctly with constant-time comparison', () => {
  const storedOTP = '654321';
  const expiresAt = new Date(Date.now() + 60000);

  // 1. Valid match
  const valid = twoFactorService.verifyOTP(storedOTP, '654321', expiresAt);
  assert.equal(valid.valid, true);

  // 2. Mismatched code
  const invalid = twoFactorService.verifyOTP(storedOTP, '123456', expiresAt);
  assert.equal(invalid.valid, false);

  // 3. Different length
  const mismatchLength = twoFactorService.verifyOTP(storedOTP, '65432', expiresAt);
  assert.equal(mismatchLength.valid, false);

  // 4. Expired code
  const expired = twoFactorService.verifyOTP(storedOTP, '654321', new Date(Date.now() - 1000));
  assert.equal(expired.valid, false);
  assert.match(expired.message, /expired/i);
});

test('twoFactor.service: verifyTOTP validates accurately across time window', async () => {
  const setup = await twoFactorService.setupTOTP('test@aritii.com');
  const rawBase32 = setup.secret;

  // Generate valid token for current time using computeTOTP
  const currentToken = twoFactorService.computeTOTP(rawBase32);

  const valid = twoFactorService.verifyTOTP(rawBase32, currentToken);
  assert.equal(valid, true, 'Current valid token must pass');

  const invalid = twoFactorService.verifyTOTP(rawBase32, '000000');
  assert.equal(invalid, false, 'Invalid token must fail');

  const malformed = twoFactorService.verifyTOTP(rawBase32, 'abc');
  assert.equal(malformed, false, 'Non-digit token must fail');
});

test('twoFactor.service: verifyBackupCode verifies and single-use consumes code', async () => {
  const rawCode = 'ABCD-1234';
  const hashedCode = twoFactorService.hashBackupCode(rawCode);
  const remainingCode = twoFactorService.hashBackupCode('EFGH-5678');

  let updatedBackupCodes = null;

  const mockPool = {
    async query(sql, params) {
      const text = String(sql);
      if (/SELECT backup_codes FROM users/i.test(text)) {
        return {
          rows: [{ backup_codes: [hashedCode, remainingCode] }],
          rowCount: 1,
        };
      }
      if (/UPDATE users SET backup_codes/i.test(text)) {
        updatedBackupCodes = params[0];
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };

  const res = await twoFactorService.verifyBackupCode(mockPool, 'user-1', rawCode);
  assert.equal(res.valid, true);
  assert.equal(res.codesRemaining, 1);
  assert.deepEqual(updatedBackupCodes, [remainingCode]);

  // Attempting to reuse or invalid code fails
  const mockPoolEmpty = {
    async query() {
      return { rows: [{ backup_codes: [remainingCode] }], rowCount: 1 };
    },
  };
  const invalidRes = await twoFactorService.verifyBackupCode(mockPoolEmpty, 'user-1', rawCode);
  assert.equal(invalidRes.valid, false);
});

test('twoFactor.service: enable2FA atomically activates 2FA and clears pending columns', async () => {
  let executedSql = '';
  let queryParams = null;

  const mockPool = {
    async query(sql, params) {
      executedSql = String(sql);
      queryParams = params;
      return {
        rows: [{
          id: 'user-2fa-1',
          email: 'test@aritii.com',
          two_factor_enabled: true,
          two_factor_type: 'TOTP',
        }],
        rowCount: 1,
      };
    },
  };

  const res = await twoFactorService.enable2FA(
    mockPool,
    'user-2fa-1',
    'TOTP',
    'BASE32SECRET',
    ['CODE1-1111', 'CODE2-2222'],
    '+251911223344',
    '+251911223344'
  );

  assert.equal(res.two_factor_enabled, true);
  assert.equal(res.two_factor_type, 'TOTP');
  assert.match(executedSql, /two_factor_pending_secret = NULL/);
  assert.match(executedSql, /two_factor_pending_otp = NULL/);
  assert.match(executedSql, /two_factor_pending_method = NULL/);
  assert.match(executedSql, /two_factor_pending_expires_at = NULL/);
});

test('agents.service: verifyAgent runs inside withTransaction', async () => {
  const origFindById = agentsRepository.findById;
  const origUpdateFields = agentsRepository.updateFields;

  setPool(createMockPool());

  let updatedParams = null;

  try {
    agentsRepository.findById = async (id, client) => {
      assert.ok(client, 'findById must receive transactional client');
      return {
        id,
        verificationStatus: 'PENDING',
        isActive: false,
      };
    };

    agentsRepository.updateFields = async (opts) => {
      assert.ok(opts.client, 'updateFields must receive transactional client');
      updatedParams = opts;
      return { id: opts.id, ...opts.fields };
    };

    const res = await agentsService.verifyAgent({
      agentId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      verificationStatus: 'APPROVED',
    });

    assert.equal(res.verification_status, 'APPROVED');
    assert.equal(res.is_active, true);
  } finally {
    agentsRepository.findById = origFindById;
    agentsRepository.updateFields = origUpdateFields;
    setPool(null);
  }
});
