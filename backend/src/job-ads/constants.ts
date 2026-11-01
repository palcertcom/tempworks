// ── Role Groups ───────────────────────────────────────────────────────────────
export const JOB_ADS_READ_ROLES  = ['System Admin', 'HR Manager', 'Recruiter', 'Finance'];
export const JOB_ADS_WRITE_ROLES = ['System Admin', 'HR Manager', 'Recruiter'];
export const JOB_ADS_PUBLISH_ROLES = ['System Admin', 'HR Manager'];

// ── Job Ad Statuses ───────────────────────────────────────────────────────────
export const JOB_AD_STATUSES = ['DRAFT', 'PUBLISHED', 'ARCHIVED'] as const;

// ── Contract Types ────────────────────────────────────────────────────────────
export const CONTRACT_TYPES = [
  'Full-time',
  'Part-time',
  'Contract',
  'Temporary',
  'Internship',
  'Seasonal',
] as const;

// ── Categories ────────────────────────────────────────────────────────────────
export const JOB_CATEGORIES = [
  'Truck Driver',
  'Warehouse Staff',
  'Forklift Operator',
  'Logistics',
  'Construction',
  'Manufacturing',
  'Cleaning',
  'Security',
  'Healthcare',
  'Hospitality',
  'Administrative',
  'Other',
] as const;

// ── Currencies ────────────────────────────────────────────────────────────────
export const COMMON_CURRENCIES = ['GBP', 'EUR', 'USD', 'PLN', 'CZK', 'HUF', 'RON'] as const;
