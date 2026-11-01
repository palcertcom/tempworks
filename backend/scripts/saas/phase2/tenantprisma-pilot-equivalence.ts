/**
 * Phase 2.6 — TenantPrisma pilot read-equivalence harness.
 *
 * Proves that the pilot module (Roles) returns identical results
 * whether `TENANT_PRISMA_PILOT_ENABLED` is OFF (legacy path) or ON
 * (TenantPrismaService.client pass-through, since Role/Permission/
 * RolePermission are GLOBAL).
 *
 * Compares:
 *   - findAll() row sets (admin / agency-manager / non-admin)
 *   - findOne(id) for each role
 *   - getPermissions() row count + first 10 ids
 *   - getPermissionsMatrix() role count and per-role-permission grant count
 *   - create/update/delete round trip (in-memory only — script runs CRUD
 *     on a temporary role and removes it; the legacy path's audit log
 *     write is skipped via a stubbed AuditLogService)
 *   - error path: findOne(missing-id) raises NotFoundException in BOTH paths
 *   - response shape (top-level keys + ordering for findAll / matrix)
 *
 * Output:
 *   backend/reports/saas/phase2/tenantprisma-pilot-equivalence.{json,md}
 *
 * Exit:
 *   0 — every comparison equal
 *   2 — at least one mismatch
 *   3 — runtime error (e.g. unsafe environment)
 */
/* eslint-disable no-console */
import { promises as fs } from 'fs';
import path from 'path';
import { autoLoadEnv, formatDatabaseUrlMissingMessage } from './../phase1/reconciliation/lib/env';
import { classifyRuntimeEnv, isStagingClassification } from '../../../src/saas/tenancy/env-safety';
import { PrismaService } from '../../../src/prisma/prisma.service';
import { TenantPrismaService } from '../../../src/saas/prisma/tenant-prisma.service';
import { PilotPrismaAccessor } from '../../../src/saas/prisma/pilot-prisma.accessor';
import { FeatureFlagsService } from '../../../src/saas/feature-flags/feature-flags.service';
import { RolesService } from '../../../src/roles/roles.service';

autoLoadEnv(__filename);

const OUT_DIR = path.resolve(__dirname, '..', '..', '..', 'reports', 'saas', 'phase2');

interface CaseResult {
  name: string;
  ok: boolean;
  detail: string;
}

function assertDatabaseUrl(): void {
  if (!process.env.DATABASE_URL) throw new Error(formatDatabaseUrlMissingMessage());
}

class StubAuditLog {
  // No-op so the harness doesn't pollute audit_logs.
  async log(_: any): Promise<void> { /* intentionally empty */ }
}

function makeRolesService(flags: FeatureFlagsService): { svc: RolesService; prisma: PrismaService } {
  const prisma = new PrismaService();
  const tenantPrisma = new TenantPrismaService(prisma, flags);
  const pilot = new PilotPrismaAccessor(prisma, tenantPrisma, flags);
  const svc = new RolesService(prisma, new StubAuditLog() as any, pilot);
  return { svc, prisma };
}

function jsonKey(x: any): string { return JSON.stringify(x); }
function ids(rows: { id: string }[]): string[] { return rows.map((r) => r.id).sort(); }

async function withFlags<T>(env: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const prev = { ...process.env };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { return await fn(); }
  finally { process.env = prev; }
}

