-- ============================================================
-- Vehicle Management Module - SQL Migration
-- ============================================================

-- Vehicle type enum
DO $$ BEGIN
  CREATE TYPE "VehicleType" AS ENUM (
    'TRUCK', 'CAR', 'VAN', 'TANKER', 'TRAILER', 'REFRIGERATED_TRAILER', 'SPECIALTY'
  );
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Vehicle status enum
DO $$ BEGIN
  CREATE TYPE "VehicleStatus" AS ENUM (
    'ACTIVE', 'INACTIVE', 'IN_MAINTENANCE', 'SCRAPPED'
  );
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Fuel type enum
DO $$ BEGIN
  CREATE TYPE "FuelType" AS ENUM (
    'DIESEL', 'PETROL', 'ELECTRIC', 'HYBRID', 'GAS', 'OTHER'
  );
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Maintenance status enum
DO $$ BEGIN
  CREATE TYPE "MaintenanceStatus" AS ENUM (
    'SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'
  );
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Workshops table
CREATE TABLE IF NOT EXISTS "workshops" (
  "id"          TEXT        NOT NULL,
  "name"        TEXT        NOT NULL,
  "contactName" TEXT,
  "phone"       TEXT,
  "email"       TEXT,
  "address"     TEXT,
  "city"        TEXT,
  "country"     TEXT,
  "notes"       TEXT,
  "isActive"    BOOLEAN     NOT NULL DEFAULT TRUE,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "workshops_pkey" PRIMARY KEY ("id")
);

-- Maintenance types table
CREATE TABLE IF NOT EXISTS "maintenance_types" (
  "id"                  TEXT        NOT NULL,
  "name"                TEXT        NOT NULL,
  "description"         TEXT,
  "defaultIntervalDays" INTEGER,
  "defaultIntervalKm"   INTEGER,
  "isActive"            BOOLEAN     NOT NULL DEFAULT TRUE,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "maintenance_types_pkey" PRIMARY KEY ("id")
);

