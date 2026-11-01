-- =============================================================================
-- CONSOLIDATED PRODUCTION FIX
-- =============================================================================
-- Single SQL script that adds every column the current Prisma schema expects
-- but that may be missing on a production database.
--
-- Usage:
--   1. Open your PostgreSQL admin tool (pgAdmin, phpPgAdmin, Supabase SQL
--      editor, Neon SQL editor, etc.)
--   2. Connect to your production database.
--   3. Paste this entire file.
--   4. Click Run / Execute.
--
-- All operations are idempotent (IF NOT EXISTS) — safe to run multiple times.
-- =============================================================================


-- ── APPLICANTS ───────────────────────────────────────────────────────────────
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "tier"                    TEXT NOT NULL DEFAULT 'LEAD';
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "middleName"              TEXT;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "nationality"             TEXT;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "citizenship"             TEXT;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "gender"                  TEXT;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "dateOfBirth"             TIMESTAMP(3);
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "countryOfBirth"          TEXT;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "cityOfBirth"             TEXT;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "photoUrl"                TEXT;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "hasDrivingLicense"       BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "jobTypeId"               TEXT;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "agencyId"                TEXT;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "residencyStatus"         TEXT;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "hasNationalInsurance"    BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "nationalInsuranceNumber" TEXT;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "hasWorkAuthorization"    BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "workAuthorizationType"   TEXT;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "workAuthorizationExpiry" TIMESTAMP(3);
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "preferredStartDate"      TIMESTAMP(3);
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "availability"            TEXT;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "willingToRelocate"       BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "preferredLocations"      TEXT;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "salaryExpectation"       TEXT;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "notes"                   TEXT;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "leadNumber"              TEXT;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "candidateNumber"         TEXT;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "candidateConvertedAt"    TIMESTAMP(3);
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "employeeConvertedAt"     TIMESTAMP(3);
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "applicationData"         JSONB;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "convertedToEmployeeId"   TEXT;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "createdById"             TEXT;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "source"                  TEXT NOT NULL DEFAULT 'STAFF_CREATED';
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "deletedAt"               TIMESTAMP(3);
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "deletedBy"               TEXT;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "deletionReason"          TEXT;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "currentWorkflowStageId"  TEXT;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "jobAdId"                 TEXT;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "approvalStatus"          TEXT NOT NULL DEFAULT 'APPROVED';
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "approvedById"            TEXT;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "approvedAt"              TIMESTAMP(3);
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "rejectionReason"         TEXT;


-- ── EMPLOYEES ────────────────────────────────────────────────────────────────
ALTER TABLE employees ADD COLUMN IF NOT EXISTS "employeeNumber"        TEXT UNIQUE;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS "leadNumber"            TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS "candidateNumber"       TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS "candidateConvertedAt"  TIMESTAMP(3);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS "employeeConvertedAt"   TIMESTAMP(3);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS "licenseNumber"         TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS "licenseCategory"       TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS "yearsExperience"       INTEGER NOT NULL DEFAULT 0;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS "jobTypeId"             TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS "agencyId"              TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS "photoUrl"              TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS "addressLine2"          TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS "emergencyContact"      TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS "emergencyPhone"        TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS "notes"                 TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS "applicationData"       JSONB;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS "createdById"           TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS "source"                TEXT NOT NULL DEFAULT 'STAFF_CREATED';
ALTER TABLE employees ADD COLUMN IF NOT EXISTS "deletedAt"             TIMESTAMP(3);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS "deletedBy"             TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS "deletionReason"        TEXT;