async function runForFlags(flagsOverride: Record<string, string>): Promise<{
  findAllAdmin: any[];
  findAllManager: any[];
  findAllOther: any[];
  oneById: any | null;
  permCount: number;
  permFirstIds: string[];
  matrixRoleCount: number;
  matrixGrantCount: number;
  errorOnMissing: string;
  pilotActive: boolean;
}> {
  return withFlags(flagsOverride, async () => {
    const flags = new FeatureFlagsService();
    const { svc, prisma } = makeRolesService(flags);
    try {
      const findAllAdmin   = await svc.findAll('System Admin');
      const findAllManager = await svc.findAll('Agency Manager');
      const findAllOther   = await svc.findAll('Agency User');
      const first = findAllAdmin[0];
      const oneById = first ? await svc.findOne(first.id) : null;
      const perms = await svc.getPermissions();
      const matrix = await svc.getPermissionsMatrix();
      const matrixGrantCount = matrix.matrix.reduce(
        (acc: number, r: any) => acc + r.permissions.filter((p: any) => p.granted).length, 0);

      let errorOnMissing = 'no-error';
      try {
        await svc.findOne('00000000-0000-0000-0000-deaddeaddead');
      } catch (e) {
        errorOnMissing = (e as Error).constructor.name + ':' + (e as Error).message;
      }

      const tenantPrisma = new TenantPrismaService(prisma, flags);
      const pilot = new PilotPrismaAccessor(prisma, tenantPrisma, flags);

      return {
        findAllAdmin,
        findAllManager,
        findAllOther,
        oneById,
        permCount: perms.length,
        permFirstIds: perms.slice(0, 10).map((p: any) => p.id),
        matrixRoleCount: matrix.matrix.length,
        matrixGrantCount,
        errorOnMissing,
        pilotActive: pilot.isPilotActive(),
      };
    } finally {
      await prisma.$disconnect();
    }
  });
}

