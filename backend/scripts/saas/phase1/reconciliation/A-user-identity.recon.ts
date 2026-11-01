/**
 * Recon A — User Identity.
 *
 * Inspects users for issues that block backfill, proposes per-row decisions,
 * and (in --apply mode) inserts those proposals into `saas_reconciliation_queue`
 * with `decision = 'pending'` so ops can rubber-stamp / override.
 *
 * Never deletes, never modifies user rows. Mutations are confined to the
 * reconciliation queue table.
 */
import { runRecon, tableExists, columnExists, ReconAction, UUID_RE } from './lib/recon';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function main(): Promise<void> {
  await runRecon('A-user-identity', 'Recon A — User Identity', async ({ c, mode }) => {
    const metrics: { key: string; value: any; note?: string }[] = [];
    const actions: ReconAction[] = [];
    const notes: string[] = [];
    let status: 'OK' | 'WARN' | 'BLOCKER' = 'OK';

    if (!(await tableExists(c, 'users'))) {
      return { metrics, actions, status: 'BLOCKER', notes: ['users table not found'] };
    }
    const queueAvail = await tableExists(c, 'saas_reconciliation_queue');
    if (!queueAvail && mode === 'apply') {
      throw new Error('saas_reconciliation_queue missing — run Phase 1 prep migration first');
    }

    // ---- 1. Duplicate emails (case-insensitive)
    const dupes = await c.query<{ email: string; ids: string[] }>(
      `SELECT lower(email) AS email, array_agg(id::text) ids
         FROM users WHERE email IS NOT NULL AND email <> ''
        GROUP BY lower(email) HAVING count(*) > 1`,
    );
    metrics.push({ key: 'users.duplicate-emails', value: dupes.rowCount ?? 0 });
    for (const r of dupes.rows) {
      status = 'BLOCKER';
      actions.push({
        kind: 'user.duplicate-email',
        subject: { email: r.email, ids: r.ids },
        proposedDecision: 'manual-merge-or-rename',
        applied: false,
      });
    }

    // ---- 2. NULL or invalid emails
    const nullEmail = await c.query<{ id: string }>(
      `SELECT id::text FROM users WHERE email IS NULL OR email = ''`,
    );
    metrics.push({ key: 'users.null-email', value: nullEmail.rowCount ?? 0 });
    for (const r of nullEmail.rows) {
      status = 'BLOCKER';
      actions.push({
        kind: 'user.null-email',
        subject: { id: r.id },
        proposedDecision: 'assign-or-deactivate',
        applied: false,
      });
    }
    const invalid = await c.query<{ id: string; email: string }>(
      `SELECT id::text, email FROM users WHERE email IS NOT NULL AND email <> '' LIMIT 20000`,
    );
    let invalidCount = 0;
    for (const r of invalid.rows) {
      if (EMAIL_RE.test(r.email)) continue;
      invalidCount++;
      status = 'BLOCKER';
      actions.push({
        kind: 'user.invalid-email',
        subject: { id: r.id, email: r.email },
        proposedDecision: 'fix-or-deactivate',
        applied: false,
      });
    }
    metrics.push({ key: 'users.invalid-email', value: invalidCount });

    // ---- 3. Users without agency
    const noAgency = await c.query<{ id: string; email: string; status: string }>(
      `SELECT id::text, email, status FROM users WHERE "agencyId" IS NULL`,
    );
    metrics.push({ key: 'users.no-agency', value: noAgency.rowCount ?? 0 });
    for (const r of noAgency.rows) {
      if (status !== 'BLOCKER') status = 'BLOCKER';
      actions.push({
        kind: 'user.no-agency',
        subject: { id: r.id, email: r.email, status: r.status },
        proposedDecision: 'assign-tenant | platform-admin | deactivate',
        applied: false,
      });
    }

    // ---- 4. System-agency users → PlatformAdmin candidates
    if (await columnExists(c, 'agencies', 'isSystem')) {
      const sysUsers = await c.query<{ id: string; email: string }>(
        `SELECT u.id::text, u.email
           FROM users u JOIN agencies a ON a.id = u."agencyId"
          WHERE a."isSystem" = true`,
      );
      metrics.push({ key: 'users.system-agency', value: sysUsers.rowCount ?? 0 });
      for (const r of sysUsers.rows) {
        if (status === 'OK') status = 'WARN';
        actions.push({
          kind: 'user.platform-admin-candidate',
          subject: { id: r.id, email: r.email },
          proposedDecision: 'platform-admin:SUPER (downgrade post-cutover)',
          applied: false,
        });
      }
    }

    // ---- 5. Soft-deleted users — info only
    if (await columnExists(c, 'users', 'deletedAt')) {
      const soft = (await c.query<{ n: number }>(
        `SELECT count(*)::int n FROM users WHERE "deletedAt" IS NOT NULL`,
      )).rows[0].n;
      metrics.push({ key: 'users.soft-deleted', value: soft });
      if (soft > 0) {
        actions.push({
          kind: 'user.soft-deleted-skipped',
          subject: { count: soft },
          proposedDecision: 'skip-from-membership-backfill',
          applied: false,
        });
      }
    }

    // ---- 6. (apply mode) write proposals into the reconciliation queue
    if (mode === 'apply' && queueAvail) {
      for (const a of actions) {
        // Skip purely informational kinds.
        if (a.kind === 'user.soft-deleted-skipped') continue;
        const r = await c.query<{ id: string }>(
          `INSERT INTO saas_reconciliation_queue (kind, subject, decision)
                VALUES ($1, $2::jsonb, 'pending')
            ON CONFLICT DO NOTHING
            RETURNING id::text`,
          [a.kind, JSON.stringify(a.subject)],
        );
        a.applied = (r.rowCount ?? 0) > 0;
      }
    }

    notes.push(
      'No user rows are modified by this script. Apply mode only inserts proposals into saas_reconciliation_queue.',
      'Ops drains the queue with the queue-cli (TKT-P1-07) before backfill runs.',
    );
    return { metrics, actions, notes, status };
  });
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(2); });
export {};
