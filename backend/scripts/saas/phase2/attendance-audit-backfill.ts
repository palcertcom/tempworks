/**
 * Phase 2.50 — Historic Attendance audit-log tenant backfill.
 *
 * Default-OFF, dry-run by default. The single UPDATE matches:
 *   - audit_logs.entity   = 'AttendanceRecord'
 *   - audit_logs.tenantId IS NULL
 *   - attendance_records.id = audit_logs.entityId
 *   - attendance_records.tenantId IS NOT NULL
 *
 * Apply requires BOTH:
 *   ATTENDANCE_AUDIT_BACKFILL_APPLY=true
 *   classifyRuntimeEnv ⇒ SAFE_CLONE or SAFE_STAGING
 *
 * Reports: backend/reports/saas/phase2/attendance-audit-backfill.{json,md}
 *
 * Tag (raw SQL, src/scripts): phase250-attendance-audit-backfill.
 *
 * Usage:
 *   # dry-run (default)
 *   npm run saas:phase250-attendance-audit-backfill
 *
 *   # apply (staging only)
 *   ATTENDANCE_AUDIT_BACKFILL_APPLY=true \
 *     npm run saas:phase250-attendance-audit-backfill
 */
/* eslint-disable no-console */
import { promises as fs } from 'fs';
import path from 'path';
import { Client } from 'pg';
import { autoLoadEnv, formatDatabaseUrlMissingMessage } from './../phase1/reconciliation/lib/env';
import { classifyRuntimeEnv, isStagingClassification } from '../../../src/saas/tenancy/env-safety';

autoLoadEnv(__filename);

const OUT_DIR = path.resolve(__dirname, '..', '..', '..', 'reports', 'saas', 'phase2');

export interface BackfillReport {
  mode: 'dry-run' | 'apply';
  candidateRows: number;
  updatedRows: number;
  skippedAlreadyTenantStamped: number;
  skippedMissingAttendanceRecord: number;
  skippedAttendanceWithoutTenant: number;
  skippedWrongEntity: number;
  beforeNullTenantAttendanceAuditRows: number;
  afterNullTenantAttendanceAuditRows: number;
  safeClassification: string;
  applied: boolean;
  refusalReason?: string;
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

export async function runBackfill(databaseUrl: string): Promise<BackfillReport> {
  const env = classifyRuntimeEnv();
  const applyFlag = String(process.env.ATTENDANCE_AUDIT_BACKFILL_APPLY ?? '').toLowerCase() === 'true';
  const safe = isStagingClassification(env.classification);
  const mode: 'dry-run' | 'apply' = applyFlag && safe ? 'apply' : 'dry-run';
  const refusalReason =
    !applyFlag ? 'ATTENDANCE_AUDIT_BACKFILL_APPLY=false (default; dry-run)'
    : !safe   ? `unsafe runtime classification ${env.classification} — apply refused`
    : undefined;

  const c = pgClient(databaseUrl);
  await c.connect();
  try {
    const before = await c.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM audit_logs WHERE entity='AttendanceRecord' AND "tenantId" IS NULL`);

    // Enumerate candidate audit rows and classify them.
    const enumQ = await c.query<{
      kind: string;
      n: string;
    }>(`
      WITH attn AS (
        SELECT id, "tenantId" FROM attendance_records
      ),
      classified AS (
        SELECT
          al.id,
          CASE
            WHEN al.entity <> 'AttendanceRecord' THEN 'wrong_entity'
            WHEN al."tenantId" IS NOT NULL THEN 'already_stamped'
            WHEN attn.id IS NULL THEN 'missing_record'
            WHEN attn."tenantId" IS NULL THEN 'record_without_tenant'
            ELSE 'candidate'
          END AS kind
        FROM audit_logs al
        LEFT JOIN attn ON attn.id = al."entityId"
        WHERE al.entity = 'AttendanceRecord'
      )
      SELECT kind, COUNT(*)::text AS n FROM classified GROUP BY kind`);

    const counts: Record<string, number> = {
      candidate: 0, already_stamped: 0, missing_record: 0,
      record_without_tenant: 0, wrong_entity: 0,
    };
    for (const r of enumQ.rows) counts[r.kind] = Number(r.n);

    let updatedRows = 0;
    let applied = false;
    if (mode === 'apply') {
      // Single, narrow, parameter-free UPDATE.
      // phase250-attendance-audit-backfill: gated by env flag + SAFE classification above.
      const upd = await c.query(`
        UPDATE audit_logs al
        SET "tenantId" = ar."tenantId"
        FROM attendance_records ar
        WHERE al.entity = 'AttendanceRecord'
          AND al."entityId" = ar.id
          AND al."tenantId" IS NULL
          AND ar."tenantId" IS NOT NULL
      `);
      updatedRows = upd.rowCount ?? 0;
      applied = true;
    }

    const after = await c.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM audit_logs WHERE entity='AttendanceRecord' AND "tenantId" IS NULL`);

    return {
      mode,
      candidateRows: counts.candidate ?? 0,
      updatedRows,
      skippedAlreadyTenantStamped: counts.already_stamped ?? 0,
      skippedMissingAttendanceRecord: counts.missing_record ?? 0,
      skippedAttendanceWithoutTenant: counts.record_without_tenant ?? 0,
      skippedWrongEntity: counts.wrong_entity ?? 0,
      beforeNullTenantAttendanceAuditRows: Number(before.rows[0].n),
      afterNullTenantAttendanceAuditRows: Number(after.rows[0].n),
      safeClassification: env.classification,
      applied,
      refusalReason,
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
    path.join(OUT_DIR, 'attendance-audit-backfill.json'),
    JSON.stringify(report, null, 2),
  );
  const md = [
    `# Phase 2.50 — attendance audit-log tenant backfill`, ``,
    `Generated: ${new Date().toISOString()}`,
    `Mode: **${report.mode}**`,
    `Classification: ${report.safeClassification}`,
    report.refusalReason ? `Refusal reason: ${report.refusalReason}` : `Apply executed.`,
    ``,
    `| Field | Value |`,
    `|---|---:|`,
    `| candidateRows | ${report.candidateRows} |`,
    `| updatedRows | ${report.updatedRows} |`,
    `| skippedAlreadyTenantStamped | ${report.skippedAlreadyTenantStamped} |`,
    `| skippedMissingAttendanceRecord | ${report.skippedMissingAttendanceRecord} |`,
    `| skippedAttendanceWithoutTenant | ${report.skippedAttendanceWithoutTenant} |`,
    `| skippedWrongEntity | ${report.skippedWrongEntity} |`,
    `| beforeNullTenantAttendanceAuditRows | ${report.beforeNullTenantAttendanceAuditRows} |`,
    `| afterNullTenantAttendanceAuditRows | ${report.afterNullTenantAttendanceAuditRows} |`,
    `| applied | ${report.applied} |`,
    ``,
  ].join('\n');
  await fs.writeFile(path.join(OUT_DIR, 'attendance-audit-backfill.md'), md);

  console.log(
    `[attendance-audit-backfill] mode=${report.mode} candidate=${report.candidateRows} ` +
    `updated=${report.updatedRows} before=${report.beforeNullTenantAttendanceAuditRows} ` +
    `after=${report.afterNullTenantAttendanceAuditRows}`,
  );
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(2); });
}