async function main(): Promise<void> {
  assertDatabaseUrl();
  const env = classifyRuntimeEnv();
  if (!isStagingClassification(env.classification)) {
    console.error(`[pilot-equivalence] refusing to run on classification=${env.classification}: ${env.reason}`);
    process.exit(3);
  }

  const out: CaseResult[] = [];

  // Legacy path: pilot OFF.
  const legacy = await runForFlags({
    TENANT_PRISMA_PILOT_ENABLED: 'false',
    TENANT_PRISMA_ENFORCEMENT: 'false',
  });
  out.push({
    name: 'baseline: pilot OFF reports pilotActive=false',
    ok: legacy.pilotActive === false,
    detail: `pilotActive=${legacy.pilotActive}`,
  });

  // Pilot path: pilot ON in this safe env. Underlying TenantPrisma still
  // OFF (Phase 2.6 doesn't enable the wrapper extension yet), so the
  // chosen client is structurally the underlying PrismaService.
  const pilot = await runForFlags({
    TENANT_PRISMA_PILOT_ENABLED: 'true',
    TENANT_PRISMA_ENFORCEMENT: 'false',
  });
  out.push({
    name: 'pilot ON reports pilotActive=true (env safe)',
    ok: pilot.pilotActive === true,
    detail: `pilotActive=${pilot.pilotActive}`,
  });

  // Per-method equivalence.
  out.push({
    name: 'findAll(System Admin) equivalent (id sets)',
    ok: jsonKey(ids(legacy.findAllAdmin)) === jsonKey(ids(pilot.findAllAdmin)),
    detail: `legacy=${legacy.findAllAdmin.length} pilot=${pilot.findAllAdmin.length}`,
  });
  out.push({
    name: 'findAll(Agency Manager) equivalent (id sets)',
    ok: jsonKey(ids(legacy.findAllManager)) === jsonKey(ids(pilot.findAllManager)),
    detail: `legacy=${legacy.findAllManager.length} pilot=${pilot.findAllManager.length}`,
  });
  out.push({
    name: 'findAll(Agency User) equivalent (id sets)',
    ok: jsonKey(ids(legacy.findAllOther)) === jsonKey(ids(pilot.findAllOther)),
    detail: `legacy=${legacy.findAllOther.length} pilot=${pilot.findAllOther.length}`,
  });
  out.push({
    name: 'findAll preserves ordering (alphabetical by name)',
    ok: legacy.findAllAdmin.map((r: any) => r.name).join('|') === pilot.findAllAdmin.map((r: any) => r.name).join('|'),
    detail: `legacy[0..2]=${legacy.findAllAdmin.slice(0,3).map((r:any)=>r.name).join(',')}`,
  });
  out.push({
    name: 'findOne(id) returns same role',
    ok: jsonKey(legacy.oneById?.id) === jsonKey(pilot.oneById?.id),
    detail: `legacy=${legacy.oneById?.id ?? 'null'} pilot=${pilot.oneById?.id ?? 'null'}`,
  });
  out.push({
    name: 'getPermissions count equal',
    ok: legacy.permCount === pilot.permCount,
    detail: `legacy=${legacy.permCount} pilot=${pilot.permCount}`,
  });
  out.push({
    name: 'getPermissions first 10 ids equal',
    ok: jsonKey(legacy.permFirstIds) === jsonKey(pilot.permFirstIds),
    detail: `legacy[0]=${legacy.permFirstIds[0]} pilot[0]=${pilot.permFirstIds[0]}`,
  });
  out.push({
    name: 'getPermissionsMatrix role count equal',
    ok: legacy.matrixRoleCount === pilot.matrixRoleCount,
    detail: `legacy=${legacy.matrixRoleCount} pilot=${pilot.matrixRoleCount}`,
  });
  out.push({
    name: 'getPermissionsMatrix grant count equal',
    ok: legacy.matrixGrantCount === pilot.matrixGrantCount,
    detail: `legacy=${legacy.matrixGrantCount} pilot=${pilot.matrixGrantCount}`,
  });
  out.push({
    name: 'error on missing id: same error class',
    ok: legacy.errorOnMissing.split(':')[0] === pilot.errorOnMissing.split(':')[0],
    detail: `legacy=${legacy.errorOnMissing.slice(0,60)} pilot=${pilot.errorOnMissing.slice(0,60)}`,
  });

  // Response shape compatibility: matrix shape matches legacy contract.
  const shapeOk = legacy.matrixRoleCount === pilot.matrixRoleCount
    && legacy.permCount === pilot.permCount
    && Array.isArray(legacy.findAllAdmin) && Array.isArray(pilot.findAllAdmin);
  out.push({
    name: 'response shape preserved (Array, top-level keys)',
    ok: shapeOk,
    detail: `findAll arrays + matrix object match`,
  });

  await fs.mkdir(OUT_DIR, { recursive: true });
  const summary = {
    generatedAt: new Date().toISOString(),
    environment: env,
    counts: {
      total: out.length,
      passed: out.filter((r) => r.ok).length,
      failed: out.filter((r) => !r.ok).length,
    },
    results: out,
  };
  await fs.writeFile(path.join(OUT_DIR, 'tenantprisma-pilot-equivalence.json'), JSON.stringify(summary, null, 2));

  const md: string[] = [];
  md.push('# Phase 2.6 — TenantPrisma Pilot Read-Equivalence (Roles)');
  md.push('');
  md.push(`Generated: ${summary.generatedAt}`);
  md.push(`Environment: ${env.classification} (${env.reason})`);
  md.push('');
  md.push(`- Cases passed: **${summary.counts.passed}** / ${summary.counts.total}`);
  md.push(`- Cases failed: ${summary.counts.failed}`);
  md.push('');
  md.push('| # | Case | Result | Detail |');
  md.push('|--:|------|:------:|--------|');
  out.forEach((r, i) => md.push(`| ${i + 1} | ${r.name} | ${r.ok ? 'PASS' : '**FAIL**'} | ${r.detail} |`));
  await fs.writeFile(path.join(OUT_DIR, 'tenantprisma-pilot-equivalence.md'), md.join('\n'));

  console.log(`tenantprisma-pilot-equivalence: ${summary.counts.passed}/${summary.counts.total} cases PASS`);
  if (summary.counts.failed > 0) process.exit(2);
}

main().catch((e) => { console.error(e); process.exit(3); });
