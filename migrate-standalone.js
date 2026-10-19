/**
 * Standalone migration: 4-role → 2-role system
 * Run directly with: node migrate-standalone.js
 */

const { Pool } = require('pg');

// Database connection
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  database: process.env.DB_NAME || 'aritii_identity',
});

const NEW_ROLES = {
  SUPER_ADMIN: {
    displayName: 'Super Administrator',
    description: 'Full platform access including settings, audit logs, and admin management',
    isSystem: true,
    permissions: [
      'locations.view', 'locations.manage',
      'delivery.view', 'delivery.manage',
      'orders.view', 'orders.manage',
      'disputes.view', 'disputes.manage',
      'businesses.view', 'businesses.manage',
      'shops.view', 'shops.manage',
      'commerce.view', 'commerce.manage',
      'admin_roles.view', 'admin_roles.manage',
      'audit.view', 'audit.manage',
      'platform_settings.view', 'platform_settings.manage',
      'reports.view',
      '*',
    ],
  },
  OPERATIONS_ADMIN: {
    displayName: 'Operations Administrator',
    description: 'Day-to-day operations: users, orders, disputes, delivery, analytics',
    isSystem: true,
    permissions: [
      'delivery.view', 'delivery.manage',
      'orders.view', 'orders.manage',
      'disputes.view', 'disputes.manage',
      'businesses.view', 'shops.view',
      'commerce.view', 'reports.view',
    ],
  },
};

