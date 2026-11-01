import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool, PoolConfig } from 'pg';

// Same TLS policy as every other database connection (sslmode + optional
// DATABASE_CA_CERT / PGSSLROOTCERT trust anchor) — see prisma/pg-ssl.ts.
import { resolvePoolSsl } from '../../prisma/pg-ssl';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly pool: Pool;
  private readonly logger = new Logger('PrismaService');

  constructor() {
    // Bound the pool size so a hot-reloading dev server (or a few
    // backend instances behind a load balancer) can't exhaust the
    // database's max_connections quota. `pg`'s default is 10 per
    // pool — but every nest hot-reload spins up a fresh Pool, and
    // if the old one wasn't end()ed cleanly its sockets linger in
    // pg's idle pool until the server reaps them. Cap connections,
    // close idle ones aggressively, and fail fast when no slot is
    // available so the request returns a clean 5xx instead of
    // hanging.
    //
    // Default lowered to 5 (was 10) — a DigitalOcean managed
    // Postgres on the smallest tier exposes ~22 total slots with a
    // handful reserved for superuser. With two backend instances +
    // a pgAdmin session that left no headroom and the request log
    // filled with 'Too many database connections opened'. The cap
    // is per backend instance: a single deploy at max=5 uses at
    // most 5 slots even under high concurrency.
    //
    // Override via PG_POOL_MAX / PG_POOL_IDLE_MS when scaling up
    // the DB plan (managed PG production tiers carry 100+ slots).
    const max = Number(process.env.PG_POOL_MAX ?? 5);
    const idleTimeoutMillis = Number(process.env.PG_POOL_IDLE_MS ?? 10_000);
    const connectionTimeoutMillis = Number(process.env.PG_POOL_CONNECT_MS ?? 5_000);
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: resolvePoolSsl(process.env.DATABASE_URL),
      max,
      idleTimeoutMillis,
      connectionTimeoutMillis,
    });
    const adapter = new PrismaPg(pool as any);
    super({ adapter });
    this.pool = pool;
    this.logger.log(`DATABASE_URL: ${process.env.DATABASE_URL?.replace(/:([^:@]+)@/, ':***@')} (pool max=${max}, idleMs=${idleTimeoutMillis}, connectMs=${connectionTimeoutMillis})`);
  }

  async onModuleInit() {
    try {
      await this.$connect();
      this.logger.log('Prisma connected successfully');
    } catch (err) {
      this.logger.error('Prisma $connect failed:', err);
      throw err;
    }
    // Best-effort maintenance. A transient failure here must not crash
    // bootstrap — $connect already proved the DB is reachable, and these
    // steps are idempotent and re-run on the next start.
    try {
      await this.dropPolymorphicFkConstraints();
    } catch (err: any) {
      this.logger.warn(`dropPolymorphicFkConstraints failed (non-fatal): ${err?.message ?? err}`);
    }
    try {
      await this.healAdditiveDrift();
    } catch (err: any) {
      this.logger.warn(`healAdditiveDrift failed (non-fatal): ${err?.message ?? err}`);
    }
  }

  /**
   * Self-healing migration step.
   *
   * Idempotent additive ALTER/CREATE INDEX statements that bring a
   * partially-migrated dev DB up to the columns the Prisma client
   * thinks exist. Every operation uses `IF NOT EXISTS` so this is
   * safe to run on a fully migrated DB too. Failures are logged but
   * never throw — the regular query paths surface the real error.
   *
   * Add new entries here in lockstep with new additive migrations so
   * local environments don't have to chase `prisma migrate deploy`
   * every time the schema bumps.
   */
  private async healAdditiveDrift(): Promise<void> {
    // Every table on this list must carry a nullable `tenantId TEXT`
    // column plus a btree index. Listed centrally so adding a new
    // tenant-scoped model is a one-line edit.
    const tenantIdTables = [
      // Phase 1 baseline (idempotent — usually already present).
      'agencies', 'applicants', 'employees',
      // Phase 2.3 entity-keyed denorm + later additions.
      'documents', 'audit_logs', 'notifications', 'financial_records',
      'financial_record_attachments', 'financial_record_deductions',
      'vehicles', 'vehicle_documents', 'maintenance_records',
      'visas', 'work_permits',
      'compliance_alerts',
      'attendance_records', 'attendance_locked_periods',
      'employee_work_history', 'employee_work_history_attachments',
      // Phase 2.9 — job ads.
      'job_ads',
      // Phase 2.63 — workflows + assignments.
      'workflows', 'workflow_stages',
      'candidate_workflow_assignments', 'employee_workflow_assignments',
      // Phase 3.10 — platform audit log.
      'platform_audit_logs',
      // SaaS bookkeeping.
      'saas_phase1_seq_snapshot',
      // Phase 3.19 — Workshop tenant scope.
      'workshops',
    ];

    const steps: Array<{ label: string; sql: string }> = [
      ...tenantIdTables.flatMap((tbl) => [
        { label: `${tbl}.tenantId`,     sql: `ALTER TABLE "${tbl}" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;` },
        { label: `${tbl}.tenantId idx`, sql: `CREATE INDEX IF NOT EXISTS "${tbl}_tenantId_idx" ON "${tbl}"("tenantId");` },
      ]),

      // Phase 2.9 — job-ads composite index used by the slug lookups.
      { label: 'job_ads.tenantId slug idx', sql: `CREATE INDEX IF NOT EXISTS "job_ads_tenantId_slug_idx" ON "job_ads"("tenantId","slug");` },

      // IntervalMode column on maintenance_types — present in schema
      // since the maintenance types phase; some dev DBs predate the
      // migration.
      { label: 'IntervalMode enum',         sql: `DO $$ BEGIN CREATE TYPE "IntervalMode" AS ENUM ('DAYS', 'KM', 'BOTH'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;` },
      { label: 'maintenance_types.intervalMode', sql: `ALTER TABLE "maintenance_types" ADD COLUMN IF NOT EXISTS "intervalMode" "IntervalMode" DEFAULT 'KM';` },

      // Phase 3.16 — JobType soft-delete columns.
      { label: 'job_types.deletedAt',       sql: `ALTER TABLE "job_types"     ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);` },
      { label: 'job_types.deletedBy',       sql: `ALTER TABLE "job_types"     ADD COLUMN IF NOT EXISTS "deletedBy" TEXT;` },
      { label: 'job_types.deletionReason',  sql: `ALTER TABLE "job_types"     ADD COLUMN IF NOT EXISTS "deletionReason" TEXT;` },
      { label: 'job_types.deletedAt idx',   sql: `CREATE INDEX IF NOT EXISTS "job_types_deletedAt_idx" ON "job_types"("deletedAt");` },

      // Phase 3.21 — Attendance interruption + UNPAID_LEAVE status.
      { label: 'attendance_records.interruptionIn',     sql: `ALTER TABLE "attendance_records" ADD COLUMN IF NOT EXISTS "interruptionIn" TEXT;` },
      { label: 'attendance_records.interruptionOut',    sql: `ALTER TABLE "attendance_records" ADD COLUMN IF NOT EXISTS "interruptionOut" TEXT;` },
      { label: 'attendance_records.interruptionStatus', sql: `ALTER TABLE "attendance_records" ADD COLUMN IF NOT EXISTS "interruptionStatus" "AttendanceStatus";` },
      { label: 'AttendanceStatus.UNPAID_LEAVE',         sql: `ALTER TYPE "AttendanceStatus" ADD VALUE IF NOT EXISTS 'UNPAID_LEAVE';` },
      // Phase 2B (#1) — paid leave / Platené voľno.
      { label: 'AttendanceStatus.PAID_LEAVE',            sql: `ALTER TYPE "AttendanceStatus" ADD VALUE IF NOT EXISTS 'PAID_LEAVE';` },
      // Phase 2C (#32) — supporting attendance documents.
      { label: 'EntityType.ATTENDANCE',                  sql: `ALTER TYPE "EntityType" ADD VALUE IF NOT EXISTS 'ATTENDANCE';` },
      // Phase 2C (#33) — per-employee attendance lock. NULL employeeId
      // means a legacy/global lock for (tenantId, year, month).
      { label: 'attendance_locked_periods.employeeId',   sql: `ALTER TABLE "attendance_locked_periods" ADD COLUMN IF NOT EXISTS "employeeId" TEXT;` },
      { label: 'attendance_locked_periods.employeeId idx', sql: `CREATE INDEX IF NOT EXISTS "attendance_locked_periods_employeeId_idx" ON "attendance_locked_periods"("employeeId");` },

      // Phase 3.20 — Company Export Profiles for the Excel timesheet header.
      { label: 'company_export_profiles table', sql: `
        CREATE TABLE IF NOT EXISTS "company_export_profiles" (
          "id"                 TEXT PRIMARY KEY,
          "name"               TEXT NOT NULL,
          "legalName"          TEXT,
          "addressLine1"       TEXT,
          "addressLine2"       TEXT,
          "city"               TEXT,
          "postalCode"         TEXT,
          "country"            TEXT,
          "phone"              TEXT,
          "email"              TEXT,
          "vatNumber"          TEXT,
          "registrationNumber" TEXT,
          "logoUrl"            TEXT,
          "footer"             TEXT,
          "isDefault"          BOOLEAN NOT NULL DEFAULT false,
          "deletedAt"          TIMESTAMP(3),
          "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updatedAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "tenantId"           TEXT
        );` },
      { label: 'company_export_profiles.tenantId idx', sql: `CREATE INDEX IF NOT EXISTS "company_export_profiles_tenantId_idx" ON "company_export_profiles"("tenantId");` },
      { label: 'company_export_profiles.deletedAt idx', sql: `CREATE INDEX IF NOT EXISTS "company_export_profiles_deletedAt_idx" ON "company_export_profiles"("deletedAt");` },

      // ── Phase 3 Reports Hardening — Phase B (#17) ───────────────────
      // Additive: tenantId, visibility enum, share table.
      { label: 'reports.tenantId',     sql: `ALTER TABLE "reports" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;` },
      { label: 'reports.tenantId idx', sql: `CREATE INDEX IF NOT EXISTS "reports_tenantId_idx" ON "reports"("tenantId");` },
      { label: 'reports.createdById idx', sql: `CREATE INDEX IF NOT EXISTS "reports_createdById_idx" ON "reports"("createdById");` },
      { label: 'ReportVisibility enum', sql: `DO $$ BEGIN CREATE TYPE "ReportVisibility" AS ENUM ('PRIVATE','SHARED','PUBLIC_IN_TENANT'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;` },
      { label: 'reports.visibility',    sql: `ALTER TABLE "reports" ADD COLUMN IF NOT EXISTS "visibility" "ReportVisibility" NOT NULL DEFAULT 'PRIVATE';` },
      { label: 'ReportSharePermission enum', sql: `DO $$ BEGIN CREATE TYPE "ReportSharePermission" AS ENUM ('VIEW','RUN','EDIT','SHARE'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;` },
      { label: 'report_shares table', sql: `
        CREATE TABLE IF NOT EXISTS "report_shares" (
          "reportId"    TEXT NOT NULL,
          "userId"      TEXT NOT NULL,
          "permission"  "ReportSharePermission" NOT NULL DEFAULT 'VIEW',
          "grantedById" TEXT,
          "grantedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT "report_shares_pkey" PRIMARY KEY ("reportId","userId"),
          CONSTRAINT "report_shares_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "reports"("id") ON DELETE CASCADE
        );` },
      { label: 'report_shares.userId idx', sql: `CREATE INDEX IF NOT EXISTS "report_shares_userId_idx" ON "report_shares"("userId");` },

      // Replace the legacy global `Report.name @unique` with a partial
      // index that's scoped to (tenantId, createdById) AND excludes
      // soft-deleted rows. This is the migration that fixes the
      // "test → delete → recreate" name-conflict bug.
      //
      // Order matters: drop both possible historic constraint shapes
      // (Prisma generates `reports_name_key`; some hand-applied DBs
      // may carry `Report_name_key`) BEFORE the partial index goes in,
      // so the strict global check doesn't race the new write paths.
      // Report names are not unique. Drop any historic global @unique
      // and the per-owner partial unique — users may freely reuse names
      // (e.g. recreating a "test" report after deletion).
      { label: 'reports.name @unique drop (constraint)', sql: `ALTER TABLE "reports" DROP CONSTRAINT IF EXISTS "reports_name_key";` },
      { label: 'reports.name @unique drop (index)',      sql: `DROP INDEX IF EXISTS "reports_name_key";` },
      { label: 'reports.name partial unique drop',       sql: `DROP INDEX IF EXISTS "reports_name_owner_unique";` },

      // Per-event-per-channel preference matrix. The Notifications spec
      // (4.11) requires users to enable/disable each event individually
      // across In-App / Email / SMS — but the model only stored two
      // global toggles + vehicle thresholds. The JSON column persists
      // the matrix; the notifications service reads it on every fanout
      // and the preferences endpoint round-trips it as the user edits.
      // Prisma can't model a Json column on a deployed DB without a
      // migration, so we add it here as a string-typed column and
      // (de)serialise in the service. JSONB is preferred over TEXT for
      // free per-key indexing, even though we don't index it today.
      { label: 'notification_preferences.preferences add',
        sql: `ALTER TABLE "notification_preferences" ADD COLUMN IF NOT EXISTS "preferences" JSONB;` },

      // Notification email outbox. Stage 6 of the §4.11 Notifications
      // spec turns the matrix's Email column from a UI ghost into a
      // real channel. Every fanout writes one row per opted-in
      // recipient; a tick worker drains pending rows and dispatches
      // through EmailService. Outside the Prisma model on purpose so
      // we don't ship a schema migration from this branch — raw SQL
      // owns the lifecycle.
      { label: 'notification_email_outbox table',
        sql: `CREATE TABLE IF NOT EXISTS "notification_email_outbox" (
                "id"               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                "tenantId"         TEXT,
                "userId"           TEXT NOT NULL,
                "email"            TEXT NOT NULL,
                "name"             TEXT,
                "eventType"        TEXT NOT NULL,
                "title"            TEXT NOT NULL,
                "message"          TEXT NOT NULL,
                "locale"           TEXT,
                "relatedEntity"    TEXT,
                "relatedEntityId"  TEXT,
                "params"           JSONB,
                "status"           TEXT NOT NULL DEFAULT 'PENDING',
                "attemptCount"     INT  NOT NULL DEFAULT 0,
                "lastAttemptAt"    TIMESTAMP(3),
                "lastError"        TEXT,
                "sentAt"           TIMESTAMP(3),
                "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT NOW()
              );` },
      { label: 'notification_email_outbox status idx',
        sql: `CREATE INDEX IF NOT EXISTS "notification_email_outbox_status_createdAt_idx"
                ON "notification_email_outbox"("status", "createdAt");` },
      { label: 'notification_email_outbox tenantId idx',
        sql: `CREATE INDEX IF NOT EXISTS "notification_email_outbox_tenantId_idx"
                ON "notification_email_outbox"("tenantId");` },

      // Per-role default preferences. Spec §4.11.2: "the System Admin
      // may define sensible defaults per role". Stored as the same
      // shape as the user matrix (event-key → ChannelPrefs); the
      // resolver merges saved-user → role-default → global-default
      // per cell. Out-of-model (raw SQL) for the same reason as the
      // user matrix — no Prisma migration from this branch.
      { label: 'roles.notificationDefaults add',
        sql: `ALTER TABLE "roles" ADD COLUMN IF NOT EXISTS "notificationDefaults" JSONB;` },

      // Priority column on notifications. Spec §4.11.4 — operators
      // need to filter and sort by priority; admin-published events
      // (maintenance, audit alerts) also want to mark a row HIGH or
      // URGENT so it surfaces above routine traffic.
      //
      // Stored as INT for clean numeric sort:
      //   1 = URGENT  (highest)
      //   2 = HIGH
      //   3 = NORMAL  (default — every existing row)
      //   4 = LOW
      // The service translates between the wire-name and the stored
      // rank at the API boundary so callers never see the integer.
      // Indexed for the sort path.
      { label: 'notifications.priority add',
        sql: `ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "priority" INTEGER NOT NULL DEFAULT 3;` },
      { label: 'notifications.priority idx',
        sql: `CREATE INDEX IF NOT EXISTS "notifications_priority_createdAt_idx"
                ON "notifications"("priority", "createdAt" DESC);` },

      // Daily document digest cron — stamps every in-app row it
      // includes so the next morning's pass excludes it. Partial
      // index keeps the scan cheap: only un-digested rows are
      // candidates. The cron itself filters by eventType separately
      // so a future digest for a different event class can reuse
      // the same column without an additional migration.
      { label: 'notifications.digestedAt add',
        sql: `ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "digestedAt" TIMESTAMP(3);` },
      { label: 'notifications.digestedAt idx',
        sql: `CREATE INDEX IF NOT EXISTS "notifications_digestedAt_eventType_idx"
                ON "notifications"("eventType", "createdAt") WHERE "digestedAt" IS NULL;` },

      // §4.11 Notifications — schema additions for the five events
      // that were data-model-blocked before this stage. Mirror the
      // Prisma model so existing deployments pick the columns up
      // without a migration; new deployments materialise them via
      // `prisma migrate` against the schema on first deploy.
      { label: 'applicants.ownerUserId add',
        sql: `ALTER TABLE "applicants" ADD COLUMN IF NOT EXISTS "ownerUserId" TEXT;` },
      { label: 'applicants.ownerUserId idx',
        sql: `CREATE INDEX IF NOT EXISTS "applicants_ownerUserId_idx"
                ON "applicants"("ownerUserId");` },

      { label: 'employees.profileLocked add',
        sql: `ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "profileLocked" BOOLEAN NOT NULL DEFAULT false;` },
      { label: 'employees.profileLockedAt add',
        sql: `ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "profileLockedAt" TIMESTAMP(3);` },
      { label: 'employees.profileLockedBy add',
        sql: `ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "profileLockedBy" TEXT;` },

      { label: 'employees.contractStartDate add',
        sql: `ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "contractStartDate" TIMESTAMP(3);` },
      { label: 'employees.contractEndDate add',
        sql: `ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "contractEndDate" TIMESTAMP(3);` },
      // Indexed for the contract-expiring cron's range scan.
      { label: 'employees.contractEndDate idx',
        sql: `CREATE INDEX IF NOT EXISTS "employees_contractEndDate_idx"
                ON "employees"("contractEndDate") WHERE "contractEndDate" IS NOT NULL;` },

      // Employment contracts — first-class contract records chained into
      // a chronological timeline per employee, and auto-created from
      // uploaded contract documents. Table + indexes materialise on
      // existing deployments without a Prisma migration; new deployments
      // get them from the schema via `prisma generate` + first boot.
      { label: 'employment_contracts table',
        sql: `CREATE TABLE IF NOT EXISTS "employment_contracts" (
                "id"           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                "employeeId"   TEXT NOT NULL,
                "startDate"    TIMESTAMP(3) NOT NULL,
                "endDate"      TIMESTAMP(3),
                "contractType" TEXT NOT NULL DEFAULT 'Full-time',
                "status"       TEXT NOT NULL DEFAULT 'ACTIVE',
                "documentId"   TEXT,
                "notes"        TEXT,
                "source"       TEXT NOT NULL DEFAULT 'MANUAL',
                "tenantId"     TEXT,
                "createdById"  TEXT,
                "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT NOW(),
                "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT NOW(),
                "deletedAt"    TIMESTAMP(3),
                "deletedBy"    TEXT
              );` },
      { label: 'employment_contracts employeeId idx',
        sql: `CREATE INDEX IF NOT EXISTS "employment_contracts_employeeId_idx"
                ON "employment_contracts"("employeeId");` },
      { label: 'employment_contracts tenantId idx',
        sql: `CREATE INDEX IF NOT EXISTS "employment_contracts_tenantId_idx"
                ON "employment_contracts"("tenantId");` },
      { label: 'employment_contracts documentId idx',
        sql: `CREATE INDEX IF NOT EXISTS "employment_contracts_documentId_idx"
                ON "employment_contracts"("documentId");` },

      // Work-history effective date — the agreed end date on a
      // termination/end-of-contract entry, used to close the current
      // contract in the timeline.
      { label: 'employee_work_history.effectiveDate add',
        sql: `ALTER TABLE "employee_work_history" ADD COLUMN IF NOT EXISTS "effectiveDate" DATE;` },

      // Manual document archive ("No longer valid"). Archived docs stay
      // stored but drop out of active lists / compliance / digest.
      { label: 'documents.archivedAt add',
        sql: `ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMP(3);` },
      { label: 'documents.archivedBy add',
        sql: `ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "archivedBy" TEXT;` },
      { label: 'documents.archivedAt idx',
        sql: `CREATE INDEX IF NOT EXISTS "documents_archivedAt_idx"
                ON "documents"("archivedAt") WHERE "archivedAt" IS NULL;` },

      // Disaster-recovery backup catalog enrichment. Backups became
      // self-describing DR packages (database + globals + uploads +
      // manifest + checksums) with a Database/Full-System distinction,
      // integrity verification as a separate state, offsite status and
      // catalog↔disk reconciliation. Additive columns so existing
      // deployments and legacy single-file backups keep working — legacy
      // rows have kind=NULL and are shown as "Database (legacy)".
      { label: 'system_backups.kind add',
        sql: `ALTER TABLE "system_backups" ADD COLUMN IF NOT EXISTS "kind" TEXT;` },
      { label: 'system_backups.checksum add',
        sql: `ALTER TABLE "system_backups" ADD COLUMN IF NOT EXISTS "checksum" TEXT;` },
      { label: 'system_backups.verifyResult add',
        sql: `ALTER TABLE "system_backups" ADD COLUMN IF NOT EXISTS "verifyResult" TEXT;` },
      { label: 'system_backups.verifiedAt add',
        sql: `ALTER TABLE "system_backups" ADD COLUMN IF NOT EXISTS "verifiedAt" TIMESTAMP(3);` },
      { label: 'system_backups.restoreTestedAt add',
        sql: `ALTER TABLE "system_backups" ADD COLUMN IF NOT EXISTS "restoreTestedAt" TIMESTAMP(3);` },
      { label: 'system_backups.offsiteStatus add',
        sql: `ALTER TABLE "system_backups" ADD COLUMN IF NOT EXISTS "offsiteStatus" TEXT;` },
      { label: 'system_backups.offsiteLocation add',
        sql: `ALTER TABLE "system_backups" ADD COLUMN IF NOT EXISTS "offsiteLocation" TEXT;` },
      { label: 'system_backups.fileMissing add',
        sql: `ALTER TABLE "system_backups" ADD COLUMN IF NOT EXISTS "fileMissing" BOOLEAN NOT NULL DEFAULT false;` },
      // Deferred object deletion (write-once keys + purge queue). Objects are
      // queued here instead of being deleted immediately, then removed by
      // StoragePurgeService after a grace period, never while a backup is
      // running and never while a row still references them. This is what
      // keeps database and file backups consistent under concurrent deletes.
      { label: 'storage_purge_queue create',
        sql: `CREATE TABLE IF NOT EXISTS "storage_purge_queue" (
                "id"          TEXT PRIMARY KEY,
                "objectKey"   TEXT NOT NULL,
                "originalRef" TEXT,
                "driver"      TEXT NOT NULL,
                "legacyLocal" BOOLEAN NOT NULL DEFAULT false,
                "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
                "attempts"    INTEGER NOT NULL DEFAULT 0,
                "lastError"   TEXT
              );` },
      { label: 'storage_purge_queue requestedAt idx',
        sql: `CREATE INDEX IF NOT EXISTS "storage_purge_queue_requestedAt_idx" ON "storage_purge_queue"("requestedAt");` },
      // One row per scheduled occurrence: with several app instances every
      // instance's cron fires; only the one whose INSERT wins runs it.
      { label: 'backup_schedule_claims create',
        sql: `CREATE TABLE IF NOT EXISTS "backup_schedule_claims" (
                "occurrence" TEXT PRIMARY KEY,
                "instance"   TEXT NOT NULL,
                "claimedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
              );` },
      { label: 'system_backups.kind idx',
        sql: `CREATE INDEX IF NOT EXISTS "system_backups_kind_idx" ON "system_backups"("kind");` },
    ];

    let healed = 0;
    for (const step of steps) {
      try {
        await this.$executeRawUnsafe(step.sql);
        healed++;
      } catch (err: any) {
        // Most steps will be no-ops on a fully migrated DB. Only log
        // when the error is something other than "table doesn't exist".
        const msg = String(err?.message ?? err);
        if (!/relation .* does not exist|does not exist/i.test(msg)) {
          this.logger.warn(`drift-heal ${step.label}: ${msg}`);
        }
      }
    }
    this.logger.log(`drift-heal: ${healed}/${steps.length} statements applied (idempotent)`);
  }

  private async dropPolymorphicFkConstraints() {
    // Run through Prisma's own (already-connected) adapter connection
    // rather than acquiring a separate raw `pool.connect()` — the latter
    // could time out on its first acquisition (managed PG over SSL warming
    // up) even though $connect already succeeded, which used to crash boot.
    // Drop named FK constraints (ignore errors — may not exist).
    const named = [
      `ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "document_employee_fk"`,
      `ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "document_applicant_fk"`,
      `ALTER TABLE "visas" DROP CONSTRAINT IF EXISTS "visa_employee_fk"`,
      `ALTER TABLE "visas" DROP CONSTRAINT IF EXISTS "visa_applicant_fk"`,
      `ALTER TABLE "compliance_alerts" DROP CONSTRAINT IF EXISTS "alert_employee_fk"`,
      `ALTER TABLE "compliance_alerts" DROP CONSTRAINT IF EXISTS "alert_applicant_fk"`,
    ];
    for (const sql of named) {
      try { await this.$executeRawUnsafe(sql); } catch { /* may not exist */ }
    }

    try {
      // Find every unique constraint on applicants.email and drop it.
      const res = await this.$queryRawUnsafe<Array<{ conname: string }>>(`
        SELECT con.conname
        FROM   pg_constraint con
        JOIN   pg_class       rel ON rel.oid = con.conrelid
        JOIN   pg_attribute   att ON att.attrelid = rel.oid
                                 AND att.attnum = ANY(con.conkey)
        WHERE  rel.relname = 'applicants'
          AND  att.attname = 'email'
          AND  con.contype = 'u'
      `);

      if (res.length === 0) {
        this.logger.log('applicants.email — no unique constraint found (already clean)');
      }
      for (const row of res) {
        await this.$executeRawUnsafe(`ALTER TABLE applicants DROP CONSTRAINT "${row.conname}"`);
        this.logger.log(`Dropped unique constraint "${row.conname}" on applicants.email`);
      }

      this.logger.log('Startup constraints cleanup complete');
    } catch (err: any) {
      this.logger.error('Startup constraints cleanup error:', err?.message ?? err);
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
    await this.pool.end();
  }

  async softDelete(model: string, id: string) {
    return (this as any)[model].update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }
}
