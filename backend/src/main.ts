import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Catch, ArgumentsHost, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { I18nExceptionFilter } from './common/i18n/i18n-exception.filter';
import { validationExceptionFactory } from './common/errors/validation-exception.factory';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import * as express from 'express';
import { join } from 'path';
import { mkdirSync } from 'fs';
import { Client } from 'pg';
import { resolvePoolSsl } from '../prisma/pg-ssl';

// Same TLS policy as every other database connection (prisma/pg-ssl.ts).
const resolveStartupSsl = resolvePoolSsl;

async function runStartupMigrations(attempt = 1) {
  const MAX_ATTEMPTS = 3;
  const logger = new Logger('StartupMigrations');
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: resolveStartupSsl(process.env.DATABASE_URL),
  });
  try {
    await client.connect();

    // 1. Drop unique CONSTRAINTS on applicants.email
    const constraints = await client.query(`
      SELECT con.conname
      FROM   pg_constraint con
      JOIN   pg_class       rel ON rel.oid = con.conrelid
      JOIN   pg_attribute   att ON att.attrelid = rel.oid
                               AND att.attnum = ANY(con.conkey)
      WHERE  rel.relname = 'applicants'
        AND  att.attname = 'email'
        AND  con.contype = 'u'
    `);
    for (const row of constraints.rows) {
      await client.query(`ALTER TABLE applicants DROP CONSTRAINT "${row.conname}"`);
      logger.log(`Dropped unique constraint "${row.conname}" on applicants.email`);
    }

    // 2. Drop unique INDEXES on applicants.email (Prisma may create an index not a constraint)
    const indexes = await client.query(`
      SELECT i.relname AS indexname
      FROM   pg_index ix
      JOIN   pg_class t  ON t.oid = ix.indrelid
      JOIN   pg_class i  ON i.oid = ix.indexrelid
      JOIN   pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
      WHERE  t.relname     = 'applicants'
        AND  a.attname     = 'email'
        AND  ix.indisunique = true
    `);
    for (const row of indexes.rows) {
      await client.query(`DROP INDEX IF EXISTS "${row.indexname}"`);
      logger.log(`Dropped unique index "${row.indexname}" on applicants.email`);
    }

    if (constraints.rows.length === 0 && indexes.rows.length === 0) {
      logger.log('applicants.email — no unique constraint or index found');
    }

    // 3. Ensure the application_drafts table + upload columns exist.
    //    Save-for-later relies on photoUrl and documents being persisted
    //    on the draft row; without them the photo/document previews
    //    silently disappear after a page refresh.
    await client.query(`
      CREATE TABLE IF NOT EXISTS "application_drafts" (
        "id"          text PRIMARY KEY,
        "createdById" text NOT NULL UNIQUE,
        "jobAdId"     text,
        "formData"    jsonb NOT NULL DEFAULT '{}'::jsonb,
        "createdAt"   timestamptz NOT NULL DEFAULT now(),
        "updatedAt"   timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(`
      ALTER TABLE "application_drafts"
        ADD COLUMN IF NOT EXISTS "photoUrl"  text
    `);
    await client.query(`
      ALTER TABLE "application_drafts"
        ADD COLUMN IF NOT EXISTS "documents" jsonb NOT NULL DEFAULT '[]'::jsonb
    `);
    logger.log('application_drafts — photoUrl + documents columns ensured');

    // 4. Profile creation attribution. Adds createdById + source to
    //    applicants and employees so the UI can show who created a
    //    record and flag self-applied (public /apply) submissions.
    await client.query(`
      ALTER TABLE "applicants"
        ADD COLUMN IF NOT EXISTS "createdById" text,
        ADD COLUMN IF NOT EXISTS "source"      text NOT NULL DEFAULT 'STAFF_CREATED'
    `);
    await client.query(`
      ALTER TABLE "employees"
        ADD COLUMN IF NOT EXISTS "createdById" text,
        ADD COLUMN IF NOT EXISTS "source"      text NOT NULL DEFAULT 'STAFF_CREATED'
    `);
    // Add FKs if missing so Prisma can resolve the relation.
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'applicants_createdById_fkey') THEN
          ALTER TABLE "applicants"
            ADD CONSTRAINT "applicants_createdById_fkey"
            FOREIGN KEY ("createdById") REFERENCES "users"(id) ON DELETE SET NULL;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employees_createdById_fkey') THEN
          ALTER TABLE "employees"
            ADD CONSTRAINT "employees_createdById_fkey"
            FOREIGN KEY ("createdById") REFERENCES "users"(id) ON DELETE SET NULL;
        END IF;
      END $$
    `);
    logger.log('applicants/employees — createdById + source columns ensured');

    // 5b. Ensure employees.applicationData exists so the structured
    //     form blob captured during application carries over onto
    //     the employee record at conversion time.
    await client.query(`
      ALTER TABLE "employees"
        ADD COLUMN IF NOT EXISTS "applicationData" jsonb
    `);
    logger.log('employees.applicationData column ensured');

    // 6. Multi-deduction support for financial_records. Create the
    //    child table and backfill a single row from every existing
    //    DEDUCTED record so historical data survives the upgrade.
    await client.query(`
      CREATE TABLE IF NOT EXISTS "financial_record_deductions" (
        "id"                text PRIMARY KEY,
        "financialRecordId" text NOT NULL,
        "amount"            numeric(10,2) NOT NULL,
        "deductionDate"     timestamptz NOT NULL,
        "payrollReference"  text,
        "notes"             text,
        "createdById"       text,
        "createdAt"         timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS "financial_record_deductions_financialRecordId_idx"
        ON "financial_record_deductions"("financialRecordId")
    `);
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'financial_record_deductions_financialRecordId_fkey') THEN
          ALTER TABLE "financial_record_deductions"
            ADD CONSTRAINT "financial_record_deductions_financialRecordId_fkey"
            FOREIGN KEY ("financialRecordId") REFERENCES "financial_records"(id) ON DELETE CASCADE;
        END IF;
      END $$
    `);
    const backfill = await client.query(`
      INSERT INTO "financial_record_deductions" (id, "financialRecordId", amount, "deductionDate", "payrollReference")
      SELECT gen_random_uuid()::text, id, "deductionAmount", COALESCE("deductionDate", "updatedAt"), "payrollReference"
      FROM "financial_records" r
      WHERE "deductionAmount" IS NOT NULL
        AND "deductionAmount" > 0
        AND NOT EXISTS (
          SELECT 1 FROM "financial_record_deductions" d WHERE d."financialRecordId" = r.id
        )
    `);
    if (backfill.rowCount && backfill.rowCount > 0) {
      logger.log(`financial_record_deductions — backfilled ${backfill.rowCount} row(s) from legacy single-deduction fields`);
    } else {
      logger.log('financial_record_deductions — table ensured (no backfill needed)');
    }

    // 7. Configurable transaction types. Replaces the hardcoded list
    //    in backend/src/finance/constants.ts. Created empty and seeded
    //    once with the built-in defaults so existing installs keep
    //    the same dropdown options on first boot.
    await client.query(`
      CREATE TABLE IF NOT EXISTS "finance_transaction_types" (
        "id"        text PRIMARY KEY,
        "name"      text NOT NULL UNIQUE,
        "isActive"  boolean NOT NULL DEFAULT true,
        "sortOrder" integer NOT NULL DEFAULT 100,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
    const existingTypeCount = await client.query(`SELECT COUNT(*)::int AS c FROM "finance_transaction_types"`);
    if ((existingTypeCount.rows[0]?.c ?? 0) === 0) {
      const defaults = [
        'Cash Advance',
        'Visa Fee',
        'Work Permit Fee',
        'Accommodation Cost',
        'Translation Fees',
        'Other Official Documents Fees',
        'Insurance Fees',
        'Medical Report Fees',
        'Transport Cost',
        'Fine/Penalty',
        'Equipment',
        'Other',
      ];
      for (let i = 0; i < defaults.length; i++) {
        await client.query(
          `INSERT INTO "finance_transaction_types" (id, name, "sortOrder")
           VALUES (gen_random_uuid()::text, $1, $2)
           ON CONFLICT (name) DO NOTHING`,
          [defaults[i], i * 10],
        );
      }
      logger.log(`finance_transaction_types — seeded ${defaults.length} default types`);
    } else {
      logger.log('finance_transaction_types — already seeded');
    }

    // 8. Attendance: break times + OFF/VACATION/SICK enum values +
    //    locked-periods table. Idempotent on every boot so the feature
    //    works without a manual prisma migrate.
    await client.query(`
      ALTER TABLE "attendance_records"
        ADD COLUMN IF NOT EXISTS "breakIn"  text,
        ADD COLUMN IF NOT EXISTS "breakOut" text
    `);
    for (const value of ['OFF', 'VACATION', 'SICK']) {
      await client.query(`
        DO $$ BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_enum e
            JOIN pg_type t ON e.enumtypid = t.oid
            WHERE t.typname = 'AttendanceStatus' AND e.enumlabel = '${value}'
          ) THEN
            EXECUTE 'ALTER TYPE "AttendanceStatus" ADD VALUE ''${value}'' ';
          END IF;
        END $$
      `);
    }
    await client.query(`
      CREATE TABLE IF NOT EXISTS "attendance_locked_periods" (
        "id"         text PRIMARY KEY,
        "year"       integer NOT NULL,
        "month"      integer NOT NULL,
        "lockedById" text,
        "lockedAt"   timestamptz NOT NULL DEFAULT now(),
        "reason"     text
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "attendance_locked_periods_year_month_key"
        ON "attendance_locked_periods"("year", "month")
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS "attendance_locked_periods_year_month_idx"
        ON "attendance_locked_periods"("year", "month")
    `);
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attendance_locked_periods_lockedById_fkey') THEN
          ALTER TABLE "attendance_locked_periods"
            ADD CONSTRAINT "attendance_locked_periods_lockedById_fkey"
            FOREIGN KEY ("lockedById") REFERENCES "users"(id) ON DELETE SET NULL;
        END IF;
      END $$
    `);
    logger.log('attendance — break columns + lock table ensured');

    // 9. Employee Work History (Contracts tab — post-hire timeline).
    //    Idempotent: creates the enum, the two tables, and the FKs.
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'WorkHistoryEventType') THEN
          CREATE TYPE "WorkHistoryEventType" AS ENUM (
            'NEW_CONTRACT', 'PROBATION_START', 'PROBATION_END',
            'END_OF_CONTRACT', 'UNPAID_LEAVE_START', 'UNPAID_LEAVE_END',
            'TERMINATED'
          );
        END IF;
      END $$
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS "employee_work_history" (
        "id"           text PRIMARY KEY,
        "employeeId"   text NOT NULL,
        "date"         date NOT NULL,
        "eventType"    "WorkHistoryEventType" NOT NULL,
        "description"  text,
        "createdById"  text,
        "approvedById" text,
        "createdAt"    timestamptz NOT NULL DEFAULT now(),
        "updatedAt"    timestamptz NOT NULL DEFAULT now(),
        "deletedAt"    timestamptz,
        "deletedBy"    text
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS "employee_work_history_employeeId_date_idx"
        ON "employee_work_history"("employeeId", "date")
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS "employee_work_history_eventType_idx"
        ON "employee_work_history"("eventType")
    `);
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employee_work_history_employeeId_fkey') THEN
          ALTER TABLE "employee_work_history"
            ADD CONSTRAINT "employee_work_history_employeeId_fkey"
            FOREIGN KEY ("employeeId") REFERENCES "employees"(id) ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employee_work_history_createdById_fkey') THEN
          ALTER TABLE "employee_work_history"
            ADD CONSTRAINT "employee_work_history_createdById_fkey"
            FOREIGN KEY ("createdById") REFERENCES "users"(id) ON DELETE SET NULL;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employee_work_history_approvedById_fkey') THEN
          ALTER TABLE "employee_work_history"
            ADD CONSTRAINT "employee_work_history_approvedById_fkey"
            FOREIGN KEY ("approvedById") REFERENCES "users"(id) ON DELETE SET NULL;
        END IF;
      END $$
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS "employee_work_history_attachments" (
        "id"            text PRIMARY KEY,
        "workHistoryId" text NOT NULL,
        "name"          text NOT NULL,
        "fileUrl"       text NOT NULL,
        "mimeType"      text,
        "fileSize"      integer,
        "uploadedById"  text,
        "createdAt"     timestamptz NOT NULL DEFAULT now(),
        "deletedAt"     timestamptz
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS "employee_work_history_attachments_workHistoryId_idx"
        ON "employee_work_history_attachments"("workHistoryId")
    `);
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employee_work_history_attachments_workHistoryId_fkey') THEN
          ALTER TABLE "employee_work_history_attachments"
            ADD CONSTRAINT "employee_work_history_attachments_workHistoryId_fkey"
            FOREIGN KEY ("workHistoryId") REFERENCES "employee_work_history"(id) ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employee_work_history_attachments_uploadedById_fkey') THEN
          ALTER TABLE "employee_work_history_attachments"
            ADD CONSTRAINT "employee_work_history_attachments_uploadedById_fkey"
            FOREIGN KEY ("uploadedById") REFERENCES "users"(id) ON DELETE SET NULL;
        END IF;
      END $$
    `);
    logger.log('employee_work_history — tables + enum + FKs ensured');

    // 9a. Add IN_PROGRESS to CandidateProgressStatus so freshly-
    //     assigned candidates land on stage 1 with a "In Progress"
    //     label instead of the generic ACTIVE.
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_enum e
          JOIN pg_type t ON e.enumtypid = t.oid
          WHERE t.typname = 'CandidateProgressStatus' AND e.enumlabel = 'IN_PROGRESS'
        ) THEN
          EXECUTE 'ALTER TYPE "CandidateProgressStatus" ADD VALUE ''IN_PROGRESS'' ';
        END IF;
      END $$
    `);
    logger.log('CandidateProgressStatus — IN_PROGRESS value ensured');

    // 9c. Responsible / Approver split on workflow stages. Adds the
    //     responsibleAny flag to workflow_stages (default true so
    //     existing stages keep their current "any user may process"
    //     behaviour) and introduces the two canonical role values on
    //     workflow_stage_users — legacy REVIEWER rows are left
    //     untouched and treated as APPROVER at the service layer.
    await client.query(`
      ALTER TABLE "workflow_stages"
        ADD COLUMN IF NOT EXISTS "responsibleAny" boolean NOT NULL DEFAULT true,
        ADD COLUMN IF NOT EXISTS "minApprovals"   integer NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS "approvalMode"   text    NOT NULL DEFAULT 'ANY'
    `);
    logger.log('workflow_stages.responsibleAny + minApprovals + approvalMode ensured');

    // 9b. Make the eventType column configurable. Switch it from the
    //     static WorkHistoryEventType enum to plain text, and back the
    //     dropdown with a new settings table seeded from the original
    //     seven values. Idempotent on every boot.
    await client.query(`
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'employee_work_history'
            AND column_name = 'eventType'
            AND data_type = 'USER-DEFINED'
        ) THEN
          ALTER TABLE "employee_work_history"
            ALTER COLUMN "eventType" TYPE text USING "eventType"::text;
        END IF;
      END $$
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS "work_history_event_types" (
        "id"        text PRIMARY KEY,
        "value"     text NOT NULL UNIQUE,
        "label"     text NOT NULL,
        "isActive"  boolean NOT NULL DEFAULT true,
        "sortOrder" integer NOT NULL DEFAULT 100,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
    const whExistingCount = await client.query(
      `SELECT COUNT(*)::int AS c FROM "work_history_event_types"`,
    );
    if ((whExistingCount.rows[0]?.c ?? 0) === 0) {
      const defaults: Array<[string, string]> = [
        ['NEW_CONTRACT',        'New Contract'],
        ['PROBATION_START',     'Probation Period Start'],
        ['PROBATION_END',       'Probation Period End'],
        ['END_OF_CONTRACT',     'End of Contract'],
        ['UNPAID_LEAVE_START',  'Unpaid Leave Start'],
        ['UNPAID_LEAVE_END',    'Unpaid Leave End'],
        ['TERMINATED',          'Terminated'],
      ];
      for (let i = 0; i < defaults.length; i++) {
        const [value, label] = defaults[i];
        await client.query(
          `INSERT INTO "work_history_event_types" (id, value, label, "sortOrder")
           VALUES (gen_random_uuid()::text, $1, $2, $3)
           ON CONFLICT (value) DO NOTHING`,
          [value, label, i * 10],
        );
      }
      logger.log(`work_history_event_types — seeded ${defaults.length} default types`);
    } else {
      logger.log('work_history_event_types — already seeded');
    }

    // 10. Vehicle Management — relax status/fuelType to text and add the
    //     new profile columns (purchase, insurance policy, body/hitch
    //     types, ADR/tanker, refrigeration, specialty equipment, …).
    //     The existing VehicleStatus and FuelType enums are dropped from
    //     the column type so the lookup lists managed under
    //     System Settings → Vehicle Settings can fully replace them.
    await client.query(`
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'vehicles' AND column_name = 'status' AND udt_name = 'VehicleStatus'
        ) THEN
          ALTER TABLE "vehicles" ALTER COLUMN "status" DROP DEFAULT;
          ALTER TABLE "vehicles" ALTER COLUMN "status" TYPE text USING "status"::text;
          ALTER TABLE "vehicles" ALTER COLUMN "status" SET DEFAULT 'ACTIVE';
        END IF;
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'vehicles' AND column_name = 'fuelType' AND udt_name = 'FuelType'
        ) THEN
          ALTER TABLE "vehicles" ALTER COLUMN "fuelType" TYPE text USING "fuelType"::text;
        END IF;
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'vehicles' AND column_name = 'type' AND udt_name = 'VehicleType'
        ) THEN
          ALTER TABLE "vehicles" ALTER COLUMN "type" TYPE text USING "type"::text;
          ALTER TABLE "vehicles" ALTER COLUMN "type" SET DEFAULT 'Truck';
          -- Convert legacy SCREAMING_SNAKE_CASE codes to the human-friendly
          -- labels that match the seeded vehicle.vehicleTypes lookup, so
          -- existing rows render correctly in the new dropdowns.
          UPDATE "vehicles" SET "type" = CASE "type"
            WHEN 'TRUCK'                THEN 'Truck'
            WHEN 'CAR'                  THEN 'Car'
            WHEN 'VAN'                  THEN 'Van'
            WHEN 'TANKER'               THEN 'Tanker'
            WHEN 'TRAILER'              THEN 'Trailer'
            WHEN 'REFRIGERATED_TRAILER' THEN 'Refrigerated Trailer'
            WHEN 'SPECIALTY'            THEN 'Specialty'
            ELSE "type"
          END;
        END IF;
      END $$
    `);
    await client.query(`
      ALTER TABLE "vehicles"
        ADD COLUMN IF NOT EXISTS "licensePlate"               text,
        ADD COLUMN IF NOT EXISTS "fuelCapacity"               double precision,
        ADD COLUMN IF NOT EXISTS "registrationExpiryDate"     date,
        ADD COLUMN IF NOT EXISTS "purchaseOrder"              text,
        ADD COLUMN IF NOT EXISTS "purchaseDate"               date,
        ADD COLUMN IF NOT EXISTS "purchaseCost"               double precision,
        ADD COLUMN IF NOT EXISTS "purchaseContract"           text,
        ADD COLUMN IF NOT EXISTS "vendorName"                 text,
        ADD COLUMN IF NOT EXISTS "vendorAddress"              text,
        ADD COLUMN IF NOT EXISTS "insurancePolicyNumber"      text,
        ADD COLUMN IF NOT EXISTS "insuranceCompany"           text,
        ADD COLUMN IF NOT EXISTS "insuranceType"              text,
        ADD COLUMN IF NOT EXISTS "insuranceStartDate"         date,
        ADD COLUMN IF NOT EXISTS "tareWeight"                 double precision,
        ADD COLUMN IF NOT EXISTS "bodyType"                   text,
        ADD COLUMN IF NOT EXISTS "hitchType"                  text,
        ADD COLUMN IF NOT EXISTS "lengthM"                    double precision,
        ADD COLUMN IF NOT EXISTS "widthM"                     double precision,
        ADD COLUMN IF NOT EXISTS "heightM"                    double precision,
        ADD COLUMN IF NOT EXISTS "euroEmissionClass"          text,
        ADD COLUMN IF NOT EXISTS "tachographSerial"           text,
        ADD COLUMN IF NOT EXISTS "tachographCalibrationExpiry" date,
        ADD COLUMN IF NOT EXISTS "seatingCapacity"            integer,
        ADD COLUMN IF NOT EXISTS "loadVolume"                 double precision,
        ADD COLUMN IF NOT EXISTS "partitionFitted"            boolean,
        ADD COLUMN IF NOT EXISTS "vinSubType"                 text,
        ADD COLUMN IF NOT EXISTS "insuranceGroup"             text,
        ADD COLUMN IF NOT EXISTS "tankMaterial"               text,
        ADD COLUMN IF NOT EXISTS "adrClass"                   text,
        ADD COLUMN IF NOT EXISTS "unNumbers"                  text,
        ADD COLUMN IF NOT EXISTS "lastPressureTestDate"       date,
        ADD COLUMN IF NOT EXISTS "nextPressureTestDate"       date,
        ADD COLUMN IF NOT EXISTS "refrigerationModel"         text,
        ADD COLUMN IF NOT EXISTS "tempMin"                    double precision,
        ADD COLUMN IF NOT EXISTS "tempMax"                    double precision,
        ADD COLUMN IF NOT EXISTS "atpCertificateNumber"       text,
        ADD COLUMN IF NOT EXISTS "atpCertificateExpiry"       date,
        ADD COLUMN IF NOT EXISTS "equipmentDescription"       text,
        ADD COLUMN IF NOT EXISTS "customAttributes"           jsonb
    `);
    logger.log('vehicles — extended profile columns + status/fuelType relaxed to text');

    // 11. Seed default Vehicle Management lookup lists in system_settings
    //     so freshly-installed instances ship with sensible dropdowns. The
    //     value column stores a JSON-encoded array of strings — same
    //     pattern as form.truckBrands / form.trailerTypes / etc.
    const VEHICLE_LOOKUP_DEFAULTS: Record<string, string[]> = {
      'vehicle.vehicleTypes':        ['Truck', 'Car', 'Van', 'Tanker', 'Trailer', 'Refrigerated Trailer', 'Specialty'],
      'vehicle.statuses':            ['Active', 'Inactive', 'In Maintenance', 'Rented', 'Reserved', 'Awaiting Parts', 'Scrapped'],
      'vehicle.fuelTypes':           ['Diesel', 'Petrol', 'Electric', 'Hybrid', 'CNG', 'LPG', 'Hydrogen', 'Other'],
      'vehicle.bodyTypes':           ['Flatbed', 'Curtainsider', 'Box', 'Tipper', 'Skeletal', 'Low-loader', 'Walking Floor'],
      'vehicle.hitchTypes':          ['5th Wheel', 'Drawbar', 'Pintle', 'Ball', 'Goose Neck'],
      'vehicle.tankMaterials':       ['Stainless Steel', 'Aluminium', 'Carbon Steel', 'Mild Steel', 'GRP / Composite'],
      'vehicle.adrClasses':          ['1 Explosives', '2 Gases', '3 Flammable Liquids', '4 Flammable Solids', '5 Oxidising', '6 Toxic', '7 Radioactive', '8 Corrosive', '9 Misc'],
      'vehicle.vinSubTypes':         ['Saloon', 'Hatchback', 'Estate', 'Coupe', 'Convertible', 'SUV', 'MPV'],
      'vehicle.insuranceGroups':     ['1', '2', '3', '4', '5', '10', '20', '30', '40', '50'],
      'vehicle.insuranceTypes':      ['Comprehensive', 'Third Party', 'Third Party Fire & Theft', 'Goods in Transit', 'Hazardous Goods', 'Fleet Policy'],
      'vehicle.documentTypes':       ['Inspection', 'Emission Test', 'Permit', 'Registration', 'MOT Certificate', 'Insurance Certificate', 'Tachograph Calibration', 'ATP Certificate', 'ADR Certificate'],
      'vehicle.euroEmissionClasses': ['Euro I', 'Euro II', 'Euro III', 'Euro IV', 'Euro V', 'Euro VI'],
    };
    for (const [key, values] of Object.entries(VEHICLE_LOOKUP_DEFAULTS)) {
      const existing = await client.query(
        `SELECT id FROM "system_settings" WHERE key = $1`,
        [key],
      );
      if (existing.rows.length === 0) {
        await client.query(
          `INSERT INTO "system_settings" (id, key, value, category, description, "isPublic", "updatedAt")
           VALUES (gen_random_uuid()::text, $1, $2, 'vehicle', $3, false, now())`,
          [key, JSON.stringify(values), `Vehicle Management — ${key.replace('vehicle.', '')} lookup`],
        );
      }
    }
    logger.log('system_settings — vehicle lookup defaults seeded');

    // 5. Cleanup of phantom profile-photo document rows.
    //    Before the fix, the public /apply photo upload mis-classified
    //    the profile photo as the first-available DocumentType (usually
    //    Passport) while also correctly stamping applicant.photoUrl.
    //    Those Document rows serve no purpose — the photo is already on
    //    the applicant record — and just clutter the Documents tab.
    //
    //    Two-pronged match:
    //      (a) fileUrl matches the applicant's photoUrl — unambiguous
    //          evidence the document row IS the profile photo.
    //      (b) name looks like "profile photo" — catches cases where
    //          the applicant's photoUrl was updated later and no longer
    //          points at the original doc's fileUrl.
    //    Cast the enum to text so the comparison is driver-agnostic.
    const deleted = await client.query(`
      DELETE FROM "documents" d
      USING "applicants" a
      WHERE d."entityType"::text = 'APPLICANT'
        AND d."entityId" = a.id
        AND (
          d."fileUrl" = a."photoUrl"
          OR d."name" ILIKE '%profile%photo%'
        )
    `);
    if (deleted.rowCount && deleted.rowCount > 0) {
      logger.log(`documents — removed ${deleted.rowCount} phantom profile-photo row(s)`);
    } else {
      logger.log('documents — no phantom profile-photo rows found');
    }

    // Phase 4 i18n: per-locale translation overrides on user-editable label tables.
    // Idempotent — adds nullable JSONB columns if missing.
    await client.query(`ALTER TABLE "document_types"  ADD COLUMN IF NOT EXISTS "translations" JSONB`);
    await client.query(`ALTER TABLE "job_types"       ADD COLUMN IF NOT EXISTS "translations" JSONB`);
    await client.query(`ALTER TABLE "workflow_stages" ADD COLUMN IF NOT EXISTS "translations" JSONB`);
    logger.log('i18n — translations columns ensured on document_types, job_types, workflow_stages');
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    logger.error('Startup migration error: ' + msg);
    // Managed PG (over SSL) sometimes drops the socket while warming up.
    // The DDL above is all idempotent (IF NOT EXISTS / guarded), so a
    // clean retry on a connection-level failure is safe and lets schema
    // setup finish without waiting for the next restart.
    const transient = /Connection terminated|connection timeout|ECONNRESET|socket hang up/i.test(msg);
    if (transient && attempt < MAX_ATTEMPTS) {
      try { await client.end(); } catch { /* already closed */ }
      const backoffMs = 2000 * attempt;
      logger.warn(`Retrying startup migrations in ${backoffMs}ms (attempt ${attempt + 1}/${MAX_ATTEMPTS})`);
      await new Promise((r) => setTimeout(r, backoffMs));
      return runStartupMigrations(attempt + 1);
    }
  } finally {
    try { await client.end(); } catch { /* may already be ended on retry path */ }
  }
}

