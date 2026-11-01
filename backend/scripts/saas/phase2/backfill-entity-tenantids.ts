/**
 * Phase 2.3 — Entity-keyed `tenantId` backfill.
 *
 * For every model whose `tenantId` was added by
 * `prisma/migrations/saas_phase2_tenantid_denorm/migration.sql`, derive
 * the value from the parent ownership path and write it. Rows whose
 * parent is missing or whose parent itself has NULL `tenantId` are
 * **quarantined** — written to `saas_reconciliation_queue` with a
 * deterministic kind/subject so ops can triage.
 *
 * Modes:
 *   --dry-run            (default)  read-only; counts what WOULD be written
 *   --apply              (staging-only) write tenantId into the rows
 *   --model <name>       run a single model
 *   --limit <N>          process at most N rows per model (per run)
 *   --fail-on-quarantine exit 2 when any row was quarantined
 *
 * Usage on a SAFE_CLONE staging fixture:
 *   ALLOW_SAAS_STAGING_MUTATION=true \
 *     npm run saas:phase2-backfill-entity-tenantids -- --apply --limit 5000
 *
 * Output:
 *   backend/reports/saas/phase2/entity-tenantid-backfill.{json,md}
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
const STAGING_HOST_RES = [/^127\.0\.0\.1$/, /^localhost$/, /^staging[-.]/, /^stg[-.]/, /\.staging\./, /\.stg\./, /^postgres-staging-/];
const PROD_HOST_RES    = [/^prod[-.]/, /\.prod\./, /^postgres-prod-/, /\.production\./];
const PROD_DB_RES      = [/^prod$/i, /^production$/i, /_prod$/i, /^tempworks_prod/i];

interface ModelSpec {
  /** Logical name shown in CLI / report. */
  name: string;
  /** Backfill SQL. Must:
   *   - return rows with `id` and `tenantId` to set
   *   - never modify a row whose tenantId is already non-null
   *   - support the limit clause appended at the end. */
  buildBackfillSql: (apply: boolean, limit: number | null) => string;
  /** Build the quarantine-detection SQL — ROWS whose parent path
   *  cannot resolve to a tenantId. Returns a count and a small sample
   *  of ids. */
  buildQuarantineSql: () => string;
  /** Optional: extra context for logs/reports. */
  parentPath: string;
}

