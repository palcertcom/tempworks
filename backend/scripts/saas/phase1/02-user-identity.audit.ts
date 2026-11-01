/**
 * Audit B — User Identity.
 *
 * Reports duplicate emails, NULL/invalid emails, orphan agency,
 * system-agency users, soft-deleted users, candidates for PlatformAdmin.
 */
import { runAudit, tableExists, columnExists, AuditFinding, AuditMetric } from './lib/audit';
import path from 'path';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function main(): Promise<void> {
  const outDir = path.resolve(__dirname, '..', '..', '..', 'reports', 'saas', 'phase1');
  await runAudit('02-user-identity', 'Audit B — User Identity', outDir, async (ctx) => {
    const m: AuditMetric[] = [];
    const f: AuditFinding[] = [];
    const c = ctx.client;
    if (!(await tableExists(c, 'users'))) {
      f.push({ severity: 'BLOCKER', rule: 'users.missing-table', message: 'Table `users` not found.' });
      return { metrics: m, findings: f };
    }

    const total = (await c.query<{ n: number }>(`SELECT count(*)::int n FROM users`)).rows[0].n;
    m.push({ key: 'users.total', value: total });

    const hasDeletedAt = await columnExists(c, 'users', 'deletedAt');
    if (hasDeletedAt) {
      const soft = (await c.query<{ n: number }>(
        `SELECT count(*)::int n FROM users WHERE "deletedAt" IS NOT NULL`,
      )).rows[0].n;
      m.push({ key: 'users.soft-deleted', value: soft });
    }

    // NULL/invalid emails
    const nullEmail = (await c.query<{ n: number }>(
      `SELECT count(*)::int n FROM users WHERE email IS NULL OR email = ''`,
    )).rows[0].n;
    m.push({ key: 'users.null-email', value: nullEmail });
    if (nullEmail > 0) {
      f.push({ severity: 'BLOCKER', rule: 'user.null-email', message: `${nullEmail} users have NULL or empty email.` });
    }
    const candidates = await c.query<{ id: string; email: string }>(
      `SELECT id, email FROM users WHERE email IS NOT NULL AND email <> '' LIMIT 5000`,
    );
    const invalid = candidates.rows.filter((r) => !EMAIL_RE.test(r.email));
    if (invalid.length) {
      f.push({
        severity: 'BLOCKER',
        rule: 'user.invalid-email',
        message: `${invalid.length} users with invalid email format.`,
        detail: invalid.slice(0, 10),
      });
    }

    // Duplicate emails (case-insensitive). Today the DB enforces UNIQUE so this should be 0.
    const dupes = await c.query<{ email: string; n: number; ids: string[] }>(
      `SELECT lower(email) AS email, count(*)::int n, array_agg(id::text) ids
         FROM users
        WHERE email IS NOT NULL AND email <> ''
        GROUP BY lower(email)
       HAVING count(*) > 1
        ORDER BY n DESC`,
    );
    m.push({ key: 'users.duplicate-emails', value: dupes.rowCount ?? 0 });
    if ((dupes.rowCount ?? 0) > 0) {
      f.push({
        severity: 'BLOCKER',
        rule: 'user.duplicate-email',
        message: `${dupes.rowCount} duplicate user emails (case-insensitive).`,
        detail: dupes.rows.slice(0, 10),
      });
    }

    // Users without agency
    const orphan = (await c.query<{ n: number }>(
      `SELECT count(*)::int n FROM users WHERE "agencyId" IS NULL`,
    )).rows[0].n;
    m.push({ key: 'users.no-agency', value: orphan });
    if (orphan > 0) {
      f.push({
        severity: 'BLOCKER',
        rule: 'user.no-agency',
        message: `${orphan} users have NULL agencyId. Each must be reconciled (delete, assign, or platform-admin).`,
      });
    }

    // System-agency users → platform admin candidates
    if (await columnExists(c, 'agencies', 'isSystem')) {
      const sys = await c.query<{ id: string; email: string }>(
        `SELECT u.id, u.email FROM users u
           JOIN agencies a ON a.id = u."agencyId"
          WHERE a."isSystem" = true
          ORDER BY u.email`,
      );
      m.push({ key: 'users.system-agency', value: sys.rowCount ?? 0 });
      if ((sys.rowCount ?? 0) > 0) {
        f.push({
          severity: 'INFO',
          rule: 'user.platform-admin-candidates',
          message: `${sys.rowCount} users belong to the system agency. They become PlatformAdmin rows.`,
          detail: sys.rows.slice(0, 50),
        });
      }
    }

    // Users that already exist in the new tenant_memberships table (idempotency check)
    if (await tableExists(c, 'tenant_memberships')) {
      const dup = (await c.query<{ n: number }>(
        `SELECT count(*)::int n FROM tenant_memberships`,
      )).rows[0].n;
      m.push({ key: 'tenant_memberships.preexisting', value: dup });
      if (dup > 0) {
        f.push({
          severity: 'INFO',
          rule: 'memberships.preexisting',
          message: `tenant_memberships already has ${dup} rows. Backfill must be idempotent.`,
        });
      }
    }

    // Inactive / suspended distribution
    const status = await c.query<{ status: string; n: number }>(
      `SELECT status, count(*)::int n FROM users GROUP BY status ORDER BY n DESC`,
    );
    m.push({ key: 'users.status-counts', value: JSON.stringify(status.rows) });

    return {
      metrics: m,
      findings: f,
      notes: [
        'Pre-flight contract: users.duplicate-email and users.null-email MUST be 0 before backfill.',
        'NULL agencyId users require manual disposition (assign, deactivate, or platform-admin).',
      ],
    };
  });
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(2); });
export {};
