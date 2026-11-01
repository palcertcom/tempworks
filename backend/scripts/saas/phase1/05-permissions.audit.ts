/**
 * Audit E — Permissions / RBAC.
 */
import { runAudit, tableExists, AuditFinding, AuditMetric } from './lib/audit';
import path from 'path';

async function main(): Promise<void> {
  const outDir = path.resolve(__dirname, '..', '..', '..', 'reports', 'saas', 'phase1');
  await runAudit('05-permissions', 'Audit E — Permissions / RBAC', outDir, async (ctx) => {
    const m: AuditMetric[] = [];
    const f: AuditFinding[] = [];
    const c = ctx.client;

    if (await tableExists(c, 'Role')) {
      const r = await c.query<{ id: string; name: string; isSystem: boolean | null }>(
        `SELECT id::text, name, COALESCE("isSystem", false) AS "isSystem" FROM "Role" ORDER BY name`,
      );
      m.push({ key: 'roles.total', value: r.rowCount ?? 0 });
      f.push({ severity: 'INFO', rule: 'roles.snapshot', message: `Found ${r.rowCount} roles.`, detail: r.rows });
    } else {
      f.push({ severity: 'BLOCKER', rule: 'roles.missing-table', message: 'Role table not found.' });
    }

    if (await tableExists(c, 'Permission')) {
      const total = (await c.query<{ n: number }>(`SELECT count(*)::int n FROM "Permission"`)).rows[0].n;
      m.push({ key: 'permissions.total', value: total });
    }

    if (await tableExists(c, 'RolePermission')) {
      const rp = (await c.query<{ n: number }>(`SELECT count(*)::int n FROM "RolePermission"`)).rows[0].n;
      m.push({ key: 'role-permission.total', value: rp });
    }

    // Per-user permission grants today (will become MembershipPermissionOverride)
    if (await tableExists(c, 'agency_user_permission')) {
      const n = (await c.query<{ n: number }>(
        `SELECT count(*)::int n FROM agency_user_permission`,
      )).rows[0].n;
      m.push({ key: 'agency-user-permissions.total', value: n });
      if (n > 0) {
        f.push({
          severity: 'INFO',
          rule: 'rbac.user-permission-overrides',
          message: `${n} per-user permission rows must be migrated to MembershipPermissionOverride.`,
        });
      }
    }

    if (await tableExists(c, 'agency_permission_overrides')) {
      const n = (await c.query<{ n: number }>(
        `SELECT count(*)::int n FROM agency_permission_overrides`,
      )).rows[0].n;
      m.push({ key: 'agency-permission-overrides.total', value: n });
    }

    if (await tableExists(c, 'employee_agency_access')) {
      const n = (await c.query<{ n: number }>(
        `SELECT count(*)::int n FROM employee_agency_access`,
      )).rows[0].n;
      m.push({ key: 'employee-agency-access.total', value: n });
      if (n > 0) {
        f.push({
          severity: 'INFO',
          rule: 'rbac.employee-cross-agency',
          message: `${n} cross-agency employee grants — these become AgencyMembership rows in Phase 1.`,
        });
      }
    }

    // Users with system-level access today (via system role OR system agency)
    if (await tableExists(c, 'users') && await tableExists(c, 'agencies')) {
      const sysUsers = await c.query<{ id: string; email: string; via: string }>(
        `SELECT u.id::text, u.email,
                CASE WHEN a."isSystem" = true THEN 'system-agency'
                     WHEN r."isSystem" = true THEN 'system-role'
                     ELSE 'unknown' END AS via
           FROM users u
           LEFT JOIN agencies a ON a.id = u."agencyId"
           LEFT JOIN "Role" r   ON r.id = u."roleId"
          WHERE a."isSystem" = true OR r."isSystem" = true
          ORDER BY u.email`,
      );
      m.push({ key: 'users.system-level', value: sysUsers.rowCount ?? 0 });
      if ((sysUsers.rowCount ?? 0) > 0) {
        f.push({
          severity: 'INFO',
          rule: 'rbac.platform-admin-projection',
          message: `${sysUsers.rowCount} users have system-level access today; PlatformAdmin backfill input.`,
          detail: sysUsers.rows.slice(0, 50),
        });
      }
    }

    return {
      metrics: m,
      findings: f,
      notes: [
        'Each existing User.roleId is cloned into one MembershipRole at backfill (one membership per existing User × Agency pair).',
        'agency_user_permission rows are migrated 1:1 into MembershipPermissionOverride keyed by membershipId.',
      ],
    };
  });
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(2); });
export {};
