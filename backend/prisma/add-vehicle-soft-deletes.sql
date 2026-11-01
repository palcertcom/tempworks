-- Add soft-delete columns to vehicle_documents, maintenance_records, maintenance_types
ALTER TABLE "vehicle_documents"    ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);
ALTER TABLE "vehicle_documents"    ADD COLUMN IF NOT EXISTS "deletedBy"  TEXT;
ALTER TABLE "maintenance_records"  ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);
ALTER TABLE "maintenance_records"  ADD COLUMN IF NOT EXISTS "deletedBy"  TEXT;
ALTER TABLE "maintenance_types"    ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);
ALTER TABLE "maintenance_types"    ADD COLUMN IF NOT EXISTS "deletedBy"  TEXT;

ALTER TABLE "workshops"           ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);
ALTER TABLE "workshops"           ADD COLUMN IF NOT EXISTS "deletedBy"  TEXT;

CREATE INDEX IF NOT EXISTS "vehicle_documents_deletedAt_idx"    ON "vehicle_documents"("deletedAt");
CREATE INDEX IF NOT EXISTS "maintenance_records_deletedAt_idx"  ON "maintenance_records"("deletedAt");
CREATE INDEX IF NOT EXISTS "maintenance_types_deletedAt_idx"    ON "maintenance_types"("deletedAt");
CREATE INDEX IF NOT EXISTS "workshops_deletedAt_idx"            ON "workshops"("deletedAt");
