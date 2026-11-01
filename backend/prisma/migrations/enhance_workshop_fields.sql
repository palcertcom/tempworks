-- Enhance workshops table with comprehensive fields for workshop management

-- Add missing columns to workshops table
DO $$
BEGIN
  -- Company/Organization fields
  IF NOT EXISTS (
    SELECT FROM information_schema.columns
    WHERE table_name = 'workshops' AND column_name = 'companyName'
  ) THEN
    ALTER TABLE "workshops" ADD COLUMN "companyName" TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT FROM information_schema.columns
    WHERE table_name = 'workshops' AND column_name = 'logo'
  ) THEN
    ALTER TABLE "workshops" ADD COLUMN "logo" TEXT;
  END IF;

  -- Contact details
  IF NOT EXISTS (
    SELECT FROM information_schema.columns
    WHERE table_name = 'workshops' AND column_name = 'telephone'
  ) THEN
    ALTER TABLE "workshops" ADD COLUMN "telephone" TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT FROM information_schema.columns
    WHERE table_name = 'workshops' AND column_name = 'mobile'
  ) THEN
    ALTER TABLE "workshops" ADD COLUMN "mobile" TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT FROM information_schema.columns
    WHERE table_name = 'workshops' AND column_name = 'telefax'
  ) THEN
    ALTER TABLE "workshops" ADD COLUMN "telefax" TEXT;
  END IF;

  -- Tax/Registration identifiers
  IF NOT EXISTS (
    SELECT FROM information_schema.columns
    WHERE table_name = 'workshops' AND column_name = 'vatNumber'
  ) THEN
    ALTER TABLE "workshops" ADD COLUMN "vatNumber" TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT FROM information_schema.columns
    WHERE table_name = 'workshops' AND column_name = 'businessRegistrationNumber'
  ) THEN
    ALTER TABLE "workshops" ADD COLUMN "businessRegistrationNumber" TEXT;
  END IF;

  -- Contact person fields
  IF NOT EXISTS (
    SELECT FROM information_schema.columns
    WHERE table_name = 'workshops' AND column_name = 'contactPersonEmail'
  ) THEN
    ALTER TABLE "workshops" ADD COLUMN "contactPersonEmail" TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT FROM information_schema.columns
    WHERE table_name = 'workshops' AND column_name = 'contactPersonPhone'
  ) THEN
    ALTER TABLE "workshops" ADD COLUMN "contactPersonPhone" TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT FROM information_schema.columns
    WHERE table_name = 'workshops' AND column_name = 'contactPersonMobile'
  ) THEN
    ALTER TABLE "workshops" ADD COLUMN "contactPersonMobile" TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT FROM information_schema.columns
    WHERE table_name = 'workshops' AND column_name = 'contactPersonAddress'
  ) THEN
    ALTER TABLE "workshops" ADD COLUMN "contactPersonAddress" TEXT;
  END IF;

  -- Banking details
  IF NOT EXISTS (
    SELECT FROM information_schema.columns
    WHERE table_name = 'workshops' AND column_name = 'bankName'
  ) THEN
    ALTER TABLE "workshops" ADD COLUMN "bankName" TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT FROM information_schema.columns
    WHERE table_name = 'workshops' AND column_name = 'iban'
  ) THEN
    ALTER TABLE "workshops" ADD COLUMN "iban" TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT FROM information_schema.columns
    WHERE table_name = 'workshops' AND column_name = 'swiftBicCode'
  ) THEN
    ALTER TABLE "workshops" ADD COLUMN "swiftBicCode" TEXT;
  END IF;

  -- Business information
  IF NOT EXISTS (
    SELECT FROM information_schema.columns
    WHERE table_name = 'workshops' AND column_name = 'establishmentYear'
  ) THEN
    ALTER TABLE "workshops" ADD COLUMN "establishmentYear" INTEGER;
  END IF;

  IF NOT EXISTS (
    SELECT FROM information_schema.columns
    WHERE table_name = 'workshops' AND column_name = 'specializations'
  ) THEN
    ALTER TABLE "workshops" ADD COLUMN "specializations" TEXT[];
  END IF;

  IF NOT EXISTS (
    SELECT FROM information_schema.columns
    WHERE table_name = 'workshops' AND column_name = 'status'
  ) THEN
    ALTER TABLE "workshops" ADD COLUMN "status" TEXT DEFAULT 'ACTIVE';
  END IF;

END $$;

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS "workshops_companyName_idx" ON "workshops"("companyName");
CREATE INDEX IF NOT EXISTS "workshops_vatNumber_idx" ON "workshops"("vatNumber");
CREATE INDEX IF NOT EXISTS "workshops_businessRegistrationNumber_idx" ON "workshops"("businessRegistrationNumber");
CREATE INDEX IF NOT EXISTS "workshops_status_idx" ON "workshops"("status");
CREATE INDEX IF NOT EXISTS "workshops_email_idx" ON "workshops"("email");
