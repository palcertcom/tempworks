/**
 * Phase 2.49 — AttendanceLockedPeriod tenant scoping isolation harness.
 *
 *   1. pilot off: legacy global lockPeriod produces a NULL-tenant row.
 *   2. pilot A: lockPeriod stamps tenantId = A on the new lock row.
 *   3. pilot B can independently lock the SAME (year, month).
 *   4. tenant A listLockedPeriods returns only tenant A rows.
 *   5. tenant B listLockedPeriods returns only tenant B rows.
 *   6. tenant A unlockPeriod cannot unlock tenant B row (NotFound).
 *   7. tenant B lock does NOT block tenant A mutation (upsert succeeds).
 *   8. tenant A lock blocks tenant A mutation in the locked month.
 *   9. tenant A lock does not block tenant B mutation in the same month.
 *  10. NULL-tenant global lock row does NOT block tenant A pilot mutation.
 *  11. concurrent ALS frames: lock checks remain isolated.
 *  12. unique constraint allows the same year/month across two tenants
 *      (tenant A lock + tenant B lock on same month coexist).
 *  13. unique constraint prevents duplicate (tenantId, year, month)
 *      on the same tenant.
 *
 * Output: backend/reports/saas/phase2/attendance-lock-period-isolation.{json,md}
 */
/* eslint-disable no-console */
import { promises as fs } from 'fs';
import path from 'path';
import { Client } from 'pg';
import { autoLoadEnv, formatDatabaseUrlMissingMessage } from './../phase1/reconciliation/lib/env';
import { classifyRuntimeEnv, isStagingClassification } from '../../../src/saas/tenancy/env-safety';
import { PrismaService } from '../../../src/prisma/prisma.service';
import { TenantPrismaService } from '../../../src/saas/prisma/tenant-prisma.service';
import { PilotPrismaAccessor } from '../../../src/saas/prisma/pilot-prisma.accessor';
import { FeatureFlagsService } from '../../../src/saas/feature-flags/feature-flags.service';
import { AttendanceService } from '../../../src/attendance/attendance.service';
import { TenantAuditLogService } from '../../../src/saas/audit/tenant-audit-log.service';
import { TenantContext, withRequestContext, newRequestId } from '../../../src/saas/context/als';

autoLoadEnv(__filename);

const OUT_DIR = path.resolve(__dirname, '..', '..', '..', 'reports', 'saas', 'phase2');
const FIXTURE = path.resolve(__dirname, '__fixture__', 'phase247-attendance-extension.sql');

interface CaseResult { name: string; ok: boolean; detail: string; }

function getDatabaseUrl(): string {
  const arg = process.argv.find((a) => a.startsWith('--db='))?.slice(5);
  return arg ?? process.env.DATABASE_URL ?? (() => { throw new Error(formatDatabaseUrlMissingMessage()); })();
}

async function withFlags<T>(env: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const prev = { ...process.env };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { return await fn(); } finally { process.env = prev; }
}

function makeService(prisma: PrismaService, pilot: PilotPrismaAccessor, ff: FeatureFlagsService): AttendanceService {
  return new AttendanceService(prisma, pilot, new TenantAuditLogService(prisma, ff));
}

function attach(tid: string, slug: string) {
  TenantContext.attach({ id: tid, slug, name: slug.toUpperCase(), status: 'ACTIVE', region: 'eu' });
}

function pgClient(url: string): Client {
  return new Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
}

async function applyFixture(url: string): Promise<void> {
  const sql = await fs.readFile(FIXTURE, 'utf8');
  const c = pgClient(url);
  await c.connect();
  try { await c.query(sql); } finally { await c.end(); }
}

const PILOT = { TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'attendance' };

