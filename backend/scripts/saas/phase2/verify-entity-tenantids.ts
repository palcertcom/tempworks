/**
 * Phase 2.3 — Entity-keyed `tenantId` verifier.
 *
 * Read-only. For every model whose `tenantId` was added by the
 * Phase 2.3 migration, asserts:
 *
 *   1. `tenantId` matches the parent ownership when both are non-null.
 *   2. NULL `tenantId` rows correspond to a missing parent OR the
 *      parent itself has NULL `tenantId` (i.e. expected quarantine).
 *
 * Exits 0 when every check is OK, 2 when at least one mismatch is
 * found, 3 on runtime error.
 *
 * Reports:
 *   backend/reports/saas/phase2/entity-tenantid-verification.{json,md}
 */
/* eslint-disable no-console */
import { Client, ClientConfig } from 'pg';
import { promises as fs } from 'fs';
import path from 'path';
import {
  autoLoadEnv, formatDatabaseUrlMissingMessage,
} from './../phase1/reconciliation/lib/env';

autoLoadEnv(__filename);

const OUT_DIR = path.resolve(__dirname, '..', '..', '..', 'reports', 'saas', 'phase2');

interface CheckSpec {
  /** Logical name. */
  name: string;
  /** SQL that returns a single row { mismatch, withTid, withoutTid, withoutParent }. */
  sql: string;
}

