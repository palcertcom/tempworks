/**
 * Finance module constants.
 *
 * DESIGN DECISION: Transaction types and payment methods are stored as
 * plain strings in the DB (not a lookup/enum table).  This keeps the
 * schema simple and allows the list to be extended without a migration.
 * The canonical lists live here so they are used consistently in DTOs,
 * validation, and the frontend API response.
 */

export const TRANSACTION_TYPES = [
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
] as const;

export type TransactionType = (typeof TRANSACTION_TYPES)[number];

export const PAYMENT_METHODS = [
  'Cash',
  'Bank Transfer',
  'Card',
  'Cheque',
  'Online Transfer',
  'Other',
] as const;

export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const FINANCIAL_RECORD_STATUSES = ['PENDING', 'PARTIAL', 'DEDUCTED'] as const;
export type FinancialRecordStatus = (typeof FINANCIAL_RECORD_STATUSES)[number];

export const COMMON_CURRENCIES = [
  'EUR', 'GBP', 'USD', 'PLN', 'CZK', 'HUF', 'RON', 'BGN', 'HRK',
] as const;

/** Finance roles that can read/write financial data */
export const FINANCE_READ_ROLES = [
  'System Admin', 'HR Manager', 'Finance', 'Recruiter',
];
export const FINANCE_WRITE_ROLES = ['System Admin', 'HR Manager', 'Finance'];
export const FINANCE_STATUS_ROLES = ['System Admin', 'Finance'];
export const FINANCE_EXPORT_ROLES = ['System Admin', 'HR Manager', 'Finance'];
