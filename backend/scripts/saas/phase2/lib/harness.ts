/**
 * Phase 2.12 — shared harness scaffolding for pilot equivalence /
 * isolation scripts.
 *
 * Goal: stop copy-pasting the same 120 lines into every new harness.
 * Every helper here is intentionally small and unsurprising. None of
 * them encode business logic — they just remove rote scaffolding.
 *
 * Usage:
 *
 *   import {
 *     getDatabaseUrl, abortUnlessStaging, withFlags,
 *     discoverPilotTenants, writeReport,
 *   } from './lib/harness';
 *
 *   async function main() {
 *     const url = getDatabaseUrl();
 *     const env = abortUnlessStaging('my-harness');
 *     const tenants = await discoverPilotTenants(url);
 *     const out: CaseResult[] = [];
 *     // ...push cases...
 *     await writeReport({ title: 'My Harness', name: 'my-harness',
 *                         out, environment: env });
 *   }
 *
 *   main().catch((e) => { console.error(e); process.exit(3); });
 */
/* eslint-disable no-console */
import { promises as fs } from 'fs';
import path from 'path';
import { Client } from 'pg';
import { autoLoadEnv, formatDatabaseUrlMissingMessage } from './../../phase1/reconciliation/lib/env';
import {
  classifyRuntimeEnv,
  isStagingClassification,
  EnvSafetyResult,
} from '../../../../src/saas/tenancy/env-safety';

autoLoadEnv(__filename);

export interface CaseResult {
  name: string;
  ok: boolean;
  detail: string;
  durationMs?: number;
}

const OUT_DIR = path.resolve(__dirname, '..', '..', '..', '..', 'reports', 'saas', 'phase2');

/** Resolve DATABASE_URL with the same precedence every harness uses. */
export function getDatabaseUrl(): string {
  const arg = process.argv.find((a) => a.startsWith('--db='))?.slice(5);
  const url = arg ?? process.env.DATABASE_URL;
  if (!url) throw new Error(formatDatabaseUrlMissingMessage());
  return url;
}

/** Hard guard: refuse to run on UNSAFE_PRODUCTION / UNKNOWN. */
export function abortUnlessStaging(harnessName: string): EnvSafetyResult {
  const env = classifyRuntimeEnv();
  if (!isStagingClassification(env.classification)) {
    console.error(`[${harnessName}] refusing on classification=${env.classification}: ${env.reason}`);
    process.exit(3);
  }
  return env;
}

/** Apply a transient process.env mutation while `fn` runs. Restores
 *  the previous env before returning, including unsetting keys that
 *  were originally undefined. */
export async function withFlags<T>(
  env: Record<string, string | undefined>,
  fn: () => Promise<T> | T,
): Promise<T> {
  const prev = { ...process.env };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { return await fn(); }
  finally { process.env = prev; }
}

/** Cheap pg connection helper. */
function makeClient(url: string): Client {
  return new Client({
    connectionString: url,
    ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false },
  });
}

export interface DiscoveredTenants {
  tenantA: string;
  tenantB: string | undefined;
  /** All tenant ids that have at least one user in scope. */
  all: string[];
}

/** Pick the first two tenants that have at least one user in scope.
 *  Mirrors the lookup every isolation harness has been doing. */
export async function discoverPilotTenants(databaseUrl: string): Promise<DiscoveredTenants> {
  const c = makeClient(databaseUrl);
  await c.connect();
  try {
    const r = await c.query<{ id: string }>(
      `SELECT t.id FROM tenants t
        WHERE EXISTS (
          SELECT 1 FROM users u WHERE u."agencyId" IN (
            SELECT id FROM agencies WHERE "tenantId" = t.id::text
          )
        )
        ORDER BY t.name`);
    const all = r.rows.map((row) => row.id);
    return { tenantA: all[0], tenantB: all[1], all };
  } finally {
    await c.end();
  }
}

/** Lookup a single user id for a given tenant. Returns null if none. */
export async function discoverUserForTenant(
  databaseUrl: string,
  tenantId: string,
): Promise<string | null> {
  const c = makeClient(databaseUrl);
  await c.connect();
  try {
    const r = await c.query<{ id: string }>(
      `SELECT u.id FROM users u
       WHERE u."agencyId" IN (SELECT id FROM agencies WHERE "tenantId" = $1::text)
       LIMIT 1`,
      [tenantId],
    );
    return r.rows[0]?.id ?? null;
  } finally {
    await c.end();
  }
}

/** Lookup a single employee id for a given tenant. Returns null if none. */
export async function discoverEmployeeForTenant(
  databaseUrl: string,
  tenantId: string,
): Promise<string | null> {
  const c = makeClient(databaseUrl);
  await c.connect();
  try {
    const r = await c.query<{ id: string }>(
      `SELECT id FROM employees WHERE "tenantId" = $1 LIMIT 1`,
      [tenantId],
    );
    return r.rows[0]?.id ?? null;
  } finally {
    await c.end();
  }
}

export interface ReportInput {
  /** Heading shown in the markdown report. */
  title: string;
  /** Filename stem (no extension). Files are written as
   *  `<OUT_DIR>/<name>.{json,md}`. */
  name: string;
  out: CaseResult[];
  environment: EnvSafetyResult;
  /** Optional extra metadata to surface in the JSON report. */
  metadata?: Record<string, unknown>;
}

/** Writes the JSON + Markdown report and prints a one-line headline.
 *  Exits the process with code 2 when any case failed; returns
 *  normally when everything passed. */
export async function writeReport(input: ReportInput): Promise<void> {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const passed = input.out.filter((r) => r.ok).length;
  const failed = input.out.length - passed;

  const summary = {
    generatedAt: new Date().toISOString(),
    environment: input.environment,
    counts: { total: input.out.length, passed, failed },
    ...(input.metadata ?? {}),
    results: input.out,
  };
  await fs.writeFile(
    path.join(OUT_DIR, `${input.name}.json`),
    JSON.stringify(summary, null, 2),
  );

  const md: string[] = [];
  md.push(`# ${input.title}`);
  md.push('');
  md.push(`Generated: ${summary.generatedAt}`);
  md.push(`Environment: ${input.environment.classification} (${input.environment.reason})`);
  md.push('');
  md.push(`- Cases passed: **${passed}** / ${input.out.length}`);
  md.push(`- Cases failed: ${failed}`);
  md.push('');
  md.push('| # | Case | Result | Detail |');
  md.push('|--:|------|:------:|--------|');
  input.out.forEach((r, i) =>
    md.push(`| ${i + 1} | ${r.name} | ${r.ok ? 'PASS' : '**FAIL**'} | ${r.detail} |`));
  await fs.writeFile(
    path.join(OUT_DIR, `${input.name}.md`),
    md.join('\n'),
  );

  console.log(`${input.name}: ${passed}/${input.out.length} cases PASS`);
  if (failed > 0) process.exit(2);
}