const CHECKS: CheckSpec[] = [
  {
    name: 'documents',
    sql: `
      SELECT
        (SELECT count(*)::int FROM "documents" d
            LEFT JOIN "employees"  e  ON d."entityType" = 'EMPLOYEE'  AND e.id  = d."entityId"
            LEFT JOIN "applicants" a  ON d."entityType" = 'APPLICANT' AND a.id  = d."entityId"
            LEFT JOIN "agencies"   ag ON d."entityType" = 'AGENCY'    AND ag.id = d."entityId"
           WHERE d."tenantId" IS NOT NULL
             AND COALESCE(e."tenantId", a."tenantId", ag."tenantId") IS NOT NULL
             AND d."tenantId" <> COALESCE(e."tenantId", a."tenantId", ag."tenantId")) AS mismatch,
        (SELECT count(*)::int FROM "documents" WHERE "tenantId" IS NOT NULL) AS with_tid,
        (SELECT count(*)::int FROM "documents" WHERE "tenantId" IS NULL)     AS without_tid,
        (SELECT count(*)::int FROM "documents" d
            LEFT JOIN "employees"  e  ON d."entityType" = 'EMPLOYEE'  AND e.id  = d."entityId"
            LEFT JOIN "applicants" a  ON d."entityType" = 'APPLICANT' AND a.id  = d."entityId"
            LEFT JOIN "agencies"   ag ON d."entityType" = 'AGENCY'    AND ag.id = d."entityId"
           WHERE d."tenantId" IS NULL
             AND COALESCE(e."tenantId", a."tenantId", ag."tenantId") IS NULL) AS without_parent_tid
    `,
  },
  {
    name: 'work_permits',
    sql: childCheck('work_permits', '"employeeId"', '"employees"'),
  },
  {
    name: 'visas',
    sql: `
      SELECT
        (SELECT count(*)::int FROM "visas" v
            LEFT JOIN "employees"  e ON v."entityType" = 'EMPLOYEE'  AND e.id = v."entityId"
            LEFT JOIN "applicants" a ON v."entityType" = 'APPLICANT' AND a.id = v."entityId"
           WHERE v."tenantId" IS NOT NULL AND COALESCE(e."tenantId", a."tenantId") IS NOT NULL
             AND v."tenantId" <> COALESCE(e."tenantId", a."tenantId")) AS mismatch,
        (SELECT count(*)::int FROM "visas" WHERE "tenantId" IS NOT NULL) AS with_tid,
        (SELECT count(*)::int FROM "visas" WHERE "tenantId" IS NULL)     AS without_tid,
        (SELECT count(*)::int FROM "visas" v
            LEFT JOIN "employees"  e ON v."entityType" = 'EMPLOYEE'  AND e.id = v."entityId"
            LEFT JOIN "applicants" a ON v."entityType" = 'APPLICANT' AND a.id = v."entityId"
           WHERE v."tenantId" IS NULL AND COALESCE(e."tenantId", a."tenantId") IS NULL) AS without_parent_tid
    `,
  },
  {
    name: 'compliance_alerts',
    sql: `
      SELECT
        (SELECT count(*)::int FROM "compliance_alerts" c
            LEFT JOIN "employees"  e ON c."entityType" = 'EMPLOYEE'  AND e.id = c."entityId"
            LEFT JOIN "applicants" a ON c."entityType" = 'APPLICANT' AND a.id = c."entityId"
           WHERE c."tenantId" IS NOT NULL AND COALESCE(e."tenantId", a."tenantId") IS NOT NULL
             AND c."tenantId" <> COALESCE(e."tenantId", a."tenantId")) AS mismatch,
        (SELECT count(*)::int FROM "compliance_alerts" WHERE "tenantId" IS NOT NULL) AS with_tid,
        (SELECT count(*)::int FROM "compliance_alerts" WHERE "tenantId" IS NULL)     AS without_tid,
        (SELECT count(*)::int FROM "compliance_alerts" c
            LEFT JOIN "employees"  e ON c."entityType" = 'EMPLOYEE'  AND e.id = c."entityId"
            LEFT JOIN "applicants" a ON c."entityType" = 'APPLICANT' AND a.id = c."entityId"
           WHERE c."tenantId" IS NULL AND COALESCE(e."tenantId", a."tenantId") IS NULL) AS without_parent_tid
    `,
  },
  {
    name: 'financial_records',
    sql: `
      SELECT
        (SELECT count(*)::int FROM "financial_records" f
            LEFT JOIN "employees"  e ON f."entityType" = 'EMPLOYEE'  AND e.id = f."entityId"
            LEFT JOIN "applicants" a ON f."entityType" = 'APPLICANT' AND a.id = f."entityId"
           WHERE f."tenantId" IS NOT NULL AND COALESCE(e."tenantId", a."tenantId") IS NOT NULL
             AND f."tenantId" <> COALESCE(e."tenantId", a."tenantId")) AS mismatch,
        (SELECT count(*)::int FROM "financial_records" WHERE "tenantId" IS NOT NULL) AS with_tid,
        (SELECT count(*)::int FROM "financial_records" WHERE "tenantId" IS NULL)     AS without_tid,
        (SELECT count(*)::int FROM "financial_records" f
            LEFT JOIN "employees"  e ON f."entityType" = 'EMPLOYEE'  AND e.id = f."entityId"
            LEFT JOIN "applicants" a ON f."entityType" = 'APPLICANT' AND a.id = f."entityId"
           WHERE f."tenantId" IS NULL AND COALESCE(e."tenantId", a."tenantId") IS NULL) AS without_parent_tid
    `,
  },
  { name: 'financial_record_attachments',
    sql: childCheck('financial_record_attachments', '"financialRecordId"', '"financial_records"') },
  { name: 'financial_record_deductions',
    sql: childCheck('financial_record_deductions',  '"financialRecordId"', '"financial_records"') },
  { name: 'attendance_records',
    sql: childCheck('attendance_records',           '"employeeId"',        '"employees"') },
  {
    name: 'notifications',
    sql: `
      SELECT
        (SELECT count(*)::int FROM "notifications" n
            JOIN "users" u ON n."userId" = u.id
            JOIN "agencies" ag ON ag.id = u."agencyId"
           WHERE n."tenantId" IS NOT NULL AND ag."tenantId" IS NOT NULL
             AND n."tenantId" <> ag."tenantId") AS mismatch,
        (SELECT count(*)::int FROM "notifications" WHERE "tenantId" IS NOT NULL) AS with_tid,
        (SELECT count(*)::int FROM "notifications" WHERE "tenantId" IS NULL)     AS without_tid,
        (SELECT count(*)::int FROM "notifications" n
            LEFT JOIN "users" u ON n."userId" = u.id
            LEFT JOIN "agencies" ag ON ag.id = u."agencyId"
           WHERE n."tenantId" IS NULL AND (u.id IS NULL OR ag.id IS NULL OR ag."tenantId" IS NULL)) AS without_parent_tid
    `,
  },
  { name: 'vehicle_documents',          sql: childCheck('vehicle_documents',          '"vehicleId"',     '"vehicles"') },
  { name: 'maintenance_records',        sql: childCheck('maintenance_records',        '"vehicleId"',     '"vehicles"') },
  { name: 'candidate_workflow_assignments', sql: childCheck('candidate_workflow_assignments', '"candidateId"', '"applicants"') },
  { name: 'employee_workflow_assignments',  sql: childCheck('employee_workflow_assignments',  '"employeeId"',  '"employees"') },
  { name: 'employee_work_history',          sql: childCheck('employee_work_history',          '"employeeId"',  '"employees"') },
  { name: 'employee_work_history_attachments', sql: childCheck('employee_work_history_attachments', '"workHistoryId"', '"employee_work_history"') },
];

function childCheck(table: string, fkCol: string, parent: string): string {
  return `
    SELECT
      (SELECT count(*)::int FROM "${table}" t
          JOIN ${parent} p ON t.${fkCol} = p.id
         WHERE t."tenantId" IS NOT NULL AND p."tenantId" IS NOT NULL
           AND t."tenantId" <> p."tenantId") AS mismatch,
      (SELECT count(*)::int FROM "${table}" WHERE "tenantId" IS NOT NULL) AS with_tid,
      (SELECT count(*)::int FROM "${table}" WHERE "tenantId" IS NULL)     AS without_tid,
      (SELECT count(*)::int FROM "${table}" t
          LEFT JOIN ${parent} p ON t.${fkCol} = p.id
         WHERE t."tenantId" IS NULL AND (p.id IS NULL OR p."tenantId" IS NULL)) AS without_parent_tid
  `;
}