-- Vehicles table
CREATE TABLE IF NOT EXISTS "vehicles" (
  "id"                  TEXT            NOT NULL,
  "registrationNumber"  TEXT            NOT NULL,
  "type"                "VehicleType"   NOT NULL,
  "status"              "VehicleStatus" NOT NULL DEFAULT 'ACTIVE',
  "make"                TEXT            NOT NULL,
  "model"               TEXT            NOT NULL,
  "year"                INTEGER,
  "color"               TEXT,
  "vin"                 TEXT,
  "fuelType"            "FuelType",
  "currentMileage"      INTEGER,
  "notes"               TEXT,
  "motExpiryDate"       DATE,
  "taxExpiryDate"       DATE,
  "insuranceExpiryDate" DATE,
  "grossWeight"         DOUBLE PRECISION,
  "payloadCapacity"     DOUBLE PRECISION,
  "numberOfAxles"       INTEGER,
  "tankerCapacity"      DOUBLE PRECISION,
  "refrigerationUnit"   TEXT,
  "trailerLength"       DOUBLE PRECISION,
  "agencyId"            TEXT,
  "createdById"         TEXT,
  "updatedById"         TEXT,
  "deletedAt"           TIMESTAMP(3),
  "deletedBy"           TEXT,
  "createdAt"           TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "vehicles_pkey"                   PRIMARY KEY ("id"),
  CONSTRAINT "vehicles_registrationNumber_key" UNIQUE ("registrationNumber"),
  CONSTRAINT "vehicles_vin_key"                UNIQUE ("vin"),
  CONSTRAINT "vehicles_agencyId_fkey"          FOREIGN KEY ("agencyId")    REFERENCES "agencies"("id") ON DELETE SET NULL,
  CONSTRAINT "vehicles_createdById_fkey"       FOREIGN KEY ("createdById") REFERENCES "users"("id")   ON DELETE SET NULL,
  CONSTRAINT "vehicles_updatedById_fkey"       FOREIGN KEY ("updatedById") REFERENCES "users"("id")   ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "vehicles_registrationNumber_idx" ON "vehicles"("registrationNumber");
CREATE INDEX IF NOT EXISTS "vehicles_status_idx"             ON "vehicles"("status");
CREATE INDEX IF NOT EXISTS "vehicles_type_idx"               ON "vehicles"("type");

-- Vehicle driver assignments table
CREATE TABLE IF NOT EXISTS "vehicle_driver_assignments" (
  "id"         TEXT    NOT NULL,
  "vehicleId"  TEXT    NOT NULL,
  "employeeId" TEXT    NOT NULL,
  "startDate"  DATE    NOT NULL,
  "endDate"    DATE,
  "isActive"   BOOLEAN NOT NULL DEFAULT TRUE,
  "notes"      TEXT,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "vehicle_driver_assignments_pkey"        PRIMARY KEY ("id"),
  CONSTRAINT "vehicle_driver_assignments_vehicle_fkey"  FOREIGN KEY ("vehicleId")  REFERENCES "vehicles"("id")   ON DELETE CASCADE,
  CONSTRAINT "vehicle_driver_assignments_employee_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id")  ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "vehicle_driver_assignments_vehicleId_idx"  ON "vehicle_driver_assignments"("vehicleId");
CREATE INDEX IF NOT EXISTS "vehicle_driver_assignments_employeeId_idx" ON "vehicle_driver_assignments"("employeeId");

-- Vehicle documents table
CREATE TABLE IF NOT EXISTS "vehicle_documents" (
  "id"           TEXT NOT NULL,
  "vehicleId"    TEXT NOT NULL,
  "name"         TEXT NOT NULL,
  "documentType" TEXT NOT NULL,
  "fileUrl"      TEXT,
  "fileName"     TEXT,
  "fileSize"     INTEGER,
  "expiryDate"   DATE,
  "issuedDate"   DATE,
  "issuer"       TEXT,
  "notes"        TEXT,
  "uploadedById" TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "vehicle_documents_pkey"        PRIMARY KEY ("id"),
  CONSTRAINT "vehicle_documents_vehicle_fkey"   FOREIGN KEY ("vehicleId")    REFERENCES "vehicles"("id") ON DELETE CASCADE,
  CONSTRAINT "vehicle_documents_uploader_fkey"  FOREIGN KEY ("uploadedById") REFERENCES "users"("id")   ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "vehicle_documents_vehicleId_idx" ON "vehicle_documents"("vehicleId");

-- Maintenance records table
CREATE TABLE IF NOT EXISTS "maintenance_records" (
  "id"                 TEXT                NOT NULL,
  "vehicleId"          TEXT                NOT NULL,
  "maintenanceTypeId"  TEXT,
  "workshopId"         TEXT,
  "status"             "MaintenanceStatus" NOT NULL DEFAULT 'SCHEDULED',
  "scheduledDate"      DATE,
  "completedDate"      DATE,
  "mileageAtService"   INTEGER,
  "nextServiceDate"    DATE,
  "nextServiceMileage" INTEGER,
  "cost"               DOUBLE PRECISION,
  "laborCost"          DOUBLE PRECISION,
  "partsCost"          DOUBLE PRECISION,
  "description"        TEXT,
  "technicianName"     TEXT,
  "invoiceNumber"      TEXT,
  "notes"              TEXT,
  "createdById"        TEXT,
  "updatedById"        TEXT,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "maintenance_records_pkey"            PRIMARY KEY ("id"),
  CONSTRAINT "maintenance_records_vehicle_fkey"    FOREIGN KEY ("vehicleId")         REFERENCES "vehicles"("id")          ON DELETE CASCADE,
  CONSTRAINT "maintenance_records_type_fkey"       FOREIGN KEY ("maintenanceTypeId") REFERENCES "maintenance_types"("id") ON DELETE SET NULL,
  CONSTRAINT "maintenance_records_workshop_fkey"   FOREIGN KEY ("workshopId")        REFERENCES "workshops"("id")         ON DELETE SET NULL,
  CONSTRAINT "maintenance_records_createdBy_fkey"  FOREIGN KEY ("createdById")       REFERENCES "users"("id")             ON DELETE SET NULL,
  CONSTRAINT "maintenance_records_updatedBy_fkey"  FOREIGN KEY ("updatedById")       REFERENCES "users"("id")             ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "maintenance_records_vehicleId_idx"     ON "maintenance_records"("vehicleId");
CREATE INDEX IF NOT EXISTS "maintenance_records_status_idx"        ON "maintenance_records"("status");
CREATE INDEX IF NOT EXISTS "maintenance_records_scheduledDate_idx" ON "maintenance_records"("scheduledDate");

-- Maintenance spare parts table
CREATE TABLE IF NOT EXISTS "maintenance_record_spare_parts" (
  "id"                  TEXT    NOT NULL,
  "maintenanceRecordId" TEXT    NOT NULL,
  "partName"            TEXT    NOT NULL,
  "partNumber"          TEXT,
  "quantity"            INTEGER NOT NULL DEFAULT 1,
  "unitCost"            DOUBLE PRECISION,
  "totalCost"           DOUBLE PRECISION,
  "supplier"            TEXT,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "maintenance_record_spare_parts_pkey"   PRIMARY KEY ("id"),
  CONSTRAINT "maintenance_spare_parts_record_fkey"   FOREIGN KEY ("maintenanceRecordId") REFERENCES "maintenance_records"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "maintenance_record_spare_parts_recordId_idx" ON "maintenance_record_spare_parts"("maintenanceRecordId");