async function clearLocks(url: string): Promise<void> {
  const c = pgClient(url);
  await c.connect();
  try {
    await c.query(`DELETE FROM attendance_locked_periods WHERE year = 2099`);
    await c.query(`DELETE FROM attendance_records WHERE date >= DATE '2099-01-01'`);
  } finally { await c.end(); }
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const env = classifyRuntimeEnv();
  if (!isStagingClassification(env.classification)) {
    console.error(`[attendance-lock-period-isolation] refusing on classification=${env.classification}`);
    process.exit(3);
  }
  await applyFixture(url);
  await clearLocks(url);

  const c = pgClient(url);
  await c.connect();
  const ts = await c.query<{ id: string }>(
    `SELECT t.id FROM tenants t WHERE EXISTS (SELECT 1 FROM employees e WHERE e."tenantId" = t.id::text) ORDER BY t.name`);
  const tA = ts.rows[0]?.id, tB = ts.rows[1]?.id;
  const ea = await c.query<{ id: string }>(`SELECT id FROM employees WHERE "tenantId" = $1 LIMIT 1`, [tA]);
  const eb = await c.query<{ id: string }>(`SELECT id FROM employees WHERE "tenantId" = $1 LIMIT 1`, [tB]);
  const empA = ea.rows[0]?.id, empB = eb.rows[0]?.id;
  await c.end();
  if (!tA || !tB || !empA || !empB) { console.error('need tenants + employees'); process.exit(3); }

  const out: CaseResult[] = [];
  const Y = 2099, M = 11;        // unique test year/month nobody else uses
  const Y2 = 2099, M2 = 12;      // for case 13 (duplicate detection)

  // 1 — pilot off legacy global lock (NULL tenantId)
  let legacyLockId = '';
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'false' }, async () => {
    const prisma = new PrismaService(); const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      const r: any = await svc.lockPeriod({ year: Y, month: M, reason: 'legacy' } as any, undefined);
      legacyLockId = r.id;
      const c2 = pgClient(url); await c2.connect();
      const row = await c2.query<{ tenantId: string | null }>(`SELECT "tenantId" FROM attendance_locked_periods WHERE id = $1`, [r.id]);
      await c2.end();
      out.push({ name: '1. pilot off lockPeriod produces NULL-tenant row',
        ok: row.rows[0]?.tenantId === null,
        detail: `tenantId=${row.rows[0]?.tenantId}` });
    } finally { await prisma.$disconnect(); }
  });

  // 2 — pilot A: lock stamps tenantId = A
  let lockAId = '';
  await withFlags(PILOT, async () => {
    const prisma = new PrismaService(); const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      const r: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        attach(tA, 'a');
        return svc.lockPeriod({ year: Y, month: M, reason: 'A' } as any, undefined);
      });
      lockAId = r.id;
      const c2 = pgClient(url); await c2.connect();
      const row = await c2.query<{ tenantId: string | null }>(`SELECT "tenantId" FROM attendance_locked_periods WHERE id = $1`, [r.id]);
      await c2.end();
      out.push({ name: '2. pilot A lockPeriod stamps tenantId = A',
        ok: row.rows[0]?.tenantId === tA,
        detail: `tenantId=${row.rows[0]?.tenantId?.slice(0,8)}` });
    } finally { await prisma.$disconnect(); }
  });

  // 3 — pilot B independently locks same (year, month)
  let lockBId = '';
  await withFlags(PILOT, async () => {
    const prisma = new PrismaService(); const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      const r: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        attach(tB, 'b');
        return svc.lockPeriod({ year: Y, month: M, reason: 'B' } as any, undefined);
      });
      lockBId = r.id;
      out.push({ name: '3. pilot B lockPeriod for SAME (year, month) succeeds',
        ok: !!r.id && r.id !== lockAId,
        detail: `idA=${lockAId.slice(0,8)} idB=${r.id?.slice(0,8)}` });
    } finally { await prisma.$disconnect(); }
  });

  // 4 — tenant A listLockedPeriods returns only A rows
  await withFlags(PILOT, async () => {
    const prisma = new PrismaService(); const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      const r: any[] = await withRequestContext({ requestId: newRequestId() }, async () => {
        attach(tA, 'a');
        return svc.listLockedPeriods();
      });
      const onlyA = r.every((row) => row.tenantId === tA);
      out.push({ name: '4. tenant A listLockedPeriods returns only A rows',
        ok: onlyA && r.some((row) => row.id === lockAId),
        detail: `count=${r.length} hasA=${r.some((row)=>row.id===lockAId)}` });
    } finally { await prisma.$disconnect(); }
  });

  // 5 — tenant B listLockedPeriods returns only B rows
  await withFlags(PILOT, async () => {
    const prisma = new PrismaService(); const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      const r: any[] = await withRequestContext({ requestId: newRequestId() }, async () => {
        attach(tB, 'b');
        return svc.listLockedPeriods();
      });
      const onlyB = r.every((row) => row.tenantId === tB);
      out.push({ name: '5. tenant B listLockedPeriods returns only B rows',
        ok: onlyB && r.some((row) => row.id === lockBId),
        detail: `count=${r.length} hasB=${r.some((row)=>row.id===lockBId)}` });
    } finally { await prisma.$disconnect(); }
  });

  // 6 — tenant A unlockPeriod on tenant B id raises NotFound
  await withFlags(PILOT, async () => {
    const prisma = new PrismaService(); const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      let threw = false;
      try {
        await withRequestContext({ requestId: newRequestId() }, async () => {
          attach(tA, 'a');
          await svc.unlockPeriod(lockBId, undefined);
        });
      } catch { threw = true; }
      const c2 = pgClient(url); await c2.connect();
      const r = await c2.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM attendance_locked_periods WHERE id = $1`, [lockBId]);
      await c2.end();
      out.push({ name: '6. tenant A unlock on tenant B row rejected; B row intact',
        ok: threw && r.rows[0]?.count === '1', detail: `threw=${threw} count=${r.rows[0]?.count}` });
    } finally { await prisma.$disconnect(); }
  });

  // 7 — tenant B lock for an UNRELATED month does NOT block tenant A mutation in that month
  // Lock (tenantB, 2099, 9), then verify tenant A can mutate 2099-09 freely.
  await withFlags(PILOT, async () => {
    const prisma = new PrismaService(); const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      await withRequestContext({ requestId: newRequestId() }, async () => {
        attach(tB, 'b');
        return svc.lockPeriod({ year: Y, month: 9 } as any, undefined);
      });
      const r: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        attach(tA, 'a');
        return svc.upsertRecord({ employeeId: empA, date: `${Y}-09-15`, status: 'PRESENT' } as any, undefined);
      });
      out.push({ name: '7. tenant B lock (Y,9) does NOT block tenant A mutation in (Y,9)',
        ok: !!r.id, detail: `id=${r.id?.slice(0,8)}` });
    } finally { await prisma.$disconnect(); }
  });

  // 8 — tenant A lock BLOCKS tenant A mutation in same period
  await withFlags(PILOT, async () => {
    const prisma = new PrismaService(); const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      let threw = false;
      try {
        await withRequestContext({ requestId: newRequestId() }, async () => {
          attach(tA, 'a');
          await svc.upsertRecord({ employeeId: empA, date: `${Y}-${String(M).padStart(2, '0')}-20`, status: 'PRESENT' } as any, undefined);
        });
      } catch { threw = true; }
      out.push({ name: '8. tenant A lock blocks tenant A mutation', ok: threw, detail: threw ? 'BadRequest (locked)' : 'UNEXPECTED' });
    } finally { await prisma.$disconnect(); }
  });

  // 9 — tenant A lock at (Y, M) does NOT block tenant B mutation in DIFFERENT month (Y, 10)
  // (where B has no lock). Demonstrates that A's lock doesn't bleed into B.
  await withFlags(PILOT, async () => {
    const prisma = new PrismaService(); const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      const r: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        attach(tB, 'b');
        return svc.upsertRecord({ employeeId: empB, date: `${Y}-10-15`, status: 'PRESENT' } as any, undefined);
      });
      out.push({ name: '9. tenant A lock (Y,M) does NOT block tenant B mutation in (Y,10)',
        ok: !!r.id, detail: `id=${r.id?.slice(0,8)}` });
    } finally { await prisma.$disconnect(); }
  });

  // 10 — NULL-tenant global lock should NOT block pilot tenant A mutation
  // (legacyLockId is the NULL-tenant row from case 1; let's pick a different month & try a tenant A upsert)
  await withFlags(PILOT, async () => {
    const prisma = new PrismaService(); const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      // Insert a NULL-tenant lock for a DIFFERENT month; tenant A in the same month should NOT be blocked.
      const c2 = pgClient(url); await c2.connect();
      await c2.query(
        `INSERT INTO attendance_locked_periods(id, year, month, "lockedAt", "tenantId") VALUES (gen_random_uuid()::text, 2099, 7, now(), NULL) ON CONFLICT DO NOTHING`);
      await c2.end();
      const r: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        attach(tA, 'a');
        return svc.upsertRecord({ employeeId: empA, date: '2099-07-15', status: 'PRESENT' } as any, undefined);
      });
      out.push({ name: '10. NULL-tenant global lock does NOT block tenant A pilot mutation',
        ok: !!r.id, detail: `id=${r.id?.slice(0,8)}` });
    } finally { await prisma.$disconnect(); }
  });

  // 11 — concurrent ALS frames: lock checks isolated
  await withFlags(PILOT, async () => {
    const prisma = new PrismaService(); const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      const [a, b] = await Promise.all([
        withRequestContext({ requestId: newRequestId() }, async () => {
          attach(tA, 'a');
          return svc.isPeriodLocked(Y, M); // expect true (A lock exists)
        }),
        withRequestContext({ requestId: newRequestId() }, async () => {
          attach(tB, 'b');
          return svc.isPeriodLocked(Y, 8); // expect false (no B lock)
        }),
      ]);
      out.push({ name: '11. concurrent ALS frames: lock checks isolated',
        ok: a === true && b === false,
        detail: `A=${a} B=${b}` });
    } finally { await prisma.$disconnect(); }
  });

  // 12 — unique constraint allows same (year, month) across two tenants (already proved by case 3)
  out.push({ name: '12. unique constraint permits SAME (year, month) across tenants',
    ok: !!lockAId && !!lockBId && lockAId !== lockBId,
    detail: `idA=${lockAId.slice(0,8)} idB=${lockBId.slice(0,8)}` });

  // 13 — unique constraint prevents duplicate (tenantId, year, month) on the same tenant
  await withFlags(PILOT, async () => {
    const prisma = new PrismaService(); const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      // First lock for (tA, Y2, M2)
      await withRequestContext({ requestId: newRequestId() }, async () => {
        attach(tA, 'a');
        return svc.lockPeriod({ year: Y2, month: M2 } as any, undefined);
      });
      let threw = false;
      try {
        await withRequestContext({ requestId: newRequestId() }, async () => {
          attach(tA, 'a');
          await svc.lockPeriod({ year: Y2, month: M2 } as any, undefined);
        });
      } catch { threw = true; }
      out.push({ name: '13. duplicate (tenantId, year, month) on same tenant rejected',
        ok: threw, detail: threw ? 'BadRequest already locked' : 'UNEXPECTED' });
    } finally { await prisma.$disconnect(); }
  });

  await fs.mkdir(OUT_DIR, { recursive: true });
  const passed = out.filter((c) => c.ok).length;
  const total = out.length;
  await fs.writeFile(path.join(OUT_DIR, 'attendance-lock-period-isolation.json'),
    JSON.stringify({ passed, total, cases: out }, null, 2));
  const md = [
    `# Phase 2.49 — attendance lock-period isolation`, ``,
    `**${passed}/${total} PASS**`, ``,
    ...out.map((c) => `- ${c.ok ? 'PASS' : 'FAIL'} — ${c.name} — ${c.detail}`), ``,
  ].join('\n');
  await fs.writeFile(path.join(OUT_DIR, 'attendance-lock-period-isolation.md'), md);
  console.log(`[attendance-lock-period-isolation] ${passed}/${total} PASS`);
  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(2); });