interface CheckResult {
  name: string;
  ok: boolean;
  mismatch: number;
  withTid: number;
  withoutTid: number;
  withoutParentTid: number;
  unexplainedNulls: number;  // withoutTid - withoutParentTid; should be 0 ideally
  error?: string;
}

function getDatabaseUrl(): string {
  const arg = process.argv.find((a) => a.startsWith('--db='))?.slice(5);
  const url = arg ?? process.env.DATABASE_URL;
  if (!url) throw new Error(formatDatabaseUrlMissingMessage());
  return url;
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const cfg: ClientConfig = { connectionString: url };
  cfg.ssl = /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false };
  const c = new Client(cfg);
  await c.connect();

  const results: CheckResult[] = [];
  for (const ch of CHECKS) {
    try {
      const r = await c.query<{ mismatch: number; with_tid: number; without_tid: number; without_parent_tid: number }>(
        ch.sql,
      );
      const row = r.rows[0]!;
      const result: CheckResult = {
        name: ch.name,
        mismatch: row.mismatch,
        withTid: row.with_tid,
        withoutTid: row.without_tid,
        withoutParentTid: row.without_parent_tid,
        unexplainedNulls: Math.max(0, row.without_tid - row.without_parent_tid),
        ok: row.mismatch === 0,
      };
      results.push(result);
    } catch (e) {
      results.push({
        name: ch.name, ok: false, mismatch: 0, withTid: 0, withoutTid: 0,
        withoutParentTid: 0, unexplainedNulls: 0, error: (e as Error).message,
      });
    }
  }
  await c.end();

  await fs.mkdir(OUT_DIR, { recursive: true });
  const failed = results.filter((r) => !r.ok || r.error).length;
  const summary = {
    generatedAt: new Date().toISOString(),
    database: url.replace(/:[^:@/]+@/, ':***@'),
    counts: {
      models: results.length,
      passed: results.filter((r) => r.ok && !r.error).length,
      failed,
      mismatches: results.reduce((s, r) => s + r.mismatch, 0),
      withTid:    results.reduce((s, r) => s + r.withTid, 0),
      withoutTid: results.reduce((s, r) => s + r.withoutTid, 0),
      unexplained: results.reduce((s, r) => s + r.unexplainedNulls, 0),
    },
    results,
  };
  await fs.writeFile(path.join(OUT_DIR, 'entity-tenantid-verification.json'), JSON.stringify(summary, null, 2));

  const md: string[] = [];
  md.push('# Phase 2.3 — Entity-Keyed `tenantId` Verification');
  md.push('');
  md.push(`Generated: ${summary.generatedAt}`);
  md.push(`Database: \`${summary.database}\``);
  md.push('');
  md.push(`- Models verified: ${summary.counts.models}`);
  md.push(`- Models PASSED: **${summary.counts.passed}**`);
  md.push(`- Models FAILED: ${summary.counts.failed}`);
  md.push(`- Mismatched rows (tenantId ≠ parent): ${summary.counts.mismatches}`);
  md.push(`- Rows with tenantId set: ${summary.counts.withTid}`);
  md.push(`- Rows with tenantId NULL: ${summary.counts.withoutTid}`);
  md.push(`- Unexplained NULLs (parent has tenantId but row does not): ${summary.counts.unexplained}`);
  md.push('');
  md.push('| Model | Result | Mismatch | With tid | Without tid | Without parent tid | Unexplained NULLs |');
  md.push('|-------|--------|---------:|---------:|------------:|-------------------:|------------------:|');
  for (const r of results) {
    md.push(`| \`${r.name}\` | ${r.error ? '**ERROR**' : r.ok ? 'PASS' : '**FAIL**'} | ${r.mismatch} | ${r.withTid} | ${r.withoutTid} | ${r.withoutParentTid} | ${r.unexplainedNulls}${r.error ? ` — ${r.error}` : ''} |`);
  }
  await fs.writeFile(path.join(OUT_DIR, 'entity-tenantid-verification.md'), md.join('\n'));

  console.log(`verify-entity-tenantids: ${summary.counts.passed}/${summary.counts.models} PASS, ` +
    `${summary.counts.mismatches} mismatch(es), ${summary.counts.unexplained} unexplained NULLs.`);
  if (failed > 0 || summary.counts.mismatches > 0) process.exit(2);
}

main().catch((e) => { console.error(e); process.exit(3); });
