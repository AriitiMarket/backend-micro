// PostgreSQL connection pool and schema bootstrap for Identity Service.
const { Pool } = require('pg');
const env = require('./env');

let pool = null;
let initPromise = null;

function createPool() {
  const p = new Pool({
    connectionString: env.databaseUrl,
    // Abort a *single* connection attempt after this long (default 30s). The old
    // hard-coded 5s was shorter than a cold-boot DNS/TCP handshake, which is what
    // produced "Connection terminated due to connection timeout" during startup.
    connectionTimeoutMillis: env.dbConnectTimeoutMs,
    // Client-side guard so a wedged socket cannot hang a request forever.
    query_timeout: env.dbQueryTimeoutMs,
    // Server-side guard against transactions left idle by a crashed worker.
    idle_in_transaction_session_timeout: env.dbIdleInTransactionTimeoutMs,
    idleTimeoutMillis: env.dbIdleTimeoutMs,
    max: env.dbPoolMax,
    // The HTTP listener owns the event loop; never let an idle pool exit on us.
    allowExitOnIdle: false,
  });

  // CRITICAL: a pg Pool emits 'error' when a client breaks while idle (postgres
  // restart, network partition). With no listener, Node promotes that to an
  // uncaught exception and kills the process — a premature crash that would
  // abort the startup retry loop before it can ever finish.
  p.on('error', (err) => {
    console.error('[identity] unexpected PostgreSQL pool error:', err.message);
  });

  return p;
}

function getPoolInstance() {
  if (!pool) pool = createPool();
  return pool;
}

async function initPool() {
  if (initPromise) return initPromise;
  const p = getPoolInstance();

  // Single-flight: the startup probe and concurrent /health calls share one
  // attempt instead of each building (and leaking) their own pool.
  initPromise = (async () => {
    await p.query('SELECT 1');
    await initSchema(p);
    return p;
  })();

  try {
    return await initPromise;
  } catch (err) {
    // Drop the cached attempt so the caller's retry loop can try again on the
    // same, still-usable pool (pg-pool evicts the dead client itself).
    initPromise = null;
    throw err;
  }
}

