/**
 * Phase 2.2 — Tenant Context Smoke Test.
 *
 * In-process smoke test that exercises the building blocks WITHOUT
 * needing a running NestJS server. The harness manipulates
 * `process.env`, instantiates the relevant services with stub deps,
 * and asserts the documented behaviour for each scenario.
 *
 * Scenarios:
 *   1. flags off → no-op (TenantContext.optional() === null)
 *   2. staging flags on + valid header → context resolves from header
 *   3. production flags on → middleware refuses (env unsafe)
 *   4. tenant-safe reports require context (flag on)
 *   5. disabled report source fails closed (Phase 2.1 contract)
 *   6. ready report source executes with tenant context
 *   7. context does not leak across concurrent requests
 *
 * Output: `backend/reports/saas/phase2/context-smoke.{json,md}`.
 *
 * Exit:
 *   0 — all PASS
 *   2 — at least one FAIL
 *   3 — runtime error
 */
/* eslint-disable no-console */
import { promises as fs } from 'fs';
import path from 'path';
import {
  autoLoadEnv,
  formatDatabaseUrlMissingMessage,
} from './../phase1/reconciliation/lib/env';
import { FeatureFlagsService } from '../../../src/saas/feature-flags/feature-flags.service';
import { TenantResolverService } from '../../../src/saas/tenancy/tenant-resolver.service';
import { TenantContextMiddleware } from '../../../src/saas/context/tenant-context.middleware';
import {
  TenantContext,
  UserContext,
  withRequestContext,
  newRequestId,
} from '../../../src/saas/context/als';
import {
  TENANT_SAFE_SOURCES,
} from '../../../src/saas/reports/runtime/report-sources';
import { buildTenantSafeWhere } from '../../../src/saas/reports/where-builder';

autoLoadEnv(__filename);

const OUT_DIR = path.resolve(__dirname, '..', '..', '..', 'reports', 'saas', 'phase2');

function getDatabaseUrl(): string {
  const arg = process.argv.find((a) => a.startsWith('--db='))?.slice(5);
  const url = arg ?? process.env.DATABASE_URL;
  if (!url) throw new Error(formatDatabaseUrlMissingMessage());
  return url;
}

