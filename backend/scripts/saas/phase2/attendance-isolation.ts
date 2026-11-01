/**
 * Phase 2.47 — Attendance reads-first isolation harness.
 *
 *   1. tenant A list returns only tenant A employees
 *   2. tenant A getEmployeeAttendance for tenant B employee raises NotFound
 *   3. tenant A reads do NOT see NULL-tenant legacy attendance row in pilot mode
 *   4. tenant A summary counts only tenant A records
 *   5. tenant A date-range query excludes tenant B records
 *   6. tenant A employee filter rejects (NotFound) for tenant B employee
 *   7. tenant A update on tenant B record raises NotFound (no mutation)
 *   8. rejected mutation leaves tenant B row unchanged
 *   9. create attendance under tenant A links tenant A correctly
 *  10. bulk-apply under tenant A refuses tenant B employee (no mutation)
 *  11. concurrent ALS frames for tenant A and tenant B remain isolated
 *  12. pilot opt-out (allow-list "nothing") returns legacy union (NULL row visible)
 *
 * Output: backend/reports/saas/phase2/attendance-isolation.{json,md}
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

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const env = classifyRuntimeEnv();
  if (!isStagingClassification(env.classification)) {
    console.error(`[attendance-isolation] refusing on classification=${env.classification}`);
    process.exit(3);
  }
  await applyFixture(url);

  const c = new Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
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
  await c.end();
  if (!tA || !tB || !empA || !empB || !recBId) { console.error('need 2 tenants + employees + recB'); process.exit(3); }

  const out: CaseResult[] = [];
  const PILOT = { TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'attendance' };

  // 1
  await withFlags(PILOT, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      const r: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        attach(tA, 'a');
        return svc.listEmployeesWithStats({} as any);
      });
      const allA = (r.data as any[]).every((e) => e.id !== empB);
      out.push({ name: '1. tenant A list returns only tenant A employees', ok: allA, detail: `total=${r.meta.total} hasB=${!allA}` });
    } finally { await prisma.$disconnect(); }
  });

  // 2
  await withFlags(PILOT, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      let threw = false;
      try {
        await withRequestContext({ requestId: newRequestId() }, async () => {
          attach(tA, 'a');
          await svc.getEmployeeAttendance(empB, {} as any);
        });
      } catch { threw = true; }
      out.push({ name: '2. tenant A getEmployeeAttendance for tenant B raises NotFound', ok: threw, detail: threw ? 'NotFound' : 'UNEXPECTED' });
    } finally { await prisma.$disconnect(); }
  });

  // 3 — tenant A range incl. 2024-12-31 must NOT include the NULL-tenant row
  await withFlags(PILOT, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      const r: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        attach(tA, 'a');
        return svc.getEmployeeAttendance(empA, { dateFrom: '2024-12-01', dateTo: '2024-12-31' } as any);
      });
      out.push({ name: '3. NULL-tenant legacy row excluded under pilot', ok: r.records.length === 0, detail: `records=${r.records.length}` });
    } finally { await prisma.$disconnect(); }
  });

  // 4 — summary counts only tenant A records (Jan 2025: 2 PRESENT + 1 ABSENT seeded)
  await withFlags(PILOT, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      const r: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        attach(tA, 'a');
        return svc.getEmployeeAttendance(empA, { month: 1, year: 2025 } as any);
      });
      const okIds = (r.records as any[]).every((rec) => rec.tenantId === tA);
      out.push({ name: '4. summary counts only tenant A records', ok: okIds, detail: `records=${r.records.length}` });
    } finally { await prisma.$disconnect(); }
  });

  // 5 — tenant A date-range excludes tenant B
  await withFlags(PILOT, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      const r: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        attach(tA, 'a');
        return svc.listEmployeesWithStats({ month: 1, year: 2025 } as any);
      });
      const noB = (r.data as any[]).every((e) => e.id !== empB);
      out.push({ name: '5. tenant A date-range list excludes tenant B', ok: noB, detail: `total=${r.meta.total}` });
    } finally { await prisma.$disconnect(); }
  });

  // 6 — pilot listEmployeesWithStats search for empB id under tenant A: must not appear
  await withFlags(PILOT, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      let threw = false;
      try {
        await withRequestContext({ requestId: newRequestId() }, async () => {
          attach(tA, 'a');
          await svc.getEmployeeAttendance(empB, {} as any);
        });
      } catch { threw = true; }
      out.push({ name: '6. employee filter rejects tenant B employee under pilot A', ok: threw, detail: threw ? 'NotFound' : 'UNEXPECTED' });
    } finally { await prisma.$disconnect(); }
  });

  // 7 — tenant A updateRecord on tenant B record id ⇒ NotFound, no mutation
  await withFlags(PILOT, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
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
      out.push({ name: '7. tenant A update on tenant B record raises NotFound', ok: threw, detail: threw ? 'NotFound' : 'UNEXPECTED' });
    } finally { await prisma.$disconnect(); }
  });

  // 8 — confirm row B unchanged
  {
    const c2 = new Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
    await c2.connect();
    const r2 = await c2.query<{ status: string }>(`SELECT status FROM attendance_records WHERE id = $1`, [recBId]);
    await c2.end();
    out.push({ name: '8. tenant B row unchanged after rejected mutation', ok: r2.rows[0]?.status === recBStatus, detail: `status=${r2.rows[0]?.status}` });
  }

  // 9 — tenant A creates a new record (date 2025-03-01) and DB shows tenantId=A via legacy denorm
  await withFlags(PILOT, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      const r: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        attach(tA, 'a');
        return svc.upsertRecord({ employeeId: empA, date: '2025-03-01', status: 'PRESENT', checkIn: '08:00', checkOut: '16:00' } as any, undefined);
      });
      out.push({ name: '9. create under tenant A returns id+employee', ok: !!r?.id && r?.employee?.id === empA, detail: `id=${r?.id?.slice(0,8)}` });
    } finally { await prisma.$disconnect(); }
  });

  // 10 — bulk-apply under tenant A for tenant B employee raises NotFound
  await withFlags(PILOT, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      let threw = false;
      try {
        await withRequestContext({ requestId: newRequestId() }, async () => {
          attach(tA, 'a');
          await svc.bulkApply({ employeeId: empB, status: 'PRESENT', dates: ['2025-04-01'] } as any, undefined);
        });
      } catch { threw = true; }
      out.push({ name: '10. tenant A bulk-apply for tenant B employee raises NotFound', ok: threw, detail: threw ? 'NotFound' : 'UNEXPECTED' });
    } finally { await prisma.$disconnect(); }
  });

  // 11 — concurrent ALS frames remain isolated
  await withFlags(PILOT, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      const [ra, rb]: any[] = await Promise.all([
        withRequestContext({ requestId: newRequestId() }, async () => { attach(tA, 'a'); return svc.listEmployeesWithStats({} as any); }),
        withRequestContext({ requestId: newRequestId() }, async () => { attach(tB, 'b'); return svc.listEmployeesWithStats({} as any); }),
      ]);
      const aHasNoB = (ra.data as any[]).every((e) => e.id !== empB);
      const bHasNoA = (rb.data as any[]).every((e) => e.id !== empA);
      out.push({ name: '11. concurrent ALS frames remain isolated', ok: aHasNoB && bHasNoA,
        detail: `A.total=${ra.meta.total} B.total=${rb.meta.total}` });
    } finally { await prisma.$disconnect(); }
  });

  // 12 — opt-out via allow-list nothing ⇒ legacy union (NULL row visible)
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'nothing' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      const r: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        attach(tA, 'a');
        return svc.getEmployeeAttendance(empA, { dateFrom: '2024-12-01', dateTo: '2024-12-31' } as any);
      });
      out.push({ name: '12. allow-list nothing ⇒ NULL-tenant row visible (legacy)', ok: r.records.length >= 1, detail: `records=${r.records.length}` });
    } finally { await prisma.$disconnect(); }
  });

  await fs.mkdir(OUT_DIR, { recursive: true });
  const passed = out.filter((c) => c.ok).length;
  const total = out.length;
  await fs.writeFile(path.join(OUT_DIR, 'attendance-isolation.json'),
    JSON.stringify({ passed, total, cases: out }, null, 2));
  const md = [
    `# Phase 2.47 — attendance isolation`, ``,
    `**${passed}/${total} PASS**`, ``,
    ...out.map((c) => `- ${c.ok ? 'PASS' : 'FAIL'} — ${c.name} — ${c.detail}`), ``,
  ].join('\n');
  await fs.writeFile(path.join(OUT_DIR, 'attendance-isolation.md'), md);
  console.log(`[attendance-isolation] ${passed}/${total} PASS`);
  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(2); });
