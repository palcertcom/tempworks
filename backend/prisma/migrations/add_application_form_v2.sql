-- Migration: Application Form v2
-- Adds new applicant fields for the redesigned 11-tab application form.
-- Run with: psql $DATABASE_URL -f this_file.sql
-- All operations are idempotent (IF NOT EXISTS / DO NOTHING).

-- 1. Gender enum
DO $$ BEGIN
  CREATE TYPE "Gender" AS ENUM ('MALE', 'FEMALE', 'OTHER', 'PREFER_NOT_TO_SAY');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 2. New columns on applicants table
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "middleName"         TEXT;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "citizenship"        TEXT;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "gender"             "Gender";
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "countryOfBirth"     TEXT;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "cityOfBirth"        TEXT;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "photoUrl"           TEXT;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "hasDrivingLicense"  BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "applicationData"    JSONB;

-- Make formerly required columns optional for backward compat
ALTER TABLE applicants ALTER COLUMN "residencyStatus" DROP NOT NULL;
ALTER TABLE applicants ALTER COLUMN "availability"    DROP NOT NULL;

-- 3. New configurable settings
INSERT INTO system_settings (id, key, value, description, category, "isPublic", "updatedAt")
SELECT gen_random_uuid()::text, t.key, t.value, t.description, t.category, TRUE, NOW()
FROM (VALUES
  ('form.visaTypes',
   '["Tourist","Business","Work","Student","Transit","Family Reunification","Schengen","Long-stay","Other"]',
   'Visa types available in the application form',
   'form'),
  ('form.familyRelations',
   '["Spouse","Partner","Parent","Child","Sibling","Friend","Colleague","Other"]',
   'Family/emergency contact relation options',
   'form'),
  ('form.drivingQualifications',
   '["Tachograph Card","C95 / CPC Card","ADR Certificate","Medical Certificate","DVLA Check","Transport Manager CPC"]',
   'Driving qualification types shown in the application form',
   'form'),
  ('form.gpsSystemTypes',
   '["TomTom","Garmin","Webfleet","Sygic","HERE","Google Maps","Other"]',
   'GPS/Navigation system types for driving experience section',
   'form'),
  ('form.howDidYouHear',
   '["Facebook","LinkedIn","Job Portal","Friend / Referral","Recruitment Agency","Google Search","Company Website","Other"]',
   'How did you hear about us options',
   'form'),
  ('form.declarationText',
   'I declare that the information provided in this application is true, complete and accurate to the best of my knowledge. I understand that providing false or misleading information may result in my application being rejected or employment being terminated.',
   'Applicant declaration text shown on the Review step',
   'form'),
  ('form.educationLevels',
   '["Primary School","Secondary School","High School / A-Levels","Vocational Training","Associate Degree","Bachelor''s Degree","Master''s Degree","Doctoral Degree","Professional Certification","Other"]',
   'Education level options in the Education tab',
   'form')
) AS t(key, value, description, category)
WHERE NOT EXISTS (SELECT 1 FROM system_settings s WHERE s.key = t.key);