@Catch()
class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();
    const request = ctx.getRequest();
    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    let message: string;
    if (exception instanceof HttpException) {
      const res = exception.getResponse();
      if (typeof res === 'string') {
        message = res;
      } else {
        const raw = (res as any).message;
        message = Array.isArray(raw) ? raw.join(', ') : String(raw ?? exception.message);
      }
    } else {
      message = String((exception as any)?.message || exception);
    }

    const logLine = `[${request.method}] ${request.url} → ${status}`;
    if (status >= 500) {
      this.logger.error(logLine);
      this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    } else {
      this.logger.warn(logLine);
    }
    response.status(status).json({ statusCode: status, message, path: request.url });
  }
}

async function bootstrap() {
  await runStartupMigrations();

  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn', 'log'] });

  // CORS
  const allowedOrigins = [
    process.env.FRONTEND_URL || 'http://localhost:5173',
    'http://localhost:5173',
    'http://localhost:4173',
    'https://whale-app-j7j64.ondigitalocean.app',
    'https://monkfish-app-dtv2k.ondigitalocean.app',
    'https://tempworksfrontend-gmwe8.ondigitalocean.app',
    'https://careers.tempworks.eu',
  ].filter(Boolean);

  app.enableCors({
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, curl, Swagger)
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      callback(new Error(`CORS: origin ${origin} not allowed`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    // The SPA runs on another origin: let it read download file names.
    exposedHeaders: ['Content-Disposition'],
  });

  // Global prefix
  app.setGlobalPrefix('api/v1');

  // Global exception logging — emits a uniform { code, message, params }
  // envelope so the frontend can render a localized error.
  app.useGlobalFilters(new I18nExceptionFilter());

  // Global validation. The custom `exceptionFactory` produces a coded
  // envelope `{ code: 'VALIDATION.FAILED', fields: [...] }` that the
  // I18nExceptionFilter forwards verbatim, so the frontend can render
  // inline form errors per field with stable codes.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: false,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
      exceptionFactory: validationExceptionFactory,
    }),
  );

  // Serve uploaded files (BACKWARD COMPAT)
  // New uploads go to DigitalOcean Spaces (see common/storage/storage.service.ts).
  // The local `/uploads` route is kept so historical DB rows that still
  // reference `/uploads/<file>` continue to render. Once those rows are
  // migrated to Spaces, this block can be removed alongside the local
  // driver. Avatars subfolder is preserved for the same legacy reason.
  if ((process.env.UPLOAD_STORAGE_DRIVER || 'local') !== 'spaces') {
    mkdirSync(join(process.cwd(), 'uploads', 'avatars'), { recursive: true });
  }
  app.use('/uploads', express.static(join(process.cwd(), 'uploads')));

  // Swagger
  const config = new DocumentBuilder()
    .setTitle('TempWorks Europe API')
    .setDescription('Employee Recruitment & Compliance Management System REST API')
    .setVersion('1.0')
    .addBearerAuth()
    .addTag('Auth', 'Authentication endpoints')
    .addTag('Users', 'User management')
    .addTag('Roles', 'Role and permission management')
    .addTag('Employees', 'Employee management')
    .addTag('Applicants', 'Applicant management')
    .addTag('Applications', 'Application management')
    .addTag('Documents', 'Document management')
    .addTag('Workflow', 'Workflow and stage management')
    .addTag('Agencies', 'Agency management')
    .addTag('Compliance', 'Compliance monitoring')
    .addTag('Reports', 'Reporting and analytics')
    .addTag('Notifications', 'Notification management')
    .addTag('Settings', 'System settings')
    .addTag('Logs', 'Audit logs')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document, {
    swaggerOptions: { persistAuthorization: true },
  });

  // SIGTERM (App Platform redeploy / scale-in) → orderly shutdown: running
  // backups are interrupted cleanly and recorded, schedulers stop, the HTTP
  // server stops accepting connections. Without this Node exits immediately.
  app.enableShutdownHooks();

  const port = process.env.PORT || 3000;
  await app.listen(port);
  console.log(`🚀 TempWorks API running on: http://localhost:${port}/api/v1`);
  console.log(`📚 Swagger docs: http://localhost:${port}/api/docs`);
}
bootstrap();