-- ── VEHICLES ─────────────────────────────────────────────────────────────────
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS "type"                        TEXT NOT NULL DEFAULT 'Truck';
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS "status"                      TEXT NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS "year"                        INTEGER;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS "color"                       TEXT;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS "licensePlate"                TEXT;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS "vin"                         TEXT;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS "fuelType"                    TEXT;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS "fuelCapacity"                DOUBLE PRECISION;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS "currentMileage"              INTEGER;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS "notes"                       TEXT;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS "motExpiryDate"               DATE;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS "taxExpiryDate"               DATE;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS "insuranceExpiryDate"         DATE;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS "registrationExpiryDate"      DATE;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS "purchaseOrder"               TEXT;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS "purchaseDate"                DATE;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS "purchaseCost"                DOUBLE PRECISION;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS "purchaseContract"            TEXT;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS "vendorName"                  TEXT;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS "vendorAddress"               TEXT;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS "insurancePolicyNumber"       TEXT;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS "insuranceCompany"            TEXT;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS "insuranceType"               TEXT;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS "insuranceStartDate"          DATE;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS "grossWeight"                 DOUBLE PRECISION;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS "payloadCapacity"             DOUBLE PRECISION;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS "numberOfAxles"               INTEGER;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS "tareWeight"                  DOUBLE PRECISION;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS "bodyType"                    TEXT;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS "hitchType"                   TEXT;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS "lengthM"                     DOUBLE PRECISION;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS "widthM"                      DOUBLE PRECISION;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS "heightM"                     DOUBLE PRECISION;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS "euroEmissionClass"           TEXT;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS "tachographSerial"            TEXT;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS "tachographCalibrationExpiry" DATE;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS "seatingCapacity"             INTEGER;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS "loadVolume"                  DOUBLE PRECISION;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS "partitionFitted"             BOOLEAN;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS "vinSubType"                  TEXT;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS "insuranceGroup"              TEXT;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS "tankerCapacity"              DOUBLE PRECISION;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS "tankMaterial"                TEXT;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS "adrClass"                    TEXT;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS "unNumbers"                   TEXT;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS "lastPressureTestDate"        DATE;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS "nextPressureTestDate"        DATE;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS "trailerLength"               DOUBLE PRECISION;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS "refrigerationUnit"           TEXT;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS "refrigerationModel"          TEXT;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS "tempMin"                     DOUBLE PRECISION;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS "tempMax"                     DOUBLE PRECISION;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS "atpCertificateNumber"        TEXT;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS "atpCertificateExpiry"        DATE;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS "equipmentDescription"        TEXT;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS "customAttributes"            JSONB;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS "agencyId"                    TEXT;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS "createdById"                 TEXT;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS "updatedById"                 TEXT;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS "deletedAt"                   TIMESTAMP(3);
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS "deletedBy"                   TEXT;


-- ── MAINTENANCE_RECORDS ──────────────────────────────────────────────────────
ALTER TABLE maintenance_records ADD COLUMN IF NOT EXISTS "maintenanceTypeId"   TEXT;
ALTER TABLE maintenance_records ADD COLUMN IF NOT EXISTS "workshopId"          TEXT;
ALTER TABLE maintenance_records ADD COLUMN IF NOT EXISTS "scheduledDate"       DATE;
ALTER TABLE maintenance_records ADD COLUMN IF NOT EXISTS "completedDate"       DATE;
ALTER TABLE maintenance_records ADD COLUMN IF NOT EXISTS "mileageAtService"    INTEGER;
ALTER TABLE maintenance_records ADD COLUMN IF NOT EXISTS "nextServiceDate"     DATE;
ALTER TABLE maintenance_records ADD COLUMN IF NOT EXISTS "nextServiceMileage"  INTEGER;
ALTER TABLE maintenance_records ADD COLUMN IF NOT EXISTS "cost"                DOUBLE PRECISION;
ALTER TABLE maintenance_records ADD COLUMN IF NOT EXISTS "laborCost"           DOUBLE PRECISION;
ALTER TABLE maintenance_records ADD COLUMN IF NOT EXISTS "partsCost"           DOUBLE PRECISION;
ALTER TABLE maintenance_records ADD COLUMN IF NOT EXISTS "description"         TEXT;
ALTER TABLE maintenance_records ADD COLUMN IF NOT EXISTS "technicianName"      TEXT;
ALTER TABLE maintenance_records ADD COLUMN IF NOT EXISTS "invoiceNumber"       TEXT;
ALTER TABLE maintenance_records ADD COLUMN IF NOT EXISTS "notes"               TEXT;
ALTER TABLE maintenance_records ADD COLUMN IF NOT EXISTS "createdById"         TEXT;
ALTER TABLE maintenance_records ADD COLUMN IF NOT EXISTS "updatedById"         TEXT;
ALTER TABLE maintenance_records ADD COLUMN IF NOT EXISTS "deletedAt"           TIMESTAMP(3);
ALTER TABLE maintenance_records ADD COLUMN IF NOT EXISTS "deletedBy"           TEXT;