async function migrate() {
  try {
    console.log('Starting migration: 4-role → 2-role system\n');

    // Step 1: Check current state
    console.log('Step 1: Checking current state...');
    const currentRoles = await pool.query(
      'SELECT id, name, display_name FROM admin_roles ORDER BY name;'
    );
    console.log(`Found ${currentRoles.rows.length} roles:`);
    currentRoles.rows.forEach(r => console.log(`  - ${r.name}`));
    console.log();

    // Step 2: Count admins by current role
    console.log('Step 2: Counting admins by current role...');
    const adminsByRole = await pool.query(`
      SELECT ar.name, COUNT(aur.user_id) as count
      FROM admin_roles ar
      LEFT JOIN admin_user_roles aur ON aur.role_id = ar.id
      GROUP BY ar.name
      ORDER BY ar.name;
    `);
    console.log('Current admin distribution:');
    adminsByRole.rows.forEach(r => console.log(`  - ${r.name}: ${r.count} admins`));
    console.log();

    // Step 3: Create SUPER_ADMIN
    console.log('Step 3: Creating/updating SUPER_ADMIN...');
    const superAdmin = await pool.query(
      'SELECT id FROM admin_roles WHERE name = $1;',
      ['SUPER_ADMIN']
    );

    let superAdminId;
    if (superAdmin.rows[0]) {
      superAdminId = superAdmin.rows[0].id;
      await pool.query(
        `UPDATE admin_roles 
         SET permissions = $1, display_name = $2, description = $3, is_system = true, updated_at = NOW()
         WHERE name = 'SUPER_ADMIN';`,
        [
          JSON.stringify(NEW_ROLES.SUPER_ADMIN.permissions),
          NEW_ROLES.SUPER_ADMIN.displayName,
          NEW_ROLES.SUPER_ADMIN.description,
        ]
      );
      console.log(`  ✓ Updated SUPER_ADMIN`);
    } else {
      const result = await pool.query(
        `INSERT INTO admin_roles (name, display_name, description, permissions, is_system)
         VALUES ($1, $2, $3, $4, true)
         RETURNING id;`,
        [
          'SUPER_ADMIN',
          NEW_ROLES.SUPER_ADMIN.displayName,
          NEW_ROLES.SUPER_ADMIN.description,
          JSON.stringify(NEW_ROLES.SUPER_ADMIN.permissions),
        ]
      );
      superAdminId = result.rows[0].id;
      console.log(`  ✓ Created SUPER_ADMIN`);
    }
    console.log();

    // Step 4: Create OPERATIONS_ADMIN
    console.log('Step 4: Creating/updating OPERATIONS_ADMIN...');
    const opsAdmin = await pool.query(
      'SELECT id FROM admin_roles WHERE name = $1;',
      ['OPERATIONS_ADMIN']
    );

    let opsAdminId;
    if (opsAdmin.rows[0]) {
      opsAdminId = opsAdmin.rows[0].id;
      await pool.query(
        `UPDATE admin_roles 
         SET permissions = $1, display_name = $2, description = $3, is_system = true, updated_at = NOW()
         WHERE name = 'OPERATIONS_ADMIN';`,
        [
          JSON.stringify(NEW_ROLES.OPERATIONS_ADMIN.permissions),
          NEW_ROLES.OPERATIONS_ADMIN.displayName,
          NEW_ROLES.OPERATIONS_ADMIN.description,
        ]
      );
      console.log(`  ✓ Updated OPERATIONS_ADMIN`);
    } else {
      const result = await pool.query(
        `INSERT INTO admin_roles (name, display_name, description, permissions, is_system)
         VALUES ($1, $2, $3, $4, true)
         RETURNING id;`,
        [
          'OPERATIONS_ADMIN',
          NEW_ROLES.OPERATIONS_ADMIN.displayName,
          NEW_ROLES.OPERATIONS_ADMIN.description,
          JSON.stringify(NEW_ROLES.OPERATIONS_ADMIN.permissions),
        ]
      );
      opsAdminId = result.rows[0].id;
      console.log(`  ✓ Created OPERATIONS_ADMIN`);
    }
    console.log();

    // Step 5: Migrate admin assignments
    console.log('Step 5: Migrating admin role assignments...');
    const oldRoles = ['SELLER_ADMIN', 'RIDER_ADMIN', 'CUSTOMER_ADMIN'];
    let totalMigrated = 0;

    for (const oldRole of oldRoles) {
      const oldRoleResult = await pool.query(
        'SELECT id FROM admin_roles WHERE name = $1;',
        [oldRole]
      );

      if (oldRoleResult.rows[0]) {
        const oldRoleId = oldRoleResult.rows[0].id;
        const countResult = await pool.query(
          'SELECT COUNT(*) as count FROM admin_user_roles WHERE role_id = $1;',
          [oldRoleId]
        );
        const count = parseInt(countResult.rows[0].count, 10);

        if (count > 0) {
          await pool.query(
            'UPDATE admin_user_roles SET role_id = $1 WHERE role_id = $2;',
            [opsAdminId, oldRoleId]
          );
          console.log(`  ✓ Migrated ${count} ${oldRole} → OPERATIONS_ADMIN`);
          totalMigrated += count;
        }
      }
    }
    console.log(`  ✓ Total: ${totalMigrated} admins migrated`);
    console.log();

    // Step 6: Verify final state
    console.log('Step 6: Verifying final state...');
    const finalRoles = await pool.query(
      'SELECT id, name FROM admin_roles ORDER BY name;'
    );
    console.log(`Final roles (${finalRoles.rows.length} total):`);
    finalRoles.rows.forEach(r => console.log(`  - ${r.name}`));
    console.log();

    const finalAdmins = await pool.query(`
      SELECT ar.name, COUNT(aur.user_id) as count
      FROM admin_roles ar
      LEFT JOIN admin_user_roles aur ON aur.role_id = ar.id
      GROUP BY ar.name
      ORDER BY ar.name;
    `);
    console.log('Final admin distribution:');
    finalAdmins.rows.forEach(r => console.log(`  - ${r.name}: ${r.count} admins`));
    console.log();

    console.log('✅ Migration complete!');
    await pool.end();
  } catch (err) {
    console.error('❌ Error:', err.message);
    await pool.end();
    process.exit(1);
  }
}

migrate();