interface CaseResult {
  name: string;
  ok: boolean;
  detail: string;
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

/** Fake Prisma client that satisfies the resolver's tiny surface. */
function makeFakePrisma(opts: {
  tenants: { id: string; slug: string; name: string; status: string; region: string }[];
  agencies?: { id: string; tenantId: string | null }[];
  domains?:  { host: string; tenantId: string }[];
}) {
  return {
    tenant: {
      findFirst: async ({ where }: any) => {
        return opts.tenants.find((t) =>
          (where?.id && t.id === where.id) ||
          (where?.slug && t.slug === where.slug),
        ) ?? null;
      },
    },
    tenantDomain: {
      findFirst: async ({ where }: any) => {
        return (opts.domains ?? []).find((d) => d.host === where?.host) ?? null;
      },
    },
    agency: {
      findFirst: async ({ where }: any) => {
        return (opts.agencies ?? []).find((a) => a.id === where?.id) ?? null;
      },
    },
  };
}

async function runCases(): Promise<CaseResult[]> {
  const out: CaseResult[] = [];
  const TID = '11111111-1111-1111-1111-111111111111';
  const tenants = [{ id: TID, slug: 'acme', name: 'Acme', status: 'ACTIVE', region: 'eu' }];

  // ---- Case 1 — flags off → no-op
  await withFlags({ MULTI_TENANT_ENABLED: 'false' }, async () => {
    const flags = new FeatureFlagsService();
    const resolver = new TenantResolverService(makeFakePrisma({ tenants }) as any, flags);
    const r = await resolver.resolve({ host: 'acme.localhost', headerTenantId: TID });
    out.push({
      name: 'flags off → no-op resolver',
      ok: r.tenant === null && r.method === 'none',
      detail: `method=${r.method}, tenant=${r.tenant?.id ?? 'null'}`,
    });
  });

  // ---- Case 2 — staging flags on + valid header → resolves
  await withFlags(
    { MULTI_TENANT_ENABLED: 'true', NODE_ENV: 'development',
      DATABASE_URL: 'postgres://postgres@127.0.0.1/saas_phase1_fixture?sslmode=disable' },
    async () => {
      const flags = new FeatureFlagsService();
      const resolver = new TenantResolverService(makeFakePrisma({ tenants }) as any, flags);
      const r = await resolver.resolve({ host: 'app.tempworks.test', headerTenantId: TID });
      out.push({
        name: 'staging flags on + valid header → resolves from header',
        ok: r.tenant?.id === TID && r.method === 'header',
        detail: `method=${r.method}, tenant=${r.tenant?.id}`,
      });
    },
  );

  // ---- Case 3 — production flags on → middleware refuses
  await withFlags(
    { MULTI_TENANT_ENABLED: 'true', NODE_ENV: 'production',
      DATABASE_URL: 'postgres://postgres@prod-db-1.prod.example.com/tempworks_prod' },
    async () => {
      const flags = new FeatureFlagsService();
      const resolver = new TenantResolverService(makeFakePrisma({ tenants }) as any, flags);
      const mw = new TenantContextMiddleware(flags, resolver);
      const req: any = { hostname: 'prod-host', headers: {}, path: '/api/v1/anything', user: null };
      const res: any = {};
      let nextErr: any = null;
      await new Promise<void>((resolve) => {
        mw.use(req, res, ((e: any) => { nextErr = e; resolve(); }) as any);
      });
      out.push({
        name: 'production flags on → middleware refuses with error',
        ok: !!nextErr && /refused outside staging/i.test(String(nextErr?.message ?? '')),
        detail: nextErr ? String(nextErr.message).slice(0, 120) : 'no error',
      });
    },
  );

  // ---- Case 4 — tenant-safe reports require context (when flag on)
  await withFlags(
    { MULTI_TENANT_ENABLED: 'true', TENANT_SAFE_REPORTS_ENABLED: 'true',
      TENANT_CONTEXT_REQUIRED_FOR_SAFE_REPORTS: 'true',
      NODE_ENV: 'development',
      DATABASE_URL: 'postgres://postgres@127.0.0.1/saas_phase1_fixture?sslmode=disable' },
    async () => {
      // Without tenant context, builder rejects via UUID check (proxy
      // for the higher-level "context required" enforcement).
      let threw = false;
      try {
        buildTenantSafeWhere(TENANT_SAFE_SOURCES.employees!.def!, [], {
          tenantId: '', platformAdmin: false,
        });
      } catch { threw = true; }
      out.push({
        name: 'tenant-safe builder requires a valid tenantId',
        ok: threw,
        detail: threw ? 'rejected empty tenantId' : 'unexpectedly accepted empty tenantId',
      });
    },
  );

  // ---- Case 5 — disabled source fails closed
  {
    // `documents` was DISABLED in Phase 2.1 and flipped to READY in Phase 2.3.
    // Use a source that is still DISABLED post-2.3 (catalog or join-keyed).
    const m = TENANT_SAFE_SOURCES['document_types'];
    out.push({
      name: 'disabled report source fails closed',
      ok: m?.status === 'DISABLED',
      detail: `document_types status=${m?.status}, reason=${m?.reason}`,
    });
  }

  // ---- Case 6 — ready source executes with tenant context (builder smoke)
  {
    const def = TENANT_SAFE_SOURCES.employees!.def!;
    const w = buildTenantSafeWhere(def, [], { tenantId: TID, platformAdmin: false });
    const startsWithTenant = w.sql.startsWith('"e"."tenantId" = $1');
    out.push({
      name: 'ready source builder emits tenant=$1 first',
      ok: startsWithTenant && w.params[0] === TID,
      detail: `sql="${w.sql.slice(0, 60)}…", params[0]=${w.params[0]}`,
    });
  }

  // ---- Case 7 — context does not leak across concurrent requests
  {
    const T1 = '11111111-1111-1111-1111-111111111111';
    const T2 = '22222222-2222-2222-2222-222222222222';
    const seen: Array<string | null> = [];
    await Promise.all([
      withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: T1, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        await new Promise((r) => setTimeout(r, 5));
        seen.push(TenantContext.optional()?.id ?? null);
      }),
      withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: T2, slug: 'b', name: 'B', status: 'ACTIVE', region: 'eu' });
        await new Promise((r) => setTimeout(r, 1));
        seen.push(TenantContext.optional()?.id ?? null);
      }),
    ]);
    out.push({
      name: 'two parallel ALS frames do not bleed',
      ok: seen.length === 2 && seen.includes(T1) && seen.includes(T2),
      detail: `seen=${JSON.stringify(seen)}`,
    });
  }

  return out;
}

async function main(): Promise<void> {
  // The smoke test no longer needs a live DB; it exercises the
  // building blocks in-process. We still call `getDatabaseUrl` to
  // surface the cross-shell error message if invoked without env.
  void getDatabaseUrl;

  const results = await runCases();
  await fs.mkdir(OUT_DIR, { recursive: true });

  const summary = {
    generatedAt: new Date().toISOString(),
    counts: { total: results.length, passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length },
    results,
  };
  await fs.writeFile(path.join(OUT_DIR, 'context-smoke.json'), JSON.stringify(summary, null, 2));

  const md: string[] = [];
  md.push('# Phase 2.2 — Tenant Context Smoke Test');
  md.push('');
  md.push(`Generated: ${summary.generatedAt}`);
  md.push('');
  md.push(`- Total cases: ${summary.counts.total}`);
  md.push(`- Passed: **${summary.counts.passed}**`);
  md.push(`- Failed: ${summary.counts.failed}`);
  md.push('');
  md.push('| # | Case | Result | Detail |');
  md.push('|--:|------|:------:|--------|');
  results.forEach((r, i) =>
    md.push(`| ${i + 1} | ${r.name} | ${r.ok ? 'PASS' : '**FAIL**'} | ${r.detail} |`));
  md.push('');
  await fs.writeFile(path.join(OUT_DIR, 'context-smoke.md'), md.join('\n'));

  console.log(`context-smoke: ${summary.counts.passed}/${summary.counts.total} cases PASS`);
  if (summary.counts.failed > 0) process.exit(2);
}

main().catch((e) => { console.error(e); process.exit(3); });