-- ── WORKSHOPS ────────────────────────────────────────────────────────────────
ALTER TABLE workshops ADD COLUMN IF NOT EXISTS "companyName"                 TEXT;
ALTER TABLE workshops ADD COLUMN IF NOT EXISTS "logo"                        TEXT;
ALTER TABLE workshops ADD COLUMN IF NOT EXISTS "telephone"                   TEXT;
ALTER TABLE workshops ADD COLUMN IF NOT EXISTS "mobile"                      TEXT;
ALTER TABLE workshops ADD COLUMN IF NOT EXISTS "telefax"                     TEXT;
ALTER TABLE workshops ADD COLUMN IF NOT EXISTS "vatNumber"                   TEXT;
ALTER TABLE workshops ADD COLUMN IF NOT EXISTS "businessRegistrationNumber"  TEXT;
ALTER TABLE workshops ADD COLUMN IF NOT EXISTS "contactPersonEmail"          TEXT;
ALTER TABLE workshops ADD COLUMN IF NOT EXISTS "contactPersonPhone"          TEXT;
ALTER TABLE workshops ADD COLUMN IF NOT EXISTS "contactPersonMobile"         TEXT;
ALTER TABLE workshops ADD COLUMN IF NOT EXISTS "contactPersonAddress"        TEXT;
ALTER TABLE workshops ADD COLUMN IF NOT EXISTS "bankName"                    TEXT;
ALTER TABLE workshops ADD COLUMN IF NOT EXISTS "iban"                        TEXT;
ALTER TABLE workshops ADD COLUMN IF NOT EXISTS "swiftBicCode"                TEXT;
ALTER TABLE workshops ADD COLUMN IF NOT EXISTS "establishmentYear"           INTEGER;
ALTER TABLE workshops ADD COLUMN IF NOT EXISTS "specializations"             TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE workshops ADD COLUMN IF NOT EXISTS "status"                      TEXT NOT NULL DEFAULT 'ACTIVE';


-- ── MAINTENANCE_TYPES (table may not exist) ──────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'IntervalMode') THEN
    CREATE TYPE "IntervalMode" AS ENUM ('DAYS', 'KM', 'BOTH');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS maintenance_types (
  "id"                  TEXT PRIMARY KEY,
  "name"                TEXT NOT NULL,
  "description"         TEXT,
  "defaultIntervalDays" INTEGER,
  "defaultIntervalKm"   INTEGER,
  "intervalMode"        "IntervalMode" DEFAULT 'KM',
  "isActive"            BOOLEAN NOT NULL DEFAULT TRUE,
  "deletedAt"           TIMESTAMP(3),
  "deletedBy"           TEXT,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);


-- ── NOTIFICATION_PREFERENCES (table may not exist) ───────────────────────────
CREATE TABLE IF NOT EXISTS notification_preferences (
  "id"                    TEXT PRIMARY KEY,
  "userId"                TEXT NOT NULL UNIQUE,
  "complianceDaysBefore"  INTEGER NOT NULL DEFAULT 30,
  "serviceKmBefore"       INTEGER NOT NULL DEFAULT 500,
  "emailEnabled"          BOOLEAN NOT NULL DEFAULT TRUE,
  "smsEnabled"            BOOLEAN NOT NULL DEFAULT FALSE,
  "inAppEnabled"          BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);


-- ── NOTIFICATIONS extra columns ──────────────────────────────────────────────
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS "severity"     TEXT;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS "daysUntilDue" INTEGER;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS "kmUntilDue"   INTEGER;


-- ── DONE ─────────────────────────────────────────────────────────────────────
-- After running this, restart your Node.js app on the server.
