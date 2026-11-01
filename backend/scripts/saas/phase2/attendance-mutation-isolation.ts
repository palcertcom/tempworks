/**
 * Phase 2.48 — Attendance mutation isolation harness.
 *
 *   1. pilot off: create/upsert behaviour remains legacy-compatible (no tenantId stamped).
 *   2. pilot active: tenant A creates upsert for tenant A employee; row tenantId = A.
 *   3. pilot active: tenant A cannot create/upsert for tenant B employee (NotFound).
 *   4. rejected tenant B create/upsert creates no row.
 *   5. tenant A update on tenant A attendance succeeds.
 *   6. tenant A update on tenant B attendance is rejected (NotFound).
 *   7. rejected tenant B update leaves row unchanged.
 *   8. tenant A delete on tenant A attendance succeeds (hard delete).
 *   9. tenant A delete on tenant B attendance is rejected (NotFound).
 *  10. rejected tenant B delete leaves row unchanged.
 *  11. bulkApply under tenant A affects only tenant A employees.
 *  12. bulkApply with tenant B employee id is rejected without mutation.
 *  13. NULL-tenant legacy attendance rows are not mutated in pilot mode.
 *  14. concurrent ALS frames for tenant A and tenant B mutation paths remain isolated.
 *  15. audit row for tenant A mutation carries tenantId=A when audit pilot enabled.
 *  16. audit row for rejected tenant B mutation is not emitted.
 *  17. exportExcel under tenant A excludes tenant B rows.
 *
 * Output: backend/reports/saas/phase2/attendance-mutation-isolation.{json,md}
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

async function applyFixture(url: string): Promise<void> {
  const sql = await fs.readFile(FIXTURE, 'utf8');
  const c = new Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
  await c.connect();
  try { await c.query(sql); } finally { await c.end(); }
}

function pgClient(url: string): Client {
  return new Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
}

const PILOT = { TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'attendance' };

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const env = classifyRuntimeEnv();
  if (!isStagingClassification(env.classification)) {
    console.error(`[attendance-mutation-isolation] refusing on classification=${env.classification}`);
    process.exit(3);
  }
  await applyFixture(url);

  const c = pgClient(url);
  await c.connect();
  const ts = await c.query<{ id: string }>(
    `SELECT t.id FROM tenants t WHERE EXISTS (SELECT 1 FROM employees e WHERE e."tenantId" = t.id::text) ORDER BY t.name`);
  const tA = ts.rows[0]?.id, tB = ts.rows[1]?.id;
  const ea = await c.query<{ id: string }>(`SELECT id FROM employees WHERE "tenantId" = $1 LIMIT 1`, [tA]);
  const eb = await c.query<{ id: string }>(`SELECT id FROM employees WHERE "tenantId" = $1 LIMIT 1`, [tB]);
  const empA = ea.rows[0]?.id, empB = eb.rows[0]?.id;
  const recB = await c.query<{ id: string; status: string }>(
    `SELECT id, status FROM attendance_records WHERE "tenantId" = $1 LIMIT 1`, [tB]);
  const recBId = recB.rows[0]?.id, recBStatus = recB.rows[0]?.status;
  // Discover the NULL-tenant legacy row
  const recNull = await c.query<{ id: string; status: string }>(
    `SELECT id, status FROM attendance_records WHERE "tenantId" IS NULL AND "employeeId" = $1 LIMIT 1`, [empA]);
  const recNullId = recNull.rows[0]?.id, recNullStatus = recNull.rows[0]?.status;
  await c.end();
  if (!tA || !tB || !empA || !empB || !recBId) {
    console.error('need 2 tenants + employees + recB'); process.exit(3);
  }

  const out: CaseResult[] = [];

  // 1 — pilot off, legacy upsert on a fresh date
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'false' }, async () => {
    const prisma = new PrismaService(); const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      const r: any = await svc.upsertRecord({ employeeId: empA, date: '2025-06-01', status: 'PRESENT', checkIn: '08:00', checkOut: '16:00' } as any, undefined);
      // Inspect row in DB to confirm legacy create did not stamp tenantId via pilot.
      const c2 = pgClient(url); await c2.connect();
      const row = await c2.query<{ tenantId: string | null }>(`SELECT "tenantId" FROM attendance_records WHERE id = $1`, [r.id]);
      await c2.end();
      out.push({ name: '1. pilot off legacy create succeeds (tenantId NULL)',
        ok: !!r.id && row.rows[0]?.tenantId === null,
        detail: `id=${r.id?.slice(0,8)} tenantId=${row.rows[0]?.tenantId}` });
    } finally { await prisma.$disconnect(); }
  });

  // 2 — pilot A: create stamps tenantId = A
  let pilotCreateAId: string | null = null;
  await withFlags(PILOT, async () => {
    const prisma = new PrismaService(); const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      const r: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        attach(tA, 'a');
        return svc.upsertRecord({ employeeId: empA, date: '2025-07-01', status: 'PRESENT', checkIn: '08:00', checkOut: '16:00' } as any, undefined);
      });
      pilotCreateAId = r.id;
      const c2 = pgClient(url); await c2.connect();
      const row = await c2.query<{ tenantId: string | null }>(`SELECT "tenantId" FROM attendance_records WHERE id = $1`, [r.id]);
      await c2.end();
      out.push({ name: '2. pilot A create stamps tenantId = A',
        ok: row.rows[0]?.tenantId === tA,
        detail: `tenantId=${row.rows[0]?.tenantId?.slice(0,8)}` });
    } finally { await prisma.$disconnect(); }
  });

  // 3 — pilot A cannot create for tenant B employee
  await withFlags(PILOT, async () => {
    const prisma = new PrismaService(); const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      let threw = false;
      try {
        await withRequestContext({ requestId: newRequestId() }, async () => {
          attach(tA, 'a');
          await svc.upsertRecord({ employeeId: empB, date: '2025-07-02', status: 'PRESENT' } as any, undefined);
        });
      } catch { threw = true; }
      out.push({ name: '3. pilot A create for tenant B employee raises NotFound', ok: threw, detail: threw ? 'NotFound' : 'UNEXPECTED' });
    } finally { await prisma.$disconnect(); }
  });

  // 4 — confirm no row created for the rejected attempt
  {
    const c2 = pgClient(url); await c2.connect();
    const r = await c2.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM attendance_records WHERE "employeeId" = $1 AND date = DATE '2025-07-02'`,
      [empB]);
    await c2.end();
    out.push({ name: '4. rejected create produces no row', ok: r.rows[0]?.count === '0', detail: `count=${r.rows[0]?.count}` });
  }

  // 5 — tenant A update on tenant A attendance succeeds (use the row we just created in case 2)
  await withFlags(PILOT, async () => {
    const prisma = new PrismaService(); const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      const r: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        attach(tA, 'a');
        return svc.updateRecord(pilotCreateAId!, { status: 'ABSENT' } as any, undefined);
      });
      out.push({ name: '5. tenant A update on tenant A row succeeds', ok: r.status === 'ABSENT', detail: `status=${r.status}` });
    } finally { await prisma.$disconnect(); }
  });

  // 6 — tenant A update on tenant B record id rejected
  await withFlags(PILOT, async () => {
    const prisma = new PrismaService(); const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      let threw = false;
      try {
        await withRequestContext({ requestId: newRequestId() }, async () => {
          attach(tA, 'a');
          await svc.updateRecord(recBId, { status: 'ABSENT' } as any, undefined);
        });
      } catch { threw = true; }
      out.push({ name: '6. tenant A update on tenant B row rejected', ok: threw, detail: threw ? 'NotFound' : 'UNEXPECTED' });
    } finally { await prisma.$disconnect(); }
  });

  // 7 — confirm tenant B row unchanged
  {
    const c2 = pgClient(url); await c2.connect();
    const r = await c2.query<{ status: string }>(`SELECT status FROM attendance_records WHERE id = $1`, [recBId]);
    await c2.end();
    out.push({ name: '7. tenant B row unchanged after rejected update', ok: r.rows[0]?.status === recBStatus, detail: `status=${r.rows[0]?.status}` });
  }

  // 8 — tenant A delete on tenant A row succeeds
  let pilotDeleteAId = '';
  await withFlags(PILOT, async () => {
    const prisma = new PrismaService(); const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      // Create a row to delete (different date)
      const r: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        attach(tA, 'a');
        return svc.upsertRecord({ employeeId: empA, date: '2025-07-15', status: 'PRESENT' } as any, undefined);
      });
      pilotDeleteAId = r.id;
      const dr: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        attach(tA, 'a');
        return svc.deleteRecord(pilotDeleteAId, undefined);
      });
      out.push({ name: '8. tenant A delete on tenant A row succeeds', ok: !!dr?.message, detail: dr?.message ?? 'no message' });
    } finally { await prisma.$disconnect(); }
  });

  // 9 — tenant A delete on tenant B row rejected
  await withFlags(PILOT, async () => {
    const prisma = new PrismaService(); const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      let threw = false;
      try {
        await withRequestContext({ requestId: newRequestId() }, async () => {
          attach(tA, 'a');
          await svc.deleteRecord(recBId, undefined);
        });
      } catch { threw = true; }
      out.push({ name: '9. tenant A delete on tenant B row rejected', ok: threw, detail: threw ? 'NotFound' : 'UNEXPECTED' });
    } finally { await prisma.$disconnect(); }
  });

  // 10 — confirm tenant B row unchanged after rejected delete
  {
    const c2 = pgClient(url); await c2.connect();
    const r = await c2.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM attendance_records WHERE id = $1`, [recBId]);
    await c2.end();
    out.push({ name: '10. tenant B row unchanged after rejected delete', ok: r.rows[0]?.count === '1', detail: `count=${r.rows[0]?.count}` });
  }

  // 11 — bulkApply under tenant A only affects tenant A employees
  await withFlags(PILOT, async () => {
    const prisma = new PrismaService(); const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      const r: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        attach(tA, 'a');
        return svc.bulkApply({ employeeId: empA, status: 'PRESENT', dates: ['2025-08-01', '2025-08-02'] } as any, undefined);
      });
      const c2 = pgClient(url); await c2.connect();
      const row = await c2.query<{ tenantId: string | null; count: string }>(
        `SELECT COUNT(*)::text AS count FROM attendance_records WHERE "employeeId" = $1 AND date IN (DATE '2025-08-01', DATE '2025-08-02') AND "tenantId" = $2`,
        [empA, tA]);
      await c2.end();
      out.push({ name: '11. bulkApply tenant A creates rows tagged tenant A',
        ok: r.summary?.created >= 0 && row.rows[0]?.count === '2',
        detail: `created=${r.summary?.created} tagged=${row.rows[0]?.count}` });
    } finally { await prisma.$disconnect(); }
  });

  // 12 — bulkApply tenant B employee id is rejected
  await withFlags(PILOT, async () => {
    const prisma = new PrismaService(); const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      let threw = false;
      try {
        await withRequestContext({ requestId: newRequestId() }, async () => {
          attach(tA, 'a');
          await svc.bulkApply({ employeeId: empB, status: 'PRESENT', dates: ['2025-08-15'] } as any, undefined);
        });
      } catch { threw = true; }
      const c2 = pgClient(url); await c2.connect();
      const row = await c2.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM attendance_records WHERE "employeeId" = $1 AND date = DATE '2025-08-15'`,
        [empB]);
      await c2.end();
      out.push({ name: '12. bulkApply tenant B emp rejected; no rows', ok: threw && row.rows[0]?.count === '0', detail: `threw=${threw} count=${row.rows[0]?.count}` });
    } finally { await prisma.$disconnect(); }
  });

  // 13 — NULL-tenant legacy attendance row not mutated under pilot mode
  await withFlags(PILOT, async () => {
    const prisma = new PrismaService(); const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      let threw = false;
      if (recNullId) {
        try {
          await withRequestContext({ requestId: newRequestId() }, async () => {
            attach(tA, 'a');
            await svc.updateRecord(recNullId, { status: 'ABSENT' } as any, undefined);
          });
        } catch { threw = true; }
      }
      const c2 = pgClient(url); await c2.connect();
      const r = await c2.query<{ status: string; tenantId: string | null }>(
        `SELECT status, "tenantId" FROM attendance_records WHERE id = $1`, [recNullId]);
      await c2.end();
      const unchanged = r.rows[0]?.status === recNullStatus && r.rows[0]?.tenantId === null;
      out.push({ name: '13. NULL-tenant legacy row not mutated under pilot', ok: threw && unchanged,
        detail: `threw=${threw} status=${r.rows[0]?.status} tenantId=${r.rows[0]?.tenantId}` });
    } finally { await prisma.$disconnect(); }
  });

  // 14 — concurrent ALS frames for tenant A and tenant B mutation paths remain isolated
  await withFlags(PILOT, async () => {
    const prisma = new PrismaService(); const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      const [a, b]: any[] = await Promise.all([
        withRequestContext({ requestId: newRequestId() }, async () => {
          attach(tA, 'a');
          return svc.upsertRecord({ employeeId: empA, date: '2025-09-01', status: 'PRESENT' } as any, undefined);
        }),
        withRequestContext({ requestId: newRequestId() }, async () => {
          attach(tB, 'b');
          return svc.upsertRecord({ employeeId: empB, date: '2025-09-01', status: 'PRESENT' } as any, undefined);
        }),
      ]);
      const c2 = pgClient(url); await c2.connect();
      const ra = await c2.query<{ tenantId: string | null }>(`SELECT "tenantId" FROM attendance_records WHERE id = $1`, [a.id]);
      const rb = await c2.query<{ tenantId: string | null }>(`SELECT "tenantId" FROM attendance_records WHERE id = $1`, [b.id]);
      await c2.end();
      out.push({ name: '14. concurrent ALS frames stamp correct tenantId',
        ok: ra.rows[0]?.tenantId === tA && rb.rows[0]?.tenantId === tB,
        detail: `A=${ra.rows[0]?.tenantId?.slice(0,8)} B=${rb.rows[0]?.tenantId?.slice(0,8)}` });
    } finally { await prisma.$disconnect(); }
  });

  // 15 — audit row for tenant A mutation carries tenantId=A when audit pilot ON
  await withFlags({ ...PILOT, TENANT_AUDIT_LOG_PILOT_ENABLED: 'true' }, async () => {
    const prisma = new PrismaService(); const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      const r: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        attach(tA, 'a');
        return svc.upsertRecord({ employeeId: empA, date: '2025-10-01', status: 'PRESENT' } as any, undefined);
      });
      const c2 = pgClient(url); await c2.connect();
      const row = await c2.query<{ tenantId: string | null }>(
        `SELECT "tenantId" FROM audit_logs WHERE entity = 'AttendanceRecord' AND "entityId" = $1 ORDER BY "createdAt" DESC LIMIT 1`,
        [r.id]);
      await c2.end();
      out.push({ name: '15. audit row tenant A mutation carries tenantId=A (audit pilot ON)',
        ok: row.rows[0]?.tenantId === tA,
        detail: `tenantId=${row.rows[0]?.tenantId?.slice(0,8)}` });
    } finally { await prisma.$disconnect(); }
  });

  // 16 — audit row for rejected tenant B mutation is NOT emitted
  await withFlags({ ...PILOT, TENANT_AUDIT_LOG_PILOT_ENABLED: 'true' }, async () => {
    const prisma = new PrismaService(); const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      const c2 = pgClient(url); await c2.connect();
      const before = await c2.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM audit_logs WHERE entity='AttendanceRecord' AND "entityId" = $1`, [recBId]);
      try {
        await withRequestContext({ requestId: newRequestId() }, async () => {
          attach(tA, 'a');
          await svc.updateRecord(recBId, { status: 'ABSENT' } as any, undefined);
        });
      } catch { /* expected */ }
      const after = await c2.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM audit_logs WHERE entity='AttendanceRecord' AND "entityId" = $1`, [recBId]);
      await c2.end();
      out.push({ name: '16. rejected tenant B mutation does not emit audit row',
        ok: before.rows[0]?.count === after.rows[0]?.count,
        detail: `before=${before.rows[0]?.count} after=${after.rows[0]?.count}` });
    } finally { await prisma.$disconnect(); }
  });

  // 17 — exportExcel under tenant A excludes tenant B rows
  await withFlags(PILOT, async () => {
    const prisma = new PrismaService(); const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      // Try export targeting tenant B's employee specifically — should fail with "no employees"
      let threw = false;
      try {
        await withRequestContext({ requestId: newRequestId() }, async () => {
          attach(tA, 'a');
          await svc.exportExcel({ month: 1, year: 2025, employeeId: empB } as any, 'en');
        });
      } catch { threw = true; }
      out.push({ name: '17. exportExcel under tenant A refuses tenant B employee', ok: threw, detail: threw ? 'BadRequest' : 'UNEXPECTED' });
    } finally { await prisma.$disconnect(); }
  });

  await fs.mkdir(OUT_DIR, { recursive: true });
  const passed = out.filter((c) => c.ok).length;
  const total = out.length;
  await fs.writeFile(path.join(OUT_DIR, 'attendance-mutation-isolation.json'),
    JSON.stringify({ passed, total, cases: out }, null, 2));
  const md = [
    `# Phase 2.48 — attendance mutation isolation`, ``,
    `**${passed}/${total} PASS**`, ``,
    ...out.map((c) => `- ${c.ok ? 'PASS' : 'FAIL'} — ${c.name} — ${c.detail}`), ``,
  ].join('\n');
  await fs.writeFile(path.join(OUT_DIR, 'attendance-mutation-isolation.md'), md);
  console.log(`[attendance-mutation-isolation] ${passed}/${total} PASS`);
  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(2); });
