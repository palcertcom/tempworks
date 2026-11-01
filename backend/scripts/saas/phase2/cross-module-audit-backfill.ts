/**
 * Phase 2.51 — Cross-module historic audit-log tenant backfill.
 *
 * Generalises the Phase 2.50 single-entity backfill template to:
 *   - Document             → documents.tenantId
 *   - FinancialRecord      → financial_records.tenantId
 *   - WorkPermit           → work_permits.tenantId
 *   - Visa                 → visas.tenantId
 *   - ComplianceAlert      → compliance_alerts.tenantId
 *   - Notification         → notifications.tenantId
 *
 * All six target tables already carry a denormalised `tenantId`
 * column (Phase 2.3+), so derivation is a direct join — no
 * employee/applicant fan-out or ambiguous resolution is needed.
 *
 * Default-OFF, dry-run by default. Apply requires BOTH:
 *   CROSS_MODULE_AUDIT_BACKFILL_APPLY=true
 *   classifyRuntimeEnv ⇒ SAFE_CLONE / SAFE_STAGING
 *
 * Reports: backend/reports/saas/phase2/cross-module-audit-backfill.{json,md}
 *
 * Tag (raw SQL, scripts/): phase251-cross-module-audit-backfill.
 */
/* eslint-disable no-console */
import { promises as fs } from 'fs';
import path from 'path';
import { Client } from 'pg';
import { autoLoadEnv, formatDatabaseUrlMissingMessage } from './../phase1/reconciliation/lib/env';
import { classifyRuntimeEnv, isStagingClassification } from '../../../src/saas/tenancy/env-safety';

autoLoadEnv(__filename);

const OUT_DIR = path.resolve(__dirname, '..', '..', '..', 'reports', 'saas', 'phase2');

export interface EntitySpec {
  entity: string;
  table:  string;
}

export const TARGET_ENTITIES: EntitySpec[] = [
  { entity: 'Document',         table: 'documents' },
  { entity: 'FinancialRecord',  table: 'financial_records' },
  { entity: 'WorkPermit',       table: 'work_permits' },
  { entity: 'Visa',             table: 'visas' },
  { entity: 'ComplianceAlert',  table: 'compliance_alerts' },
  { entity: 'Notification',     table: 'notifications' },
];

export interface PerEntityCounts {
  candidateRows: number;
  updatedRows: number;
  skippedAlreadyTenantStamped: number;
  skippedMissingTarget: number;
  skippedTargetWithoutTenant: number;
  beforeNullTenantRows: number;
  afterNullTenantRows: number;
}

export interface BackfillReport {
  mode: 'dry-run' | 'apply';
  applied: boolean;
  safeClassification: string;
  refusalReason?: string;
  totals: {
    candidateRows: number;
    updatedRows: number;
    skippedAlreadyTenantStamped: number;
    skippedMissingTarget: number;
    skippedTargetWithoutTenant: number;
    skippedWrongEntity: number;
    skippedAmbiguous: number;
  };
  byEntity: Record<string, PerEntityCounts>;
}

function getDatabaseUrl(): string {
  const arg = process.argv.find((a) => a.startsWith('--db='))?.slice(5);
  return arg ?? process.env.DATABASE_URL ?? (() => { throw new Error(formatDatabaseUrlMissingMessage()); })();
}

function pgClient(url: string): Client {
  return new Client({
    connectionString: url,
    ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false },
  });
}

