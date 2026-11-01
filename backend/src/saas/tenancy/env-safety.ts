/**
 * Phase 2.2 — Environment Safety Gate.
 *
 * The tenant-context middleware refuses to activate outside of staging.
 * This module owns the runtime check + the typed result.
 *
 * Classification (mirrors `backend/scripts/saas/phase1/env-safety.ts`):
 *
 *   SAFE_CLONE        — host on localhost-or-fixture pattern
 *   SAFE_STAGING      — host on staging allow-list
 *   READONLY_REPLICA  — Postgres flag indicates RO; we don't probe at
 *                       middleware time, so this is treated as UNKNOWN
 *   UNSAFE_PRODUCTION — host or DB-name on prod deny-list
 *   UNKNOWN           — everything else
 *
 * The runtime gate uses `process.env.NODE_ENV` and `process.env.DATABASE_URL`.
 * Production is identified by:
 *   - NODE_ENV=production, OR
 *   - host matches the prod deny-list, OR
 *   - DB name matches the prod deny-list, AND no override.
 */
const STAGING_HOST_PATTERNS = [
  /^127\.0\.0\.1$/, /^localhost$/,
  /^staging[-.]/, /^stg[-.]/,
  /\.staging\./, /\.stg\./,
  /^postgres-staging-/,
];
const PROD_HOST_PATTERNS = [
  /^prod[-.]/, /\.prod\./, /^postgres-prod-/, /\.production\./,
];
const PROD_DB_PATTERNS = [
  /^prod$/i, /^production$/i, /_prod$/i, /^tempworks_prod/i,
];
const FIXTURE_DB_PATTERNS = [
  /_fixture$/i, /_test$/i, /^spike_/i, /^saas_phase1_fixture$/i,
];

export type EnvClassification =
  | 'SAFE_CLONE' | 'SAFE_STAGING'
  | 'UNSAFE_PRODUCTION' | 'UNKNOWN';

export interface EnvSafetyResult {
  classification: EnvClassification;
  reason: string;
  host: string;
  dbName: string;
  nodeEnv: string;
}

export function classifyRuntimeEnv(): EnvSafetyResult {
  const url = process.env.DATABASE_URL ?? '';
  let host = '', dbName = '';
  try {
    if (url) {
      const u = new URL(url);
      host = u.hostname;
      dbName = u.pathname.replace(/^\//, '');
    }
  } catch { /* ignore */ }

  const nodeEnv = process.env.NODE_ENV ?? 'unset';

  if (nodeEnv === 'production') {
    return { classification: 'UNSAFE_PRODUCTION',
      reason: 'NODE_ENV=production', host, dbName, nodeEnv };
  }
  if (PROD_HOST_PATTERNS.some((re) => re.test(host)) || PROD_DB_PATTERNS.some((re) => re.test(dbName))) {
    return { classification: 'UNSAFE_PRODUCTION',
      reason: `host/db on prod deny-list (host=${host}, db=${dbName})`,
      host, dbName, nodeEnv };
  }
  if ((host === '127.0.0.1' || host === 'localhost') && FIXTURE_DB_PATTERNS.some((re) => re.test(dbName))) {
    return { classification: 'SAFE_CLONE',
      reason: `localhost + fixture pattern (db=${dbName})`,
      host, dbName, nodeEnv };
  }
  if (STAGING_HOST_PATTERNS.some((re) => re.test(host))) {
    return { classification: 'SAFE_STAGING',
      reason: `host on staging allow-list (${host})`,
      host, dbName, nodeEnv };
  }
  return { classification: 'UNKNOWN',
    reason: `host="${host}" db="${dbName}" did not match any pattern`,
    host, dbName, nodeEnv };
}

export function isStagingClassification(c: EnvClassification): boolean {
  return c === 'SAFE_CLONE' || c === 'SAFE_STAGING';
}
