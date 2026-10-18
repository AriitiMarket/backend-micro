/**
 * Migration: Migrate from 4-role system to 2-role system
 *
 * Changes:
 * - SELLER_ADMIN → OPERATIONS_ADMIN
 * - RIDER_ADMIN → OPERATIONS_ADMIN
 * - CUSTOMER_ADMIN → OPERATIONS_ADMIN
 * - Delete old role records
 * - Ensure SUPER_ADMIN and OPERATIONS_ADMIN have correct permissions
 */

const { getPool } = require('../config/database');
const env = require('../config/env');

const ROLE_MAPPING = {
  SELLER_ADMIN: 'OPERATIONS_ADMIN',
  RIDER_ADMIN: 'OPERATIONS_ADMIN',
  CUSTOMER_ADMIN: 'OPERATIONS_ADMIN',
};

const NEW_ROLES = {
  SUPER_ADMIN: {
    displayName: 'Super Administrator',
    description: 'Full platform access including settings, audit logs, and admin management',
    isSystem: true,
    permissions: [
      'locations.view',
      'locations.manage',
      'delivery.view',
      'delivery.manage',
      'orders.view',
      'orders.manage',
      'disputes.view',
      'disputes.manage',
      'businesses.view',
      'businesses.manage',
      'shops.view',
      'shops.manage',
      'commerce.view',
      'commerce.manage',
      'admin_roles.view',
      'admin_roles.manage',
      'audit.view',
      'audit.manage',
      'platform_settings.view',
      'platform_settings.manage',
      'reports.view',
      '*',
    ],
  },
  OPERATIONS_ADMIN: {
    displayName: 'Operations Administrator',
    description: 'Day-to-day operations: users, orders, disputes, delivery, analytics',
    isSystem: true,
    permissions: [
      'delivery.view',
      'delivery.manage',
      'orders.view',
      'orders.manage',
      'disputes.view',
      'disputes.manage',
      'businesses.view',
      'shops.view',
      'commerce.view',
      'reports.view',
    ],
  },
};

async function migrate() {
  const pool = await getPool();

  try {
    console.log('Starting migration: 4-role → 2-role system\n');

    // ── Step 1: Check current state ──
    console.log('Step 1: Checking current state...');
    const currentRoles = await pool.query(
      'SELECT id, name, display_name FROM admin_roles ORDER BY name;'
    );
    console.log(`Found ${currentRoles.rows.length} roles:`);
    currentRoles.rows.forEach(r => console.log(`  - ${r.name} (${r.id})`));
    console.log();

    // ── Step 2: Count admins by current role ──
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

    // ── Step 3: Create or update SUPER_ADMIN ──
    console.log('Step 3: Ensuring SUPER_ADMIN role exists...');
    const superAdmin = await pool.query(
      'SELECT id FROM admin_roles WHERE name = $1;',
      ['SUPER_ADMIN']
    );

    let superAdminId;
    if (superAdmin.rows[0]) {
      superAdminId = superAdmin.rows[0].id;
      console.log(`  ✓ SUPER_ADMIN exists (ID: ${superAdminId})`);

      // Update SUPER_ADMIN permissions
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
      console.log('  ✓ Updated SUPER_ADMIN permissions');
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
      console.log(`  ✓ Created SUPER_ADMIN (ID: ${superAdminId})`);
    }
    console.log();

    // ── Step 4: Create or update OPERATIONS_ADMIN ──
    console.log('Step 4: Ensuring OPERATIONS_ADMIN role exists...');
    const opsAdmin = await pool.query(
      'SELECT id FROM admin_roles WHERE name = $1;',
      ['OPERATIONS_ADMIN']
    );

    let opsAdminId;
    if (opsAdmin.rows[0]) {
      opsAdminId = opsAdmin.rows[0].id;
      console.log(`  ✓ OPERATIONS_ADMIN exists (ID: ${opsAdminId})`);

      // Update OPERATIONS_ADMIN permissions
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
      console.log('  ✓ Updated OPERATIONS_ADMIN permissions');
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
      console.log(`  ✓ Created OPERATIONS_ADMIN (ID: ${opsAdminId})`);
    }
    console.log();

    // ── Step 5: Migrate admin role assignments ──
    console.log('Step 5: Migrating admin role assignments...');

    const oldRoles = ['SELLER_ADMIN', 'RIDER_ADMIN', 'CUSTOMER_ADMIN'];
    let totalMigrated = 0;

    for (const oldRole of oldRoles) {
      // Get the old role ID
      const oldRoleResult = await pool.query(
        'SELECT id FROM admin_roles WHERE name = $1;',
        [oldRole]
      );

      if (oldRoleResult.rows[0]) {
        const oldRoleId = oldRoleResult.rows[0].id;

        // Count admins with this role
        const countResult = await pool.query(
          'SELECT COUNT(*) as count FROM admin_user_roles WHERE role_id = $1;',
          [oldRoleId]
        );
        const count = parseInt(countResult.rows[0].count, 10);

        // Migrate to OPERATIONS_ADMIN
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
    console.log(`  ✓ Total migrated: ${totalMigrated} admins`);
    console.log();

    // ── Step 6: Delete old roles ──
    console.log('Step 6: Deleting old role records...');
    const deleteResult = await pool.query(
      `DELETE FROM admin_roles 
       WHERE name = ANY($1) AND is_system = false;`,
      [oldRoles]
    );
    console.log(`  ✓ Deleted ${deleteResult.rowCount} old role records`);
    console.log();

    // ── Step 7: Verify final state ──
    console.log('Step 7: Verifying final state...');
    const finalRoles = await pool.query(
      'SELECT id, name, display_name FROM admin_roles ORDER BY name;'
    );
    console.log(`Final roles (${finalRoles.rows.length} total):`);
    finalRoles.rows.forEach(r => console.log(`  - ${r.name} (${r.id})`));
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

    console.log('✅ Migration completed successfully!');
    console.log(
      '\nNext steps:\n' +
        '  1. Restart Identity Service\n' +
        '  2. Update Admin Web frontend (role type + routes)\n' +
        '  3. Test login as both SUPER_ADMIN and OPERATIONS_ADMIN\n'
    );
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

// Run migration
migrate();
