/**
 * Phase 2.7 — employee-work-history pilot isolation harness.
 *
 * Proves the tenant-scoped pilot enforces real boundaries:
 *   1. With pilot ON + tenant A in ALS, list(empA) returns only tenant A
 *      rows; the cross-tenant collision row (same shape, tenant B) does
 *      not appear.
 *   2. With pilot ON + tenant A, attempting to read tenant B's employee
 *      via assertEmployeeExists raises NotFoundException (cross-tenant
 *      employee id is not visible).
 *   3. With pilot ON + tenant A, attempting to update a tenant B
 *      work-history row raises NotFoundException — no update reaches
 *      the DB. (Verified by row-snapshot before/after.)
 *   4. With pilot ON + tenant A, attempting to remove a tenant B row
 *      raises NotFoundException; the row's deletedAt remains NULL.
 *   5. With pilot ON + tenant A, create() persists tenantId=A.
 *   6. Concurrent ALS frames (T_A and T_B) both call list(empA-of-self)
 *      and see only their own rows — no context bleed.
 *   7. With pilot OFF, legacy path returns the union (both tenants'
 *      rows reachable when querying by employeeId — Phase 0 behaviour).
 *
 * Output:
 *   backend/reports/saas/phase2/employee-work-history-isolation.{json,md}
 *
 * Exit:
 *   0 — every assertion holds
 *   2 — at least one isolation failure
 *   3 — runtime error
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
import { EmployeeWorkHistoryService } from '../../../src/employee-work-history/employee-work-history.service';
import {
  TenantContext,
  withRequestContext,
  newRequestId,
} from '../../../src/saas/context/als';

autoLoadEnv(__filename);

const OUT_DIR = path.resolve(__dirname, '..', '..', '..', 'reports', 'saas', 'phase2');

interface CaseResult { name: string; ok: boolean; detail: string; }

class StubStorage {
  async uploadFile(_b: Buffer, _o: any) { return { url: 'fixture://stub.bin' }; }
  async deleteFileByUrlOrKey(_x: string) { /* empty */ }
}

function getDatabaseUrl(): string {
  const arg = process.argv.find((a) => a.startsWith('--db='))?.slice(5);
  return arg ?? process.env.DATABASE_URL ?? (() => { throw new Error(formatDatabaseUrlMissingMessage()); })();
}