const MODELS: ModelSpec[] = [
  // ─── documents — entity-keyed via entityType + entityId ─────────────────
  // Resolves through Employee, Applicant, Agency, User. We only join the
  // first three because user-level docs (rare) are scoped via the user's
  // agency, which the legacy code already populates. Backfill only if a
  // single deterministic parent exists.
  {
    name: 'documents',
    parentPath: 'documents.entityId → employees|applicants|agencies → tenantId',
    buildBackfillSql: (apply, limit) => apply
      ? `UPDATE "documents" d
            SET "tenantId" = COALESCE(e."tenantId", a."tenantId", ag."tenantId")
           FROM "documents" d2
           LEFT JOIN "employees"  e  ON d2."entityType" = 'EMPLOYEE'  AND e.id  = d2."entityId"
           LEFT JOIN "applicants" a  ON d2."entityType" = 'APPLICANT' AND a.id  = d2."entityId"
           LEFT JOIN "agencies"   ag ON d2."entityType" = 'AGENCY'    AND ag.id = d2."entityId"
          WHERE d.id = d2.id
            AND d."tenantId" IS NULL
            AND COALESCE(e."tenantId", a."tenantId", ag."tenantId") IS NOT NULL
            ${limit ? `AND d.id IN (SELECT id FROM "documents" WHERE "tenantId" IS NULL LIMIT ${limit})` : ''}`
      : `SELECT count(*)::int AS n
           FROM "documents" d
           LEFT JOIN "employees"  e  ON d."entityType" = 'EMPLOYEE'  AND e.id  = d."entityId"
           LEFT JOIN "applicants" a  ON d."entityType" = 'APPLICANT' AND a.id  = d."entityId"
           LEFT JOIN "agencies"   ag ON d."entityType" = 'AGENCY'    AND ag.id = d."entityId"
          WHERE d."tenantId" IS NULL
            AND COALESCE(e."tenantId", a."tenantId", ag."tenantId") IS NOT NULL`,
    buildQuarantineSql: () => `
      SELECT count(*)::int AS n,
             COALESCE(array_agg(d.id::text ORDER BY d.id) FILTER (WHERE d.id IS NOT NULL), '{}')::text[] AS sample
        FROM (
          SELECT d.id
            FROM "documents" d
            LEFT JOIN "employees"  e  ON d."entityType" = 'EMPLOYEE'  AND e.id  = d."entityId"
            LEFT JOIN "applicants" a  ON d."entityType" = 'APPLICANT' AND a.id  = d."entityId"
            LEFT JOIN "agencies"   ag ON d."entityType" = 'AGENCY'    AND ag.id = d."entityId"
           WHERE d."tenantId" IS NULL
             AND COALESCE(e."tenantId", a."tenantId", ag."tenantId") IS NULL
           LIMIT 50
        ) d
    `,
  },

  // ─── work_permits — via Employee.tenantId ────────────────────────────
  {
    name: 'work_permits',
    parentPath: 'work_permits.employeeId → employees.tenantId',
    buildBackfillSql: (apply, limit) => apply
      ? `UPDATE "work_permits" wp SET "tenantId" = e."tenantId"
           FROM "employees" e
          WHERE wp."employeeId" = e.id AND wp."tenantId" IS NULL AND e."tenantId" IS NOT NULL
          ${limit ? `AND wp.id IN (SELECT id FROM "work_permits" WHERE "tenantId" IS NULL LIMIT ${limit})` : ''}`
      : `SELECT count(*)::int AS n FROM "work_permits" wp JOIN "employees" e ON wp."employeeId" = e.id
           WHERE wp."tenantId" IS NULL AND e."tenantId" IS NOT NULL`,
    buildQuarantineSql: () => `
      SELECT count(*)::int AS n,
             COALESCE(array_agg(id::text ORDER BY id) FILTER (WHERE id IS NOT NULL), '{}')::text[] AS sample
        FROM (
          SELECT wp.id FROM "work_permits" wp
            LEFT JOIN "employees" e ON wp."employeeId" = e.id
           WHERE wp."tenantId" IS NULL AND (e.id IS NULL OR e."tenantId" IS NULL)
           LIMIT 50
        ) x`,
  },

  // ─── visas — entity-keyed (EMPLOYEE | APPLICANT) ─────────────────────
  {
    name: 'visas',
    parentPath: 'visas.entityId → employees|applicants → tenantId',
    buildBackfillSql: (apply, limit) => apply
      ? `UPDATE "visas" v SET "tenantId" = COALESCE(e."tenantId", a."tenantId")
           FROM "visas" v2
           LEFT JOIN "employees"  e ON v2."entityType" = 'EMPLOYEE'  AND e.id = v2."entityId"
           LEFT JOIN "applicants" a ON v2."entityType" = 'APPLICANT' AND a.id = v2."entityId"
          WHERE v.id = v2.id AND v."tenantId" IS NULL
            AND COALESCE(e."tenantId", a."tenantId") IS NOT NULL
          ${limit ? `AND v.id IN (SELECT id FROM "visas" WHERE "tenantId" IS NULL LIMIT ${limit})` : ''}`
      : `SELECT count(*)::int AS n FROM "visas" v
           LEFT JOIN "employees"  e ON v."entityType" = 'EMPLOYEE'  AND e.id = v."entityId"
           LEFT JOIN "applicants" a ON v."entityType" = 'APPLICANT' AND a.id = v."entityId"
           WHERE v."tenantId" IS NULL AND COALESCE(e."tenantId", a."tenantId") IS NOT NULL`,
    buildQuarantineSql: () => `
      SELECT count(*)::int AS n,
             COALESCE(array_agg(id::text ORDER BY id) FILTER (WHERE id IS NOT NULL), '{}')::text[] AS sample
        FROM (
          SELECT v.id FROM "visas" v
            LEFT JOIN "employees"  e ON v."entityType" = 'EMPLOYEE'  AND e.id = v."entityId"
            LEFT JOIN "applicants" a ON v."entityType" = 'APPLICANT' AND a.id = v."entityId"
           WHERE v."tenantId" IS NULL AND COALESCE(e."tenantId", a."tenantId") IS NULL
           LIMIT 50
        ) x`,
  },

  // ─── compliance_alerts — entity-keyed (EMPLOYEE | APPLICANT) ─────────
  {
    name: 'compliance_alerts',
    parentPath: 'compliance_alerts.entityId → employees|applicants → tenantId',
    buildBackfillSql: (apply, limit) => apply
      ? `UPDATE "compliance_alerts" c SET "tenantId" = COALESCE(e."tenantId", a."tenantId")
           FROM "compliance_alerts" c2
           LEFT JOIN "employees"  e ON c2."entityType" = 'EMPLOYEE'  AND e.id = c2."entityId"
           LEFT JOIN "applicants" a ON c2."entityType" = 'APPLICANT' AND a.id = c2."entityId"
          WHERE c.id = c2.id AND c."tenantId" IS NULL
            AND COALESCE(e."tenantId", a."tenantId") IS NOT NULL
          ${limit ? `AND c.id IN (SELECT id FROM "compliance_alerts" WHERE "tenantId" IS NULL LIMIT ${limit})` : ''}`
      : `SELECT count(*)::int AS n FROM "compliance_alerts" c
           LEFT JOIN "employees"  e ON c."entityType" = 'EMPLOYEE'  AND e.id = c."entityId"
           LEFT JOIN "applicants" a ON c."entityType" = 'APPLICANT' AND a.id = c."entityId"
           WHERE c."tenantId" IS NULL AND COALESCE(e."tenantId", a."tenantId") IS NOT NULL`,
    buildQuarantineSql: () => `
      SELECT count(*)::int AS n,
             COALESCE(array_agg(id::text ORDER BY id) FILTER (WHERE id IS NOT NULL), '{}')::text[] AS sample
        FROM (
          SELECT c.id FROM "compliance_alerts" c
            LEFT JOIN "employees"  e ON c."entityType" = 'EMPLOYEE'  AND e.id = c."entityId"
            LEFT JOIN "applicants" a ON c."entityType" = 'APPLICANT' AND a.id = c."entityId"
           WHERE c."tenantId" IS NULL AND COALESCE(e."tenantId", a."tenantId") IS NULL
           LIMIT 50
        ) x`,
  },

  // ─── financial_records — entity-keyed (EMPLOYEE | APPLICANT) ────────
  {
    name: 'financial_records',
    parentPath: 'financial_records.entityId → employees|applicants → tenantId',
    buildBackfillSql: (apply, limit) => apply
      ? `UPDATE "financial_records" f SET "tenantId" = COALESCE(e."tenantId", a."tenantId")
           FROM "financial_records" f2
           LEFT JOIN "employees"  e ON f2."entityType" = 'EMPLOYEE'  AND e.id = f2."entityId"
           LEFT JOIN "applicants" a ON f2."entityType" = 'APPLICANT' AND a.id = f2."entityId"
          WHERE f.id = f2.id AND f."tenantId" IS NULL
            AND COALESCE(e."tenantId", a."tenantId") IS NOT NULL
          ${limit ? `AND f.id IN (SELECT id FROM "financial_records" WHERE "tenantId" IS NULL LIMIT ${limit})` : ''}`
      : `SELECT count(*)::int AS n FROM "financial_records" f
           LEFT JOIN "employees"  e ON f."entityType" = 'EMPLOYEE'  AND e.id = f."entityId"
           LEFT JOIN "applicants" a ON f."entityType" = 'APPLICANT' AND a.id = f."entityId"
           WHERE f."tenantId" IS NULL AND COALESCE(e."tenantId", a."tenantId") IS NOT NULL`,
    buildQuarantineSql: () => `
      SELECT count(*)::int AS n,
             COALESCE(array_agg(id::text ORDER BY id) FILTER (WHERE id IS NOT NULL), '{}')::text[] AS sample
        FROM (
          SELECT f.id FROM "financial_records" f
            LEFT JOIN "employees"  e ON f."entityType" = 'EMPLOYEE'  AND e.id = f."entityId"
            LEFT JOIN "applicants" a ON f."entityType" = 'APPLICANT' AND a.id = f."entityId"
           WHERE f."tenantId" IS NULL AND COALESCE(e."tenantId", a."tenantId") IS NULL
           LIMIT 50
        ) x`,
  },

  // ─── child tables (financial_record_attachments, _deductions) ───────
  {
    name: 'financial_record_attachments',
    parentPath: 'financial_record_attachments.financialRecordId → financial_records.tenantId',
    buildBackfillSql: (apply, limit) => apply
      ? `UPDATE "financial_record_attachments" t SET "tenantId" = f."tenantId"
           FROM "financial_records" f
          WHERE t."financialRecordId" = f.id AND t."tenantId" IS NULL AND f."tenantId" IS NOT NULL
          ${limit ? `AND t.id IN (SELECT id FROM "financial_record_attachments" WHERE "tenantId" IS NULL LIMIT ${limit})` : ''}`
      : `SELECT count(*)::int AS n FROM "financial_record_attachments" t
           JOIN "financial_records" f ON t."financialRecordId" = f.id
          WHERE t."tenantId" IS NULL AND f."tenantId" IS NOT NULL`,
    buildQuarantineSql: () => `
      SELECT count(*)::int AS n,
             COALESCE(array_agg(t.id::text ORDER BY t.id) FILTER (WHERE t.id IS NOT NULL), '{}')::text[] AS sample
        FROM "financial_record_attachments" t
        LEFT JOIN "financial_records" f ON t."financialRecordId" = f.id
       WHERE t."tenantId" IS NULL AND (f.id IS NULL OR f."tenantId" IS NULL)
       LIMIT 50`,
  },
  {
    name: 'financial_record_deductions',
    parentPath: 'financial_record_deductions.financialRecordId → financial_records.tenantId',
    buildBackfillSql: (apply, limit) => apply
      ? `UPDATE "financial_record_deductions" t SET "tenantId" = f."tenantId"
           FROM "financial_records" f
          WHERE t."financialRecordId" = f.id AND t."tenantId" IS NULL AND f."tenantId" IS NOT NULL
          ${limit ? `AND t.id IN (SELECT id FROM "financial_record_deductions" WHERE "tenantId" IS NULL LIMIT ${limit})` : ''}`
      : `SELECT count(*)::int AS n FROM "financial_record_deductions" t
           JOIN "financial_records" f ON t."financialRecordId" = f.id
          WHERE t."tenantId" IS NULL AND f."tenantId" IS NOT NULL`,
    buildQuarantineSql: () => `
      SELECT count(*)::int AS n,
             COALESCE(array_agg(t.id::text ORDER BY t.id) FILTER (WHERE t.id IS NOT NULL), '{}')::text[] AS sample
        FROM "financial_record_deductions" t
        LEFT JOIN "financial_records" f ON t."financialRecordId" = f.id
       WHERE t."tenantId" IS NULL AND (f.id IS NULL OR f."tenantId" IS NULL)
       LIMIT 50`,
  },

  // ─── attendance_records — via employee.tenantId ─────────────────────
  {
    name: 'attendance_records',
    parentPath: 'attendance_records.employeeId → employees.tenantId',
    buildBackfillSql: (apply, limit) => apply
      ? `UPDATE "attendance_records" t SET "tenantId" = e."tenantId"
           FROM "employees" e
          WHERE t."employeeId" = e.id AND t."tenantId" IS NULL AND e."tenantId" IS NOT NULL
          ${limit ? `AND t.id IN (SELECT id FROM "attendance_records" WHERE "tenantId" IS NULL LIMIT ${limit})` : ''}`
      : `SELECT count(*)::int AS n FROM "attendance_records" t
           JOIN "employees" e ON t."employeeId" = e.id
          WHERE t."tenantId" IS NULL AND e."tenantId" IS NOT NULL`,
    buildQuarantineSql: () => `
      SELECT count(*)::int AS n,
             COALESCE(array_agg(t.id::text ORDER BY t.id) FILTER (WHERE t.id IS NOT NULL), '{}')::text[] AS sample
        FROM "attendance_records" t
        LEFT JOIN "employees" e ON t."employeeId" = e.id
       WHERE t."tenantId" IS NULL AND (e.id IS NULL OR e."tenantId" IS NULL)
       LIMIT 50`,
  },

  // ─── notifications — via user.agencyId → agencies.tenantId ──────────
  {
    name: 'notifications',
    parentPath: 'notifications.userId → users.agencyId → agencies.tenantId',
    buildBackfillSql: (apply, limit) => apply
      ? `UPDATE "notifications" n SET "tenantId" = ag."tenantId"
           FROM "users" u JOIN "agencies" ag ON ag.id = u."agencyId"
          WHERE n."userId" = u.id AND n."tenantId" IS NULL AND ag."tenantId" IS NOT NULL
          ${limit ? `AND n.id IN (SELECT id FROM "notifications" WHERE "tenantId" IS NULL LIMIT ${limit})` : ''}`
      : `SELECT count(*)::int AS n FROM "notifications" n
           JOIN "users" u ON n."userId" = u.id
           JOIN "agencies" ag ON ag.id = u."agencyId"
          WHERE n."tenantId" IS NULL AND ag."tenantId" IS NOT NULL`,
    buildQuarantineSql: () => `
      SELECT count(*)::int AS n,
             COALESCE(array_agg(n.id::text ORDER BY n.id) FILTER (WHERE n.id IS NOT NULL), '{}')::text[] AS sample
        FROM "notifications" n
        LEFT JOIN "users" u ON n."userId" = u.id
        LEFT JOIN "agencies" ag ON ag.id = u."agencyId"
       WHERE n."tenantId" IS NULL AND (u.id IS NULL OR ag.id IS NULL OR ag."tenantId" IS NULL)
       LIMIT 50`,
  },

  // ─── vehicle_documents — via vehicles.tenantId ──────────────────────
  {
    name: 'vehicle_documents',
    parentPath: 'vehicle_documents.vehicleId → vehicles.tenantId',
    buildBackfillSql: (apply, limit) => apply
      ? `UPDATE "vehicle_documents" t SET "tenantId" = v."tenantId"
           FROM "vehicles" v
          WHERE t."vehicleId" = v.id AND t."tenantId" IS NULL AND v."tenantId" IS NOT NULL
          ${limit ? `AND t.id IN (SELECT id FROM "vehicle_documents" WHERE "tenantId" IS NULL LIMIT ${limit})` : ''}`
      : `SELECT count(*)::int AS n FROM "vehicle_documents" t
           JOIN "vehicles" v ON t."vehicleId" = v.id
          WHERE t."tenantId" IS NULL AND v."tenantId" IS NOT NULL`,
    buildQuarantineSql: () => `
      SELECT count(*)::int AS n,
             COALESCE(array_agg(t.id::text ORDER BY t.id) FILTER (WHERE t.id IS NOT NULL), '{}')::text[] AS sample
        FROM "vehicle_documents" t
        LEFT JOIN "vehicles" v ON t."vehicleId" = v.id
       WHERE t."tenantId" IS NULL AND (v.id IS NULL OR v."tenantId" IS NULL)
       LIMIT 50`,
  },

  // ─── maintenance_records — via vehicles.tenantId ─────────────────────
  {
    name: 'maintenance_records',
    parentPath: 'maintenance_records.vehicleId → vehicles.tenantId',
    buildBackfillSql: (apply, limit) => apply
      ? `UPDATE "maintenance_records" t SET "tenantId" = v."tenantId"
           FROM "vehicles" v
          WHERE t."vehicleId" = v.id AND t."tenantId" IS NULL AND v."tenantId" IS NOT NULL
          ${limit ? `AND t.id IN (SELECT id FROM "maintenance_records" WHERE "tenantId" IS NULL LIMIT ${limit})` : ''}`
      : `SELECT count(*)::int AS n FROM "maintenance_records" t
           JOIN "vehicles" v ON t."vehicleId" = v.id
          WHERE t."tenantId" IS NULL AND v."tenantId" IS NOT NULL`,
    buildQuarantineSql: () => `
      SELECT count(*)::int AS n,
             COALESCE(array_agg(t.id::text ORDER BY t.id) FILTER (WHERE t.id IS NOT NULL), '{}')::text[] AS sample
        FROM "maintenance_records" t
        LEFT JOIN "vehicles" v ON t."vehicleId" = v.id
       WHERE t."tenantId" IS NULL AND (v.id IS NULL OR v."tenantId" IS NULL)
       LIMIT 50`,
  },

  // ─── workflow assignments ───────────────────────────────────────────
  {
    name: 'candidate_workflow_assignments',
    parentPath: 'candidate_workflow_assignments.candidateId → applicants.tenantId',
    buildBackfillSql: (apply, limit) => apply
      ? `UPDATE "candidate_workflow_assignments" t SET "tenantId" = a."tenantId"
           FROM "applicants" a
          WHERE t."candidateId" = a.id AND t."tenantId" IS NULL AND a."tenantId" IS NOT NULL
          ${limit ? `AND t.id IN (SELECT id FROM "candidate_workflow_assignments" WHERE "tenantId" IS NULL LIMIT ${limit})` : ''}`
      : `SELECT count(*)::int AS n FROM "candidate_workflow_assignments" t
           JOIN "applicants" a ON t."candidateId" = a.id
          WHERE t."tenantId" IS NULL AND a."tenantId" IS NOT NULL`,
    buildQuarantineSql: () => `
      SELECT count(*)::int AS n,
             COALESCE(array_agg(t.id::text ORDER BY t.id) FILTER (WHERE t.id IS NOT NULL), '{}')::text[] AS sample
        FROM "candidate_workflow_assignments" t
        LEFT JOIN "applicants" a ON t."candidateId" = a.id
       WHERE t."tenantId" IS NULL AND (a.id IS NULL OR a."tenantId" IS NULL)
       LIMIT 50`,
  },
  {
    name: 'employee_workflow_assignments',
    parentPath: 'employee_workflow_assignments.employeeId → employees.tenantId',
    buildBackfillSql: (apply, limit) => apply
      ? `UPDATE "employee_workflow_assignments" t SET "tenantId" = e."tenantId"
           FROM "employees" e
          WHERE t."employeeId" = e.id AND t."tenantId" IS NULL AND e."tenantId" IS NOT NULL
          ${limit ? `AND t.id IN (SELECT id FROM "employee_workflow_assignments" WHERE "tenantId" IS NULL LIMIT ${limit})` : ''}`
      : `SELECT count(*)::int AS n FROM "employee_workflow_assignments" t
           JOIN "employees" e ON t."employeeId" = e.id
          WHERE t."tenantId" IS NULL AND e."tenantId" IS NOT NULL`,
    buildQuarantineSql: () => `
      SELECT count(*)::int AS n,
             COALESCE(array_agg(t.id::text ORDER BY t.id) FILTER (WHERE t.id IS NOT NULL), '{}')::text[] AS sample
        FROM "employee_workflow_assignments" t
        LEFT JOIN "employees" e ON t."employeeId" = e.id
       WHERE t."tenantId" IS NULL AND (e.id IS NULL OR e."tenantId" IS NULL)
       LIMIT 50`,
  },

  // ─── employee_work_history ──────────────────────────────────────────
  {
    name: 'employee_work_history',
    parentPath: 'employee_work_history.employeeId → employees.tenantId',
    buildBackfillSql: (apply, limit) => apply
      ? `UPDATE "employee_work_history" t SET "tenantId" = e."tenantId"
           FROM "employees" e
          WHERE t."employeeId" = e.id AND t."tenantId" IS NULL AND e."tenantId" IS NOT NULL
          ${limit ? `AND t.id IN (SELECT id FROM "employee_work_history" WHERE "tenantId" IS NULL LIMIT ${limit})` : ''}`
      : `SELECT count(*)::int AS n FROM "employee_work_history" t
           JOIN "employees" e ON t."employeeId" = e.id
          WHERE t."tenantId" IS NULL AND e."tenantId" IS NOT NULL`,
    buildQuarantineSql: () => `
      SELECT count(*)::int AS n,
             COALESCE(array_agg(t.id::text ORDER BY t.id) FILTER (WHERE t.id IS NOT NULL), '{}')::text[] AS sample
        FROM "employee_work_history" t
        LEFT JOIN "employees" e ON t."employeeId" = e.id
       WHERE t."tenantId" IS NULL AND (e.id IS NULL OR e."tenantId" IS NULL)
       LIMIT 50`,
  },
  {
    name: 'employee_work_history_attachments',
    parentPath: 'employee_work_history_attachments.workHistoryId → employee_work_history.tenantId',
    buildBackfillSql: (apply, limit) => apply
      ? `UPDATE "employee_work_history_attachments" t SET "tenantId" = wh."tenantId"
           FROM "employee_work_history" wh
          WHERE t."workHistoryId" = wh.id AND t."tenantId" IS NULL AND wh."tenantId" IS NOT NULL
          ${limit ? `AND t.id IN (SELECT id FROM "employee_work_history_attachments" WHERE "tenantId" IS NULL LIMIT ${limit})` : ''}`
      : `SELECT count(*)::int AS n FROM "employee_work_history_attachments" t
           JOIN "employee_work_history" wh ON t."workHistoryId" = wh.id
          WHERE t."tenantId" IS NULL AND wh."tenantId" IS NOT NULL`,
    buildQuarantineSql: () => `
      SELECT count(*)::int AS n,
             COALESCE(array_agg(t.id::text ORDER BY t.id) FILTER (WHERE t.id IS NOT NULL), '{}')::text[] AS sample
        FROM "employee_work_history_attachments" t
        LEFT JOIN "employee_work_history" wh ON t."workHistoryId" = wh.id
       WHERE t."tenantId" IS NULL AND (wh.id IS NULL OR wh."tenantId" IS NULL)
       LIMIT 50`,
  },
];