async function initSchema(p) {
  await p.query(`
    CREATE TABLE IF NOT EXISTS roles (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT UNIQUE NOT NULL
    );
  `);
  await p.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      phone_number TEXT,
      role TEXT NOT NULL DEFAULT 'BUYER',
      active_role TEXT,
      avatar_public_id TEXT,
      avatar_url TEXT,
      addresses JSONB NOT NULL DEFAULT '[]',
      shop_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      is_verified BOOLEAN NOT NULL DEFAULT false,
      seller_status TEXT NOT NULL DEFAULT 'INACTIVE',
      admin_scope JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);`);
  await p.query(`INSERT INTO roles (name) VALUES ('BUYER') ON CONFLICT (name) DO NOTHING;`);
  await p.query(`INSERT INTO roles (name) VALUES ('SELLER') ON CONFLICT (name) DO NOTHING;`);
  await p.query(`INSERT INTO roles (name) VALUES ('PROVIDER') ON CONFLICT (name) DO NOTHING;`);
  await p.query(`INSERT INTO roles (name) VALUES ('AGENT') ON CONFLICT (name) DO NOTHING;`);
  await p.query(`INSERT INTO roles (name) VALUES ('ADMIN') ON CONFLICT (name) DO NOTHING;`);

  // Agents — one record per user; sector is referenced by id (managed in commerce-service).
  await p.query(`
    CREATE TABLE IF NOT EXISTS agents (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      sector_id TEXT,
      commission_rate NUMERIC(5,2) NOT NULL DEFAULT 5.00,
      is_active BOOLEAN NOT NULL DEFAULT false,
      verification_status TEXT NOT NULL DEFAULT 'PENDING',
      documents JSONB NOT NULL DEFAULT '[]',
      rating NUMERIC(3,2) NOT NULL DEFAULT 0.00,
      total_transactions INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_agents_user ON agents(user_id);`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_agents_sector ON agents(sector_id);`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(verification_status);`);
  // Idempotent unique constraint on user_id (one agent record per user).
  await p.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'agents_user_unique'
      ) THEN
        ALTER TABLE agents ADD CONSTRAINT agents_user_unique UNIQUE (user_id);
      END IF;
    END $$;
  `);

  // Admin scope column — stores location/service permissions for admin users.
  await p.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'admin_scope'
      ) THEN
        ALTER TABLE users ADD COLUMN admin_scope JSONB NOT NULL DEFAULT '{}';
      END IF;
    END $$;
  `);
  // Seller status column (phase 3 migration idempotent).
  await p.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'seller_status'
      ) THEN
        ALTER TABLE users ADD COLUMN seller_status TEXT NOT NULL DEFAULT 'INACTIVE';
      END IF;
    END $$;
  `);

  // Active actor role — which of the account's roles it is CURRENTLY acting as.
  //
  // NULL means "use the primary role". It is persisted (rather than only living
  // in the token) so a deliberate switch survives token rotation: the refresh
  // grant re-mints the access token from this column instead of silently
  // reverting to the primary role ten minutes later.
  await p.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'active_role'
      ) THEN
        ALTER TABLE users ADD COLUMN active_role TEXT;
      END IF;
    END $$;
  `);

  // Actor memberships — one account, many actors.
  //
  // `users.role` is the PRIMARY role (and the only home of ADMIN). Actor roles
  // are held here instead, so granting a provider membership to an existing
  // seller no longer overwrites their seller role. BUYER is implicit for
  // every account, so a buyer needs no row.
  //
  // `onboarding_completed` records whether the applicant actually finished the
  // role-specific wizard (store/vehicle setup) after registering, as opposed to
  // registering and walking away. A registration writes it as `false`; the first
  // application submission (or an admin approval) flips it to `true`. It is what
  // lets the abandoned-application sweep tell "registered but never submitted"
  // apart from "submitted and awaiting review" — both of which live in PENDING.
  await p.query(`
    CREATE TABLE IF NOT EXISTS user_roles (
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      source TEXT NOT NULL DEFAULT 'ADMIN',
      granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      onboarding_completed BOOLEAN NOT NULL DEFAULT true,
      onboarding_started_at TIMESTAMPTZ,
      onboarding_completed_at TIMESTAMPTZ,
      PRIMARY KEY (user_id, role)
    );
  `);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_user_roles_user ON user_roles(user_id);`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_user_roles_role_status ON user_roles(role, status);`);

  // Onboarding columns — idempotent upgrade for a database created before the
  // abandoned-application sweep existed. `DEFAULT true` keeps every pre-existing
  // membership reading as already-onboarded, so the sweep can never delete a row
  // that merely predates the column.
  await p.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns WHERE table_name = 'user_roles' AND column_name = 'onboarding_completed'
      ) THEN
        ALTER TABLE user_roles ADD COLUMN onboarding_completed BOOLEAN NOT NULL DEFAULT true;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns WHERE table_name = 'user_roles' AND column_name = 'onboarding_started_at'
      ) THEN
        ALTER TABLE user_roles ADD COLUMN onboarding_started_at TIMESTAMPTZ;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns WHERE table_name = 'user_roles' AND column_name = 'onboarding_completed_at'
      ) THEN
        ALTER TABLE user_roles ADD COLUMN onboarding_completed_at TIMESTAMPTZ;
      END IF;
    END $$;
  `);
  // The sweep filters on exactly this shape (role + status + not-yet-onboarded),
  // so give it a partial index rather than scanning the whole membership table.
  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_user_roles_abandoned_onboarding
      ON user_roles (role, COALESCE(onboarding_started_at, granted_at))
      WHERE status = 'PENDING' AND onboarding_completed = false;
  `);

  // Legacy role vocabulary — CUSTOMER becomes BUYER.
  //
  // BUYER is the one canonical buyer actor across registration, tokens, gateway
  // headers and route gates; CUSTOMER is kept only as a read-time alias
  // (models/Role.normalizeRole). Both statements are idempotent and run on every
  // boot, which is this project's migration mechanism, so a database created
  // before the rename converges without a manual step. Existing CREATE TABLE
  // defaults are rewritten too — a fresh install and an upgraded one must agree.
  //
  // These statements rewrite `active_role` and `user_roles`, so they must run
  // AFTER the column/table exist (the ALTER and CREATE above): on a fresh
  // database they used to execute first, throw, and strand initSchema in an
  // endless readiness-retry loop.
  await p.query(`
    ALTER TABLE users ALTER COLUMN role SET DEFAULT 'BUYER';
  `);
  await p.query(`
    UPDATE users
       SET role = 'BUYER',
           updated_at = NOW()
     WHERE UPPER(role) = 'CUSTOMER';
  `);
  await p.query(`
    UPDATE users
       SET active_role = 'BUYER',
           updated_at = NOW()
     WHERE UPPER(COALESCE(active_role, '')) = 'CUSTOMER';
  `);
  // A membership row for the legacy spelling would be unreachable by the
  // canonical gates — rename it (the primary key may collide with a BUYER row,
  // so the BUYER row already says what we need).
  await p.query(`
    UPDATE user_roles
       SET role = 'BUYER'
     WHERE UPPER(role) = 'CUSTOMER'
       AND NOT EXISTS (
         SELECT 1 FROM user_roles other
          WHERE other.user_id = user_roles.user_id AND other.role = 'BUYER'
       );
  `);
  await p.query(`
    DELETE FROM user_roles WHERE UPPER(role) = 'CUSTOMER';
  `);
  // The role CATALOGUE is what the admin console lists (roles.repository), so
  // the legacy synonym must not survive there either. Nothing references
  // `roles` by foreign key — it is a lookup table — so removing the row cannot
  // break a write. BUYER is inserted above; CUSTOMER is only read (as an alias)
  // by models/Role.normalizeRole.
  await p.query(`DELETE FROM roles WHERE name = 'CUSTOMER';`);

  // Backfill existing accounts so nobody loses access on deploy.
  //
  // Deliberately PERMISSIVE: today a mere `users.role = 'SELLER'` grants seller
  // access, so every seller must come out of this ACTIVE. Only the statuses that
  // already block them (SUSPENDED / REJECTED) are carried over. Idempotent, so
  // it is safe to run on every boot.
  await p.query(`
    INSERT INTO user_roles (user_id, role, status, source)
    SELECT id,
           role,
           CASE
             WHEN UPPER(COALESCE(seller_status, '')) IN ('SUSPENDED', 'REJECTED')
               THEN UPPER(seller_status)
             ELSE 'ACTIVE'
           END,
           'MIGRATION'
    FROM users
    WHERE role IN ('SELLER', 'PROVIDER', 'AGENT')
    ON CONFLICT (user_id, role) DO NOTHING;
  `);

  // Refresh tokens — server-managed rotation, one active per session family.
  await p.query(`
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT UNIQUE NOT NULL,
      family_id UUID NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash ON refresh_tokens(token_hash);`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_refresh_tokens_family ON refresh_tokens(family_id);`);

  // Authorization codes — short-lived, PKCE-bound, single-use.
  await p.query(`
    CREATE TABLE IF NOT EXISTS authorization_codes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_hash TEXT UNIQUE NOT NULL,
      code_challenge TEXT NOT NULL,
      code_challenge_method TEXT NOT NULL DEFAULT 'S256',
      redirect_uri TEXT,
      scope TEXT NOT NULL DEFAULT 'openid profile email',
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_auth_codes_hash ON authorization_codes(code_hash);`);

  // Audit logs table — persists all sensitive admin actions.
  await p.query(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      action TEXT NOT NULL,
      level TEXT NOT NULL DEFAULT 'INFO',
      admin_id TEXT,
      admin_name TEXT,
      module TEXT,
      target_entity TEXT,
      target_id TEXT,
      previous_value JSONB,
      new_value JSONB,
      reason TEXT,
      details JSONB NOT NULL DEFAULT '{}',
      ip_address TEXT,
      user_agent TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(timestamp DESC);`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_admin ON audit_logs(admin_id);`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_target ON audit_logs(target_entity, target_id);`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_module ON audit_logs(module);`);

  // ── Admin Roles & Permissions ──

  // Permission definitions — all available permissions in the system.
  await p.query(`
    CREATE TABLE IF NOT EXISTS admin_permissions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      key TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      module TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_admin_permissions_module ON admin_permissions(module);`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_admin_permissions_key ON admin_permissions(key);`);

  // Admin role definitions — each role has a set of permission keys.
  await p.query(`
    CREATE TABLE IF NOT EXISTS admin_roles (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT UNIQUE NOT NULL,
      display_name TEXT NOT NULL,
      description TEXT,
      permissions JSONB NOT NULL DEFAULT '[]',
      is_system BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_admin_roles_name ON admin_roles(name);`);

  // Link users to admin roles (supports role assignment per user).
  await p.query(`
    CREATE TABLE IF NOT EXISTS admin_user_roles (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role_id UUID NOT NULL REFERENCES admin_roles(id) ON DELETE CASCADE,
      assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      assigned_by UUID,
      UNIQUE(user_id, role_id)
    );
  `);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_admin_user_roles_user ON admin_user_roles(user_id);`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_admin_user_roles_role ON admin_user_roles(role_id);`);

  // Seed default permissions.
  const defaultPermissions = [
    { key: 'dashboard.view', name: 'View Dashboard', module: 'dashboard', description: 'View the admin dashboard and overview stats' },
    { key: 'users.view', name: 'View Users', module: 'users', description: 'View user accounts and profiles' },
    { key: 'users.manage', name: 'Manage Users', module: 'users', description: 'Create, update, suspend, or ban users' },
    { key: 'businesses.view', name: 'View Businesses', module: 'businesses', description: 'View seller businesses and applications' },
    { key: 'businesses.manage', name: 'Manage Businesses', module: 'businesses', description: 'Approve, reject, or suspend seller businesses' },
    { key: 'shops.view', name: 'View Shops', module: 'shops', description: 'View shops and their details' },
    { key: 'shops.manage', name: 'Manage Shops', module: 'shops', description: 'Approve, reject, or suspend shops' },
    { key: 'locations.view', name: 'View Locations', module: 'locations', description: 'View locations, sectors, and zones' },
    { key: 'locations.manage', name: 'Manage Locations', module: 'locations', description: 'Create, update, or delete locations and zones' },
    { key: 'commerce.view', name: 'View Commerce', module: 'commerce', description: 'View products, categories, and commerce overview' },
    { key: 'commerce.manage', name: 'Manage Commerce', module: 'commerce', description: 'Manage products, categories, and promotions' },
    { key: 'orders.view', name: 'View Orders', module: 'orders', description: 'View orders and transaction history' },
    { key: 'orders.manage', name: 'Manage Orders', module: 'orders', description: 'Update order statuses and process refunds' },
    { key: 'delivery.view', name: 'View Delivery', module: 'delivery', description: 'View delivery operations and rider stats' },
    { key: 'delivery.manage', name: 'Manage Delivery', module: 'delivery', description: 'Manage riders, assignments, and delivery zones' },
    { key: 'disputes.view', name: 'View Disputes', module: 'disputes', description: 'View disputes and complaints' },
    { key: 'disputes.manage', name: 'Manage Disputes', module: 'disputes', description: 'Resolve, reject, or close disputes' },
    { key: 'reports.view', name: 'View Reports', module: 'reports', description: 'View analytics reports and data exports' },
    { key: 'audit.view', name: 'View Audit Logs', module: 'audit', description: 'View the audit log trail' },
    { key: 'audit.manage', name: 'Clear Audit Logs', module: 'audit', description: 'Permanently delete audit log entries (destructive; every purge is itself audited)' },
    { key: 'platform_settings.view', name: 'View Platform Settings', module: 'settings', description: 'View platform configuration' },
    { key: 'platform_settings.manage', name: 'Manage Platform Settings', module: 'settings', description: 'Update platform configuration' },
    { key: 'admin_roles.view', name: 'View Admin Roles', module: 'admin_roles', description: 'View admin roles and permissions' },
    { key: 'admin_roles.manage', name: 'Manage Admin Roles', module: 'admin_roles', description: 'Create, update, or delete admin roles' },
  ];
  for (const perm of defaultPermissions) {
    await p.query(
      `INSERT INTO admin_permissions (key, name, module, description) VALUES ($1, $2, $3, $4) ON CONFLICT (key) DO NOTHING;`,
      [perm.key, perm.name, perm.module, perm.description]
    );
  }

  // Seed default system roles.
  const defaultRoles = [
    {
      name: 'SUPER_ADMIN',
      display_name: 'Super Admin',
      description: 'Full system access with all permissions',
      permissions: defaultPermissions.map(p => p.key),
      is_system: true,
    },
    {
      name: 'OPERATIONAL_ADMIN',
      display_name: 'Operational Admin',
      description: 'Runs daily orders, delivery, and dispute operations without access to RBAC, platform settings, or financial configuration',
      permissions: [
        'dashboard.view',
        'users.view',
        'businesses.view',
        'shops.view',
        'locations.view',
        'orders.view',
        'orders.manage',
        'delivery.view',
        'delivery.manage',
        'disputes.view',
        'disputes.manage',
        'reports.view',
        'audit.view',
      ],
      is_system: true,
    },
    {
      name: 'SELLER_ADMIN',
      display_name: 'Seller Admin',
      description: 'Manages sellers, businesses, shops, and commerce',
      permissions: ['dashboard.view', 'users.view', 'businesses.view', 'businesses.manage', 'shops.view', 'shops.manage', 'commerce.view', 'commerce.manage', 'orders.view', 'orders.manage', 'disputes.view', 'disputes.manage', 'reports.view'],
      is_system: true,
    },
    {
      name: 'RIDER_ADMIN',
      display_name: 'Rider Admin',
      description: 'Manages riders, delivery operations, and zones',
      permissions: ['dashboard.view', 'users.view', 'delivery.view', 'delivery.manage', 'locations.view', 'orders.view', 'disputes.view', 'reports.view'],
      is_system: true,
    },
    {
      name: 'CUSTOMER_ADMIN',
      display_name: 'Customer Admin',
      description: 'Manages customers, orders, and dispute resolution',
      permissions: ['dashboard.view', 'users.view', 'users.manage', 'orders.view', 'orders.manage', 'disputes.view', 'disputes.manage', 'reports.view', 'businesses.view', 'shops.view'],
      is_system: true,
    },
  ];
  for (const role of defaultRoles) {
    await p.query(
      `INSERT INTO admin_roles (name, display_name, description, permissions, is_system)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (name) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         description = EXCLUDED.description,
         permissions = EXCLUDED.permissions,
         is_system = EXCLUDED.is_system,
         updated_at = NOW();`,
      [role.name, role.display_name, role.description, JSON.stringify(role.permissions), role.is_system]
    );
  }

  // Clean up expired refresh tokens and auth codes periodically.
  await p.query(`
    CREATE OR REPLACE FUNCTION cleanup_expired_tokens() RETURNS void AS $$
    BEGIN
      DELETE FROM refresh_tokens WHERE expires_at < NOW() OR revoked_at IS NOT NULL;
      DELETE FROM authorization_codes WHERE expires_at < NOW() OR used_at IS NOT NULL;
    END;
    $$ LANGUAGE plpgsql;
  `);

  // ── 2FA columns (migrations 003, 004, 005) — idempotent on every boot ──────
  await p.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_enabled BOOLEAN DEFAULT false;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_secret VARCHAR(255);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_type VARCHAR(50);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS backup_codes TEXT[];
    ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_setup_at TIMESTAMP;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_verified_at TIMESTAMP;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_pending_secret VARCHAR(255);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_pending_method VARCHAR(50);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_pending_otp VARCHAR(255);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_pending_expires_at TIMESTAMP;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_pending_phone VARCHAR(50);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_destination VARCHAR(255);
  `);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_users_2fa_enabled ON users(two_factor_enabled);`);

  // ── Password Resets table (migration 006) ──────────────────────────────────
  await p.query(`
    CREATE TABLE IF NOT EXISTS password_resets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT UNIQUE NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      ip_address TEXT,
      user_agent TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_password_resets_token_hash ON password_resets(token_hash);`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_password_resets_user_id ON password_resets(user_id);`);
}

async function getPool() {
  return initPool();
}

module.exports = { getPool };