async function classifyEntity(c: Client, spec: EntitySpec): Promise<{
  candidate: number;
  already_stamped: number;
  missing_target: number;
  target_without_tenant: number;
  before_null: number;
}> {
  const before = await c.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM audit_logs WHERE entity = $1 AND "tenantId" IS NULL`,
    [spec.entity],
  );

  // Identifier-validated table name (whitelisted by TARGET_ENTITIES).
  const enumQ = await c.query<{ kind: string; n: string }>(
    `WITH t AS (SELECT id, "tenantId" FROM "${spec.table}"),
         classified AS (
           SELECT
             al.id,
             CASE
               WHEN al."tenantId" IS NOT NULL THEN 'already_stamped'
               WHEN t.id IS NULL THEN 'missing_target'
               WHEN t."tenantId" IS NULL THEN 'target_without_tenant'
               ELSE 'candidate'
             END AS kind
           FROM audit_logs al
           LEFT JOIN t ON t.id = al."entityId"
           WHERE al.entity = $1
         )
     SELECT kind, COUNT(*)::text AS n FROM classified GROUP BY kind`,
    [spec.entity],
  );

  const counts: Record<string, number> = {
    candidate: 0, already_stamped: 0, missing_target: 0, target_without_tenant: 0,
  };
  for (const r of enumQ.rows) counts[r.kind] = Number(r.n);

  return {
    candidate: counts.candidate ?? 0,
    already_stamped: counts.already_stamped ?? 0,
    missing_target: counts.missing_target ?? 0,
    target_without_tenant: counts.target_without_tenant ?? 0,
    before_null: Number(before.rows[0].n),
  };
}

async function applyEntity(c: Client, spec: EntitySpec): Promise<number> {
  // phase251-cross-module-audit-backfill: gated by env flag + SAFE classification.
  // Identifier-validated table name (whitelisted in TARGET_ENTITIES).
  const upd = await c.query(
    `UPDATE audit_logs al
     SET "tenantId" = t."tenantId"
     FROM "${spec.table}" t
     WHERE al.entity = $1
       AND al."entityId" = t.id
       AND al."tenantId" IS NULL
       AND t."tenantId" IS NOT NULL`,
    [spec.entity],
  );
  return upd.rowCount ?? 0;
}

export async function runBackfill(databaseUrl: string): Promise<BackfillReport> {
  const env = classifyRuntimeEnv();
  const applyFlag = String(process.env.CROSS_MODULE_AUDIT_BACKFILL_APPLY ?? '').toLowerCase() === 'true';
  const safe = isStagingClassification(env.classification);
  const mode: 'dry-run' | 'apply' = applyFlag && safe ? 'apply' : 'dry-run';
  const refusalReason =
    !applyFlag ? 'CROSS_MODULE_AUDIT_BACKFILL_APPLY=false (default; dry-run)'
    : !safe   ? `unsafe runtime classification ${env.classification} — apply refused`
    : undefined;

  const c = pgClient(databaseUrl);
  await c.connect();
  try {
    const byEntity: Record<string, PerEntityCounts> = {};
    const totals = {
      candidateRows: 0, updatedRows: 0,
      skippedAlreadyTenantStamped: 0, skippedMissingTarget: 0,
      skippedTargetWithoutTenant: 0, skippedWrongEntity: 0, skippedAmbiguous: 0,
    };

    if (mode === 'apply') {
      await c.query('BEGIN');
    }
    try {
      for (const spec of TARGET_ENTITIES) {
        const before = await classifyEntity(c, spec);
        let updated = 0;
        if (mode === 'apply') {
          updated = await applyEntity(c, spec);
        }
        const afterQ = await c.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM audit_logs WHERE entity = $1 AND "tenantId" IS NULL`,
          [spec.entity],
        );
        byEntity[spec.entity] = {
          candidateRows: before.candidate,
          updatedRows: updated,
          skippedAlreadyTenantStamped: before.already_stamped,
          skippedMissingTarget: before.missing_target,
          skippedTargetWithoutTenant: before.target_without_tenant,
          beforeNullTenantRows: before.before_null,
          afterNullTenantRows: Number(afterQ.rows[0].n),
        };
        totals.candidateRows += before.candidate;
        totals.updatedRows += updated;
        totals.skippedAlreadyTenantStamped += before.already_stamped;
        totals.skippedMissingTarget += before.missing_target;
        totals.skippedTargetWithoutTenant += before.target_without_tenant;
      }
      if (mode === 'apply') await c.query('COMMIT');
    } catch (err) {
      if (mode === 'apply') {
        try { await c.query('ROLLBACK'); } catch { /* ignore */ }
      }
      throw err;
    }

    // Wrong-entity / ambiguous buckets are reported as 0 by design — the
    // script never targets entities outside TARGET_ENTITIES, and every
    // target table provides a direct, unambiguous tenantId join.

    return {
      mode,
      applied: mode === 'apply',
      safeClassification: env.classification,
      refusalReason,
      totals,
      byEntity,
    };
  } finally {
    await c.end();
  }
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const report = await runBackfill(url);

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(
    path.join(OUT_DIR, 'cross-module-audit-backfill.json'),
    JSON.stringify(report, null, 2),
  );
  const lines: string[] = [];
  lines.push(`# Phase 2.51 — cross-module audit-log tenant backfill`);
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Mode: **${report.mode}**`);
  lines.push(`Classification: ${report.safeClassification}`);
  if (report.refusalReason) lines.push(`Refusal reason: ${report.refusalReason}`);
  lines.push('');
  lines.push(`## Totals`);
  lines.push('');
  lines.push(`| Field | Value |`);
  lines.push(`|---|---:|`);
  for (const [k, v] of Object.entries(report.totals)) lines.push(`| ${k} | ${v} |`);
  lines.push('');
  lines.push(`## By entity`);
  lines.push('');
  lines.push(`| Entity | candidate | updated | already-stamped | missing-target | target-no-tenant | before-NULL | after-NULL |`);
  lines.push(`|---|---:|---:|---:|---:|---:|---:|---:|`);
  for (const [name, e] of Object.entries(report.byEntity)) {
    lines.push(`| ${name} | ${e.candidateRows} | ${e.updatedRows} | ${e.skippedAlreadyTenantStamped} | ${e.skippedMissingTarget} | ${e.skippedTargetWithoutTenant} | ${e.beforeNullTenantRows} | ${e.afterNullTenantRows} |`);
  }
  lines.push('');
  await fs.writeFile(path.join(OUT_DIR, 'cross-module-audit-backfill.md'), lines.join('\n'));

  console.log(
    `[cross-module-audit-backfill] mode=${report.mode} candidate=${report.totals.candidateRows} ` +
    `updated=${report.totals.updatedRows} entities=${Object.keys(report.byEntity).length}`,
  );
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(2); });
}
