-- Extend the agencies table with structured contact/HQ fields.
-- All additions are nullable — existing rows keep the legacy
-- `contactPerson`, `country`, `email`, `phone` columns untouched.

ALTER TABLE "agencies"
  ADD COLUMN IF NOT EXISTS "contactFirstName"  text,
  ADD COLUMN IF NOT EXISTS "contactMiddleName" text,
  ADD COLUMN IF NOT EXISTS "contactLastName"   text,
  ADD COLUMN IF NOT EXISTS "whatsapp"          text,
  ADD COLUMN IF NOT EXISTS "website"           text,
  ADD COLUMN IF NOT EXISTS "addressLine1"      text,
  ADD COLUMN IF NOT EXISTS "addressLine2"      text,
  ADD COLUMN IF NOT EXISTS "city"              text,
  ADD COLUMN IF NOT EXISTS "stateRegion"       text,
  ADD COLUMN IF NOT EXISTS "postalCode"        text;