interface ModelResult {
  name: string;
  parentPath: string;
  willBackfill: number;       // dry-run count
  applied: number;            // apply mode rows updated
  quarantined: { n: number; sample: string[] };
  error?: string;
}

function getDatabaseUrl(): string {
  const arg = process.argv.find((a) => a.startsWith('--db='))?.slice(5);
  const url = arg ?? process.env.DATABASE_URL;
  if (!url) throw new Error(formatDatabaseUrlMissingMessage());
  return url;
}

function assertSafeForApply(url: string): void {
  let host = '', dbName = '';
  try { const u = new URL(url); host = u.hostname; dbName = u.pathname.replace(/^\//, ''); } catch { /* */ }
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing --apply with NODE_ENV=production');
  if (PROD_HOST_RES.some((re) => re.test(host))) throw new Error(`Refusing --apply: host "${host}" on prod deny-list`);
  if (PROD_DB_RES.some((re) => re.test(dbName))) throw new Error(`Refusing --apply: db "${dbName}" on prod deny-list`);
  if (!STAGING_HOST_RES.some((re) => re.test(host)) && process.env.ALLOW_NON_STAGING_APPLY !== 'true') {
    throw new Error(`Refusing --apply: host "${host}" not on staging allow-list. Set ALLOW_NON_STAGING_APPLY=true ONLY for non-prod sandboxes.`);
  }
  if (process.env.ALLOW_SAAS_STAGING_MUTATION !== 'true') {
    throw new Error('Refusing --apply: set ALLOW_SAAS_STAGING_MUTATION=true');
  }
}

async function runBackfillForModel(
  c: Client,
  spec: ModelSpec,
  apply: boolean,
  limit: number | null,
): Promise<ModelResult> {
  const result: ModelResult = {
    name: spec.name,
    parentPath: spec.parentPath,
    willBackfill: 0,
    applied: 0,
    quarantined: { n: 0, sample: [] },
  };
  // Tolerance for missing tables/columns: if the table doesn't exist in
  // this DB, mark the model as skipped (no error) so the script can be
  // pointed at minimal fixtures.
  try {
    const exists = await c.query<{ ok: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename = $1
       ) AS ok`,
      [spec.name],
    );
    if (!exists.rows[0]?.ok) {
      result.error = 'table not present (skipped)';
      return result;
    }
    const hasTid = await c.query<{ ok: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name=$1 AND column_name='tenantId'
       ) AS ok`,
      [spec.name],
    );
    if (!hasTid.rows[0]?.ok) {
      result.error = 'tenantId column missing (apply Phase 2.3 migration first)';
      return result;
    }

    if (apply) {
      const sql = spec.buildBackfillSql(true, limit);
      const r = await c.query(sql);
      result.applied = r.rowCount ?? 0;
    }
    const drySql = spec.buildBackfillSql(false, limit);
    const r = await c.query<{ n: number }>(drySql);
    result.willBackfill = r.rows[0]?.n ?? 0;

    const qSql = spec.buildQuarantineSql();
    const q = await c.query<{ n: number; sample: string[] }>(qSql);
    result.quarantined = { n: q.rows[0]?.n ?? 0, sample: q.rows[0]?.sample ?? [] };
  } catch (e) {
    result.error = (e as Error).message;
  }
  return result;
}

async function maybeQueueQuarantine(c: Client, results: ModelResult[]): Promise<number> {
  // Insert quarantine rows for unresolved entities, deduplicating by
  // (kind, subject->>'modelId') so re-runs don't multiply rows.
  let inserted = 0;
  try {
    for (const r of results) {
      for (const id of r.quarantined.sample) {
        const ins = await c.query<{ id: string }>(
          `INSERT INTO saas_reconciliation_queue (kind, subject, decision)
                VALUES ($1, $2::jsonb, 'pending')
            ON CONFLICT DO NOTHING
            RETURNING id::text`,
          [
            `tenantid-denorm.${r.name}.unresolved-parent`,
            JSON.stringify({ model: r.name, id, parentPath: r.parentPath }),
          ],
        );
        if (ins.rowCount ?? 0) inserted++;
      }
    }
  } catch {
    // saas_reconciliation_queue may be missing if Phase 1 prep wasn't run.
    // We only log — we don't fail the backfill for that.
  }
  return inserted;
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const apply = process.argv.includes('--apply');
  const failOnQuarantine = process.argv.includes('--fail-on-quarantine');
  const limitArgIdx = process.argv.indexOf('--limit');
  const limit = limitArgIdx >= 0 ? Math.max(1, parseInt(process.argv[limitArgIdx + 1] ?? '', 10) || Number.MAX_SAFE_INTEGER) : null;
  const modelArgIdx = process.argv.indexOf('--model');
  const modelArg = modelArgIdx >= 0 ? process.argv[modelArgIdx + 1] : undefined;

  if (apply) assertSafeForApply(url);

  const cfg: ClientConfig = { connectionString: url };
  cfg.ssl = /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false };
  const c = new Client(cfg);
  await c.connect();

  const subset = modelArg ? MODELS.filter((m) => m.name === modelArg) : MODELS;
  if (modelArg && subset.length === 0) {
    console.error(`Unknown model: ${modelArg}. Known: ${MODELS.map((m) => m.name).join(', ')}`);
    await c.end();
    process.exit(3);
  }

  const results: ModelResult[] = [];
  for (const spec of subset) {
    const r = await runBackfillForModel(c, spec, apply, limit);
    results.push(r);
    console.log(`[${apply ? 'APPLY' : 'DRY  '}] ${r.name.padEnd(38)} ` +
      `applied=${r.applied} willBackfill=${r.willBackfill} quarantined=${r.quarantined.n}` +
      (r.error ? ` ERROR=${r.error}` : ''));
  }

  let queued = 0;
  if (apply) queued = await maybeQueueQuarantine(c, results);

  await c.end();

  await fs.mkdir(OUT_DIR, { recursive: true });
  const summary = {
    generatedAt: new Date().toISOString(),
    mode: apply ? 'apply' : 'dry-run',
    database: url.replace(/:[^:@/]+@/, ':***@'),
    counts: {
      models:           results.length,
      totalApplied:     results.reduce((s, r) => s + r.applied, 0),
      totalWillBackfill: results.reduce((s, r) => s + r.willBackfill, 0),
      totalQuarantined: results.reduce((s, r) => s + r.quarantined.n, 0),
      reconciliationQueueRowsInserted: queued,
      errors:           results.filter((r) => r.error).length,
    },
    results,
  };
  await fs.writeFile(path.join(OUT_DIR, 'entity-tenantid-backfill.json'), JSON.stringify(summary, null, 2));

  const md: string[] = [];
  md.push('# Phase 2.3 — Entity-Keyed `tenantId` Backfill');
  md.push('');
  md.push(`Generated: ${summary.generatedAt}`);
  md.push(`Mode: \`${summary.mode}\``);
  md.push(`Database: \`${summary.database}\``);
  md.push('');
  md.push(`- Models processed: ${summary.counts.models}`);
  md.push(`- Rows backfilled (apply): ${summary.counts.totalApplied}`);
  md.push(`- Rows still pending dry-run count: ${summary.counts.totalWillBackfill}`);
  md.push(`- Rows quarantined (unresolved parent): ${summary.counts.totalQuarantined}`);
  md.push(`- Reconciliation queue rows inserted: ${summary.counts.reconciliationQueueRowsInserted}`);
  md.push(`- Errors: ${summary.counts.errors}`);
  md.push('');
  md.push('| Model | Parent path | Applied | Pending | Quarantined |');
  md.push('|-------|-------------|--------:|--------:|------------:|');
  for (const r of results) {
    md.push(`| \`${r.name}\` | ${r.parentPath} | ${r.applied} | ${r.willBackfill} | ${r.quarantined.n}${r.error ? ` ⚠️ ${r.error}` : ''} |`);
  }
  await fs.writeFile(path.join(OUT_DIR, 'entity-tenantid-backfill.md'), md.join('\n'));

  if (failOnQuarantine && summary.counts.totalQuarantined > 0) {
    console.error(`FAIL — ${summary.counts.totalQuarantined} rows quarantined (--fail-on-quarantine).`);
    process.exit(2);
  }
}

main().catch((e) => { console.error(e); process.exit(3); });