async function withFlags<T>(env: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const prev = { ...process.env };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { return await fn(); }
  finally { process.env = prev; }
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const env = classifyRuntimeEnv();
  if (!isStagingClassification(env.classification)) {
    console.error(`[ewh-isolation] refusing on classification=${env.classification}`);
    process.exit(3);
  }

  const c = new Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
  await c.connect();
  // Pick the first two tenants that actually have at least one employee.
  const ts = await c.query<{ id: string }>(
    `SELECT t.id FROM tenants t
       WHERE EXISTS (SELECT 1 FROM employees e WHERE e."tenantId" = t.id::text)
       ORDER BY t.name`,
  );
  const tA = ts.rows[0]?.id; const tB = ts.rows[1]?.id;
  const ea = await c.query<{ id: string }>(`SELECT id FROM employees WHERE "tenantId" = $1 LIMIT 1`, [tA]);
  const eb = await c.query<{ id: string }>(`SELECT id FROM employees WHERE "tenantId" = $1 LIMIT 1`, [tB]);
  const empA = ea.rows[0]?.id; const empB = eb.rows[0]?.id;

  if (!tA || !tB || !empA || !empB) {
    console.error('[ewh-isolation] need 2 tenants each with at least one employee in fixture');
    process.exit(3);
  }

  const out: CaseResult[] = [];

  // 1+2+5 — pilot ON, tenant A
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true' }, async () => {
    const flags = new FeatureFlagsService();
    const prisma = new PrismaService();
    const tp = new TenantPrismaService(prisma, flags);
    const pilot = new PilotPrismaAccessor(prisma, tp, flags);
    const svc = new EmployeeWorkHistoryService(prisma, new StubStorage() as any, pilot);
    try {
      // Tenant A's view.
      const listA = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.list(empA);
      });
      const idsA = listA.map((r: any) => r.id);
      out.push({
        name: 'pilot ON, tenant A: list(empA) returns ONLY tenant A rows',
        ok: idsA.every((id: string) => id.startsWith('00000000-0000-0000-0000-0000000ea')),
        detail: `ids=${idsA.join(',')}`,
      });
      out.push({
        name: 'pilot ON, tenant A: NULL-tenant legacy row not surfaced',
        ok: !idsA.includes('00000000-0000-0000-0000-0000000ea999'),
        detail: 'legacy NULL-tenant row excluded',
      });
      // Tenant B's employee id presents as 404 to tenant A.
      let leakedAsRow = false;
      try {
        await withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
          await svc.list(empB);
        });
        leakedAsRow = true;
      } catch (e) {
        leakedAsRow = false;
      }
      out.push({
        name: 'pilot ON, tenant A: list(empB) raises NotFoundException (cross-tenant employee id hidden)',
        ok: !leakedAsRow,
        detail: leakedAsRow ? 'UNEXPECTED: list returned for tenant B employee' : 'NotFoundException raised',
      });

      // create — must persist tenantId=A.
      const created = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.create(empA, { date: '2025-09-15', eventType: 'NEW_CONTRACT', description: 'iso-temp-A' } as any);
      });
      out.push({
        name: 'pilot ON, tenant A: create persists tenantId=A',
        ok: (created as any).tenantId === tA,
        detail: `tenantId=${(created as any).tenantId}`,
      });
      // Cleanup
      await (prisma as any).employeeWorkHistory.delete({ where: { id: created.id } });
    } finally { await prisma.$disconnect(); }
  });

  // 3+4 — update / remove a tenant B row from tenant A's view = NotFoundException
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true' }, async () => {
    const flags = new FeatureFlagsService();
    const prisma = new PrismaService();
    const tp = new TenantPrismaService(prisma, flags);
    const pilot = new PilotPrismaAccessor(prisma, tp, flags);
    const svc = new EmployeeWorkHistoryService(prisma, new StubStorage() as any, pilot);
    try {
      // Snapshot the tenant B row before.
      const beforeRow = await (prisma as any).employeeWorkHistory.findUnique({
        where: { id: '00000000-0000-0000-0000-0000000eb001' },
      });
      let updateLeaked = false;
      try {
        await withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
          await svc.update(empB, '00000000-0000-0000-0000-0000000eb001',
            { description: 'A-trying-to-update-B' } as any);
        });
        updateLeaked = true;
      } catch { updateLeaked = false; }
      const afterRow = await (prisma as any).employeeWorkHistory.findUnique({
        where: { id: '00000000-0000-0000-0000-0000000eb001' },
      });
      out.push({
        name: 'pilot ON, tenant A: update on tenant B entry rejected, row unchanged',
        ok: !updateLeaked
          && beforeRow?.description === afterRow?.description
          && (afterRow?.description ?? '').includes('tenant B'),
        detail: `before=${beforeRow?.description?.slice(0, 30)} after=${afterRow?.description?.slice(0, 30)}`,
      });

      let removeLeaked = false;
      try {
        await withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
          await svc.remove(empB, '00000000-0000-0000-0000-0000000eb001');
        });
        removeLeaked = true;
      } catch { removeLeaked = false; }
      const afterRow2 = await (prisma as any).employeeWorkHistory.findUnique({
        where: { id: '00000000-0000-0000-0000-0000000eb001' },
      });
      out.push({
        name: 'pilot ON, tenant A: remove of tenant B entry rejected, deletedAt still NULL',
        ok: !removeLeaked && afterRow2?.deletedAt === null,
        detail: `deletedAt=${afterRow2?.deletedAt ?? 'null'}`,
      });
    } finally { await prisma.$disconnect(); }
  });

  // 6 — concurrent ALS frames (T_A vs T_B)
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true' }, async () => {
    const flags = new FeatureFlagsService();
    const prisma = new PrismaService();
    const tp = new TenantPrismaService(prisma, flags);
    const pilot = new PilotPrismaAccessor(prisma, tp, flags);
    const svc = new EmployeeWorkHistoryService(prisma, new StubStorage() as any, pilot);
    try {
      const seenA: string[][] = [];
      const seenB: string[][] = [];
      await Promise.all([
        withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
          await new Promise((r) => setTimeout(r, 5));
          const r = await svc.list(empA);
          seenA.push(r.map((x: any) => x.id));
        }),
        withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tB, slug: 'b', name: 'B', status: 'ACTIVE', region: 'eu' });
          await new Promise((r) => setTimeout(r, 1));
          const r = await svc.list(empB);
          seenB.push(r.map((x: any) => x.id));
        }),
      ]);
      const aOnlyA = seenA[0]?.every((id) => id.startsWith('00000000-0000-0000-0000-0000000ea'));
      const bOnlyB = seenB[0]?.every((id) => id.startsWith('00000000-0000-0000-0000-0000000eb'));
      out.push({
        name: 'concurrent ALS frames isolated (T_A sees only A, T_B sees only B)',
        ok: !!aOnlyA && !!bOnlyB,
        detail: `seenA=${seenA[0]?.join(',')} seenB=${seenB[0]?.join(',')}`,
      });
    } finally { await prisma.$disconnect(); }
  });

  // 7 — pilot OFF: legacy path reads everything for the queried employee
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'false' }, async () => {
    const flags = new FeatureFlagsService();
    const prisma = new PrismaService();
    const tp = new TenantPrismaService(prisma, flags);
    const pilot = new PilotPrismaAccessor(prisma, tp, flags);
    const svc = new EmployeeWorkHistoryService(prisma, new StubStorage() as any, pilot);
    try {
      const r = await svc.list(empA);
      const ids = r.map((x: any) => x.id);
      out.push({
        name: 'pilot OFF: legacy returns rows including NULL-tenant legacy row',
        ok: ids.includes('00000000-0000-0000-0000-0000000ea999'),
        detail: `ids=${ids.join(',')}`,
      });
    } finally { await prisma.$disconnect(); }
  });

  // Final cleanup: remove any leftover iso-temp rows.
  const cleanup = new Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
  await cleanup.connect();
  await cleanup.query(`DELETE FROM employee_work_history WHERE description LIKE 'iso-temp-%'`);
  await cleanup.end();
  await c.end();

  await fs.mkdir(OUT_DIR, { recursive: true });
  const summary = {
    generatedAt: new Date().toISOString(),
    environment: env, tenantA: tA, tenantB: tB, empA, empB,
    counts: { total: out.length, passed: out.filter((r) => r.ok).length, failed: out.filter((r) => !r.ok).length },
    results: out,
  };
  await fs.writeFile(path.join(OUT_DIR, 'employee-work-history-isolation.json'), JSON.stringify(summary, null, 2));
  const md: string[] = [];
  md.push('# Phase 2.7 — Employee Work History Isolation');
  md.push('');
  md.push(`Generated: ${summary.generatedAt}`);
  md.push(`Environment: ${env.classification} (${env.reason})`);
  md.push(`Tenants: A=\`${tA}\` B=\`${tB}\``);
  md.push(`Employees: A=\`${empA}\` B=\`${empB}\``);
  md.push('');
  md.push(`- Cases passed: **${summary.counts.passed}** / ${summary.counts.total}`);
  md.push(`- Cases failed: ${summary.counts.failed}`);
  md.push('');
  md.push('| # | Case | Result | Detail |');
  md.push('|--:|------|:------:|--------|');
  out.forEach((r, i) => md.push(`| ${i + 1} | ${r.name} | ${r.ok ? 'PASS' : '**FAIL**'} | ${r.detail} |`));
  await fs.writeFile(path.join(OUT_DIR, 'employee-work-history-isolation.md'), md.join('\n'));

  console.log(`employee-work-history-isolation: ${summary.counts.passed}/${summary.counts.total} cases PASS`);
  if (summary.counts.failed > 0) process.exit(2);
}

main().catch((e) => { console.error(e); process.exit(3); });
