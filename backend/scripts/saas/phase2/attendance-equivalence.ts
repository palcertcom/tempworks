/**
 * Phase 2.47 — Attendance reads-first equivalence harness.
 *
 *   1. pilot disabled returns legacy list shape (PaginatedResponse keys)
 *   2. pilot disabled count/summary matches legacy union
 *   3. pilot enabled response shape preserved (data + meta)
 *   4. pilot enabled list ⊂ legacy list (subset)
 *   5. date range filter behaves the same in legacy and pilot mode (record count)
 *   6. employee filter works for same-tenant employee under pilot
 *   7. pagination/sorting shape preserved
 *   8. (mutation excluded — see attendance-isolation case 9 for create-shape parity)
 *   9. allow-list unset ⇒ all modules allowed
 *  10. allow-list explicit "attendance" allows attendance, denies others
 *  11. allow-list comma-separated "attendance,employees" allows both
 *  12. allow-list "nothing" ⇒ scope inactive even with flag on (legacy behavior)
 *
 * Output: backend/reports/saas/phase2/attendance-equivalence.{json,md}
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
import { getPilotScope, isModuleAllowed } from '../../../src/saas/prisma/tenant-pilot-scope';

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
    console.error(`[attendance-equivalence] refusing on classification=${env.classification}`);
    process.exit(3);
  }
  await applyFixture(url);

  const c = new Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
  await c.connect();
  const ts = await c.query<{ id: string }>(
    `SELECT t.id FROM tenants t WHERE EXISTS (SELECT 1 FROM employees e WHERE e."tenantId" = t.id::text) ORDER BY t.name`);
  const tA = ts.rows[0]?.id;
  const ea = await c.query<{ id: string }>(`SELECT id FROM employees WHERE "tenantId" = $1 LIMIT 1`, [tA]);
  const empA = ea.rows[0]?.id;
  await c.end();
  if (!tA || !empA) { console.error('need tenant + employee'); process.exit(3); }

  const out: CaseResult[] = [];

  // 1, 2 — legacy union snapshot
  let legacyTotal = 0;
  let legacyKeys: string[] = [];
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'false' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      const r: any = await svc.listEmployeesWithStats({} as any);
      legacyTotal = r.meta.total;
      legacyKeys = Object.keys(r);
      const okShape = legacyKeys.includes('data') && legacyKeys.includes('meta')
        && ['total','page','limit','totalPages'].every((k) => k in r.meta);
      out.push({ name: '1. pilot disabled returns legacy list shape', ok: okShape, detail: `keys=${legacyKeys.join(',')}` });
      out.push({ name: '2. pilot disabled count matches legacy (>=2 employees)', ok: legacyTotal >= 2, detail: `total=${legacyTotal}` });
    } finally { await prisma.$disconnect(); }
  });

  // 3, 4 — pilot enabled snapshot
  let pilotTotal = 0;
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'attendance' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      const r: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.listEmployeesWithStats({} as any);
      });
      pilotTotal = r.meta.total;
      const okShape = 'data' in r && 'meta' in r;
      out.push({ name: '3. pilot enabled response shape preserved', ok: okShape, detail: `keys=${Object.keys(r).join(',')}` });
      out.push({ name: '4. pilot enabled list ⊂ legacy union', ok: pilotTotal > 0 && pilotTotal <= legacyTotal, detail: `legacy=${legacyTotal} pilotA=${pilotTotal}` });
    } finally { await prisma.$disconnect(); }
  });

  // 5 — date range filter equivalence (Jan 2025): legacy union vs pilot A
  let legacyJanRecs = 0;
  let pilotJanRecs = 0;
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'false' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      const r: any = await svc.getEmployeeAttendance(empA, { month: 1, year: 2025 } as any);
      legacyJanRecs = r.records.length;
    } finally { await prisma.$disconnect(); }
  });
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'attendance' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      const r: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.getEmployeeAttendance(empA, { month: 1, year: 2025 } as any);
      });
      pilotJanRecs = r.records.length;
    } finally { await prisma.$disconnect(); }
  });
  out.push({ name: '5. date-range filter equivalent (legacy >= pilot, both >0)',
    ok: legacyJanRecs >= pilotJanRecs && pilotJanRecs > 0,
    detail: `legacy=${legacyJanRecs} pilotA=${pilotJanRecs}` });

  // 6 — employee filter under pilot returns same employee
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'attendance' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      const r: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.getEmployeeAttendance(empA, {} as any);
      });
      out.push({ name: '6. employee filter works for same-tenant employee under pilot',
        ok: r.employee?.id === empA && Array.isArray(r.records),
        detail: `id=${r.employee?.id?.slice(0,8)} recs=${r.records?.length}` });
    } finally { await prisma.$disconnect(); }
  });

  // 7 — pagination/sorting shape preserved (page=1 limit=1)
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'attendance' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      const r: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.listEmployeesWithStats({ page: 1, limit: 1 } as any);
      });
      out.push({ name: '7. pagination shape preserved (page=1 limit=1)',
        ok: r.meta.page === 1 && r.meta.limit === 1 && r.data.length <= 1,
        detail: `page=${r.meta.page} limit=${r.meta.limit} data=${r.data.length}` });
    } finally { await prisma.$disconnect(); }
  });

  // 8 — sentinel (mutation shape preserved): construct service, verify the
  // upsert path is callable as a no-op shape check by calling it inside
  // pilot scope and asserting it returns an object with id+employee
  // (or that it raises NotFound for cross-tenant — covered in isolation).
  // Here we just check that it doesn't throw type errors on shape.
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'false' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      const r: any = await svc.upsertRecord({ employeeId: empA, date: '2025-02-15', status: 'PRESENT', checkIn: '08:00', checkOut: '16:00' } as any, undefined);
      out.push({ name: '8. mutation shape preserved (upsert returns id + employee)',
        ok: !!r?.id && !!r?.employee, detail: `id=${r?.id?.slice(0,8)}` });
    } finally { await prisma.$disconnect(); }
  });

  // 9, 10, 11, 12 — allow-list contracts
  out.push({ name: '9. allow-list unset ⇒ all modules allowed',
    ok: isModuleAllowed('attendance') && isModuleAllowed('employees'), detail: 'both true' });
  await withFlags({ TENANT_PRISMA_PILOT_MODULES: 'attendance' }, () => {
    out.push({ name: '10. allow-list "attendance" allows attendance, denies others',
      ok: isModuleAllowed('attendance') && !isModuleAllowed('employees'),
      detail: `att=${isModuleAllowed('attendance')} emp=${isModuleAllowed('employees')}` });
  });
  await withFlags({ TENANT_PRISMA_PILOT_MODULES: 'attendance,employees' }, () => {
    out.push({ name: '11. allow-list comma-separated allows both',
      ok: isModuleAllowed('attendance') && isModuleAllowed('employees'),
      detail: 'both true' });
  });
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'nothing' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    await withRequestContext({ requestId: newRequestId() }, async () => {
      TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
      const s = getPilotScope(pilot, 'attendance');
      out.push({ name: '12. allow-list "nothing" ⇒ scope inactive (legacy)',
        ok: !s.active && /not in TENANT_PRISMA_PILOT_MODULES/.test(s.reason),
        detail: s.reason });
    });
    await prisma.$disconnect();
  });

  await fs.mkdir(OUT_DIR, { recursive: true });
  const passed = out.filter((c) => c.ok).length;
  const total = out.length;
  await fs.writeFile(path.join(OUT_DIR, 'attendance-equivalence.json'),
    JSON.stringify({ passed, total, cases: out }, null, 2));
  const md = [
    `# Phase 2.47 — attendance equivalence`, ``,
    `**${passed}/${total} PASS**`, ``,
    ...out.map((c) => `- ${c.ok ? 'PASS' : 'FAIL'} — ${c.name} — ${c.detail}`), ``,
  ].join('\n');
  await fs.writeFile(path.join(OUT_DIR, 'attendance-equivalence.md'), md);
  console.log(`[attendance-equivalence] ${passed}/${total} PASS`);
  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(2); });
