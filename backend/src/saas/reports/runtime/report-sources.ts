/**
 * Phase 2.1 — Tenant-Safe Report Source Registry.
 *
 * Maps every legacy `SOURCE_DEFS` entry to a tenant-safe definition.
 * Each entry must declare a `tenantColumn`. Multi-table sources must
 * declare joins whose `on` clause equates `tenant_id`.
 *
 * Sources that cannot be mapped (e.g. an entity-keyed model whose
 * `tenantId` denorm hasn't been backfilled yet) are marked DISABLED
 * with a reason. The boot validator skips DISABLED sources.
 *
 * The legacy registry in `backend/src/reports/reports.service.ts`
 * remains the LIVE source until `TENANT_SAFE_REPORTS_ENABLED=true`.
 */
import { SourceDef } from '../source-def.types';

/** Convenience: the same field map used by both engines.
 *  Phase 3 Reports Hardening — Phase D (#19): the raw UUID `id` columns
 *  are flagged `hideByDefault` so the column picker hides them from
 *  business users; the assigned business identifiers (employeeNumber,
 *  candidateNumber, leadNumber, docId) are auto-selected via the
 *  source's `defaultColumns`. */
const employeeFields: SourceDef['fields'] = {
  id:              { alias: 'e', dbCol: 'id',              type: 'uuid',   label: 'ID', hideByDefault: true },
  employeeNumber:  { alias: 'e', dbCol: 'employeeNumber',  type: 'string', label: 'Employee #' },
  leadNumber:      { alias: 'e', dbCol: 'leadNumber',      type: 'string', label: 'Lead #' },
  candidateNumber: { alias: 'e', dbCol: 'candidateNumber', type: 'string', label: 'Candidate #' },
  firstName:       { alias: 'e', dbCol: 'firstName',       type: 'string', label: 'First Name' },
  lastName:        { alias: 'e', dbCol: 'lastName',        type: 'string', label: 'Last Name' },
  email:           { alias: 'e', dbCol: 'email',           type: 'string', label: 'Email' },
  phone:           { alias: 'e', dbCol: 'phone',           type: 'string', label: 'Phone' },
  nationality:     { alias: 'e', dbCol: 'nationality',     type: 'string', label: 'Nationality' },
  status:          { alias: 'e', dbCol: 'status',          type: 'enum',   label: 'Status' },
  dateOfBirth:     { alias: 'e', dbCol: 'dateOfBirth',     type: 'date',   label: 'Date of Birth' },
  licenseNumber:   { alias: 'e', dbCol: 'licenseNumber',   type: 'string', label: 'License No.' },
  licenseCategory: { alias: 'e', dbCol: 'licenseCategory', type: 'string', label: 'License Category' },
  yearsExperience: { alias: 'e', dbCol: 'yearsExperience', type: 'number', label: 'Years Exp.' },
  city:            { alias: 'e', dbCol: 'city',            type: 'string', label: 'City' },
  country:         { alias: 'e', dbCol: 'country',         type: 'string', label: 'Country' },
  createdAt:       { alias: 'e', dbCol: 'createdAt',       type: 'date',   label: 'Created At' },
};

const applicantFields: SourceDef['fields'] = {
  id:                   { alias: 'ap', dbCol: 'id',                   type: 'uuid',    label: 'ID', hideByDefault: true },
  // Lead / Candidate are the two active tiers of an Applicant. Both
  // numbers can be populated on the same row after promotion; the
  // column picker defaults to including both so the report shows
  // whichever is active without an in-SQL COALESCE (kept simple to
  // avoid extending the legacy composer in Phase D).
  leadNumber:           { alias: 'ap', dbCol: 'leadNumber',           type: 'string',  label: 'Lead #' },
  candidateNumber:      { alias: 'ap', dbCol: 'candidateNumber',      type: 'string',  label: 'Candidate #' },
  firstName:            { alias: 'ap', dbCol: 'firstName',            type: 'string',  label: 'First Name' },
  lastName:             { alias: 'ap', dbCol: 'lastName',             type: 'string',  label: 'Last Name' },
  email:                { alias: 'ap', dbCol: 'email',                type: 'string',  label: 'Email' },
  phone:                { alias: 'ap', dbCol: 'phone',                type: 'string',  label: 'Phone' },
  nationality:          { alias: 'ap', dbCol: 'nationality',          type: 'string',  label: 'Nationality' },
  status:               { alias: 'ap', dbCol: 'status',               type: 'enum',    label: 'Status' },
  tier:                 { alias: 'ap', dbCol: 'tier',                 type: 'enum',    label: 'Tier' },
  residencyStatus:      { alias: 'ap', dbCol: 'residencyStatus',      type: 'string',  label: 'Residency' },
  hasWorkAuthorization: { alias: 'ap', dbCol: 'hasWorkAuthorization', type: 'boolean', label: 'Work Auth' },
  availability:         { alias: 'ap', dbCol: 'availability',         type: 'string',  label: 'Availability' },
  salaryExpectation:    { alias: 'ap', dbCol: 'salaryExpectation',    type: 'string',  label: 'Salary Exp.' },
  willingToRelocate:    { alias: 'ap', dbCol: 'willingToRelocate',    type: 'boolean', label: 'Relocate' },
  createdAt:            { alias: 'ap', dbCol: 'createdAt',            type: 'date',    label: 'Created At' },
};

const agencyFields: SourceDef['fields'] = {
  id:            { alias: 'ag', dbCol: 'id',            type: 'uuid',   label: 'ID', hideByDefault: true },
  name:          { alias: 'ag', dbCol: 'name',          type: 'string', label: 'Name' },
  country:       { alias: 'ag', dbCol: 'country',       type: 'string', label: 'Country' },
  email:         { alias: 'ag', dbCol: 'email',         type: 'string', label: 'Email' },
  phone:         { alias: 'ag', dbCol: 'phone',         type: 'string', label: 'Phone' },
  status:        { alias: 'ag', dbCol: 'status',        type: 'enum',   label: 'Status' },
  createdAt:     { alias: 'ag', dbCol: 'createdAt',     type: 'date',   label: 'Created At' },
};

/**
 * Per-source readiness for the tenant-safe runtime.
 *   READY     — boot validator accepts; engine will execute
 *   DISABLED  — engine refuses to run; reason exposed to operator
 */
export type SourceStatus = 'READY' | 'DISABLED';

export interface MappedSource {
  status: SourceStatus;
  reason?: string;
  /** When READY, the validated SourceDef. When DISABLED, undefined. */
  def?: SourceDef;
}

const READY = (def: SourceDef): MappedSource => ({ status: 'READY', def });
const DISABLED = (reason: string): MappedSource => ({ status: 'DISABLED', reason });

/**
 * Phase 2.1 mapping — only the simple, safe-to-migrate sources are READY.
 *
 * Multi-table and entity-keyed sources are DISABLED until the Phase 2
 * backfill writes the parent-derived `tenantId` column.  Operators
 * still get a "source not available in tenant-safe mode" response;
 * the legacy engine continues to handle those sources.
 */
export const TENANT_SAFE_SOURCES: Record<string, MappedSource> = {
  // ─── Single-table, primary-table-has-tenantId ────────────────────────────
  employees: READY({
    key: 'employees',
    label: 'Employees',
    group: 'single',
    tables: ['employees'],
    primaryTable: 'employees',
    primaryAlias: 'e',
    softDelete: true,
    tenantColumn: 'tenantId',
    agencyColumn: 'agencyId',
    tenantAwareJoins: [],
    fields: employeeFields,
    // Phase 3 Reports Hardening — Phase D: default to business
    // identifiers, never the raw UUID.
    defaultColumns: ['employeeNumber', 'firstName', 'lastName', 'email', 'status'],
  }),

  applicants: READY({
    key: 'applicants',
    label: 'Applicants',
    group: 'single',
    tables: ['applicants'],
    primaryTable: 'applicants',
    primaryAlias: 'ap',
    softDelete: true,
    tenantColumn: 'tenantId',
    agencyColumn: 'agencyId',
    tenantAwareJoins: [],
    fields: applicantFields,
    // Both numbers default-included so the report shows whichever
    // tier the row is in without an in-SQL COALESCE.
    defaultColumns: ['candidateNumber', 'leadNumber', 'firstName', 'lastName', 'tier', 'status'],
  }),

  agencies: READY({
    key: 'agencies',
    label: 'Agencies',
    group: 'single',
    tables: ['agencies'],
    primaryTable: 'agencies',
    primaryAlias: 'ag',
    // The agencies table doesn't carry a soft-delete column; the legacy
    // engine likewise omits it.
    softDelete: false,
    tenantColumn: 'tenantId',
    // Self-scope: the row IS the agency, so agencyColumn = id.
    agencyColumn: 'id',
    tenantAwareJoins: [],
    fields: agencyFields,
    defaultColumns: ['name', 'country', 'email', 'phone', 'status'],
  }),

  // ─── READY (Phase 2.3): single-table entity-keyed, denorm now available ─
  documents: READY({
    key: 'documents',
    label: 'Documents',
    group: 'single',
    tables: ['documents'],
    primaryTable: 'documents',
    primaryAlias: 'doc',
    softDelete: true,
    tenantColumn: 'tenantId',
    agencyColumn: null,                 // documents are entity-keyed; agency scope through parent
    tenantAwareJoins: [],
    fields: {
      id:             { alias: 'doc', dbCol: 'id',             type: 'uuid',   label: 'ID', hideByDefault: true },
      // Phase 3 Reports Hardening — Phase D: `docId` is the canonical
      // business identifier (DOCC20260400001PASS001 shape), distinct
      // from `documentNumber` which is the issuer's number on the
      // physical document.
      docId:          { alias: 'doc', dbCol: 'docId',          type: 'string', label: 'Doc ID' },
      name:           { alias: 'doc', dbCol: 'name',           type: 'string', label: 'Name' },
      entityType:     { alias: 'doc', dbCol: 'entityType',     type: 'enum',   label: 'Entity Type' },
      status:         { alias: 'doc', dbCol: 'status',         type: 'enum',   label: 'Status' },
      fileSize:       { alias: 'doc', dbCol: 'fileSize',       type: 'number', label: 'Size (bytes)' },
      issueDate:      { alias: 'doc', dbCol: 'issueDate',      type: 'date',   label: 'Issue Date' },
      expiryDate:     { alias: 'doc', dbCol: 'expiryDate',     type: 'date',   label: 'Expiry Date' },
      issuer:         { alias: 'doc', dbCol: 'issuer',         type: 'string', label: 'Issuer' },
      documentNumber: { alias: 'doc', dbCol: 'documentNumber', type: 'string', label: 'Doc No.' },
      createdAt:      { alias: 'doc', dbCol: 'createdAt',      type: 'date',   label: 'Created At' },
    },
    defaultColumns: ['docId', 'name', 'entityType', 'documentNumber', 'status', 'expiryDate'],
  }),

  compliance_alerts: READY({
    key: 'compliance_alerts',
    label: 'Compliance Alerts',
    group: 'single',
    tables: ['compliance_alerts'],
    primaryTable: 'compliance_alerts',
    primaryAlias: 'ca',
    softDelete: false,
    tenantColumn: 'tenantId',
    agencyColumn: null,
    tenantAwareJoins: [],
    fields: {
      id:         { alias: 'ca', dbCol: 'id',         type: 'uuid',   label: 'ID' },
      entityType: { alias: 'ca', dbCol: 'entityType', type: 'enum',   label: 'Entity Type' },
      alertType:  { alias: 'ca', dbCol: 'alertType',  type: 'string', label: 'Alert Type' },
      severity:   { alias: 'ca', dbCol: 'severity',   type: 'enum',   label: 'Severity' },
      message:    { alias: 'ca', dbCol: 'message',    type: 'string', label: 'Message' },
      status:     { alias: 'ca', dbCol: 'status',     type: 'enum',   label: 'Status' },
      dueDate:    { alias: 'ca', dbCol: 'dueDate',    type: 'date',   label: 'Due Date' },
      createdAt:  { alias: 'ca', dbCol: 'createdAt',  type: 'date',   label: 'Created At' },
    },
  }),

  work_permits: READY({
    key: 'work_permits',
    label: 'Work Permits',
    group: 'single',
    tables: ['work_permits'],
    primaryTable: 'work_permits',
    primaryAlias: 'wp',
    softDelete: false,
    tenantColumn: 'tenantId',
    agencyColumn: null,                 // permits are per-employee; agency scope via Employee
    tenantAwareJoins: [],
    fields: {
      id:              { alias: 'wp', dbCol: 'id',              type: 'uuid',   label: 'ID' },
      permitType:      { alias: 'wp', dbCol: 'permitType',      type: 'string', label: 'Permit Type' },
      status:          { alias: 'wp', dbCol: 'status',          type: 'enum',   label: 'Status' },
      permitNumber:    { alias: 'wp', dbCol: 'permitNumber',    type: 'string', label: 'Permit No.' },
      applicationDate: { alias: 'wp', dbCol: 'applicationDate', type: 'date',   label: 'Applied' },
      approvalDate:    { alias: 'wp', dbCol: 'approvalDate',    type: 'date',   label: 'Approved' },
      expiryDate:      { alias: 'wp', dbCol: 'expiryDate',      type: 'date',   label: 'Expiry' },
      createdAt:       { alias: 'wp', dbCol: 'createdAt',       type: 'date',   label: 'Created At' },
    },
  }),

  visas: READY({
    key: 'visas',
    label: 'Visas',
    group: 'single',
    tables: ['visas'],
    primaryTable: 'visas',
    primaryAlias: 'v',
    softDelete: false,
    tenantColumn: 'tenantId',
    agencyColumn: null,
    tenantAwareJoins: [],
    fields: {
      id:              { alias: 'v', dbCol: 'id',              type: 'uuid',   label: 'ID' },
      entityType:      { alias: 'v', dbCol: 'entityType',      type: 'enum',   label: 'Entity Type' },
      entityId:        { alias: 'v', dbCol: 'entityId',        type: 'string', label: 'Entity ID' },
      visaType:        { alias: 'v', dbCol: 'visaType',        type: 'string', label: 'Visa Type' },
      status:          { alias: 'v', dbCol: 'status',          type: 'enum',   label: 'Status' },
      visaNumber:      { alias: 'v', dbCol: 'visaNumber',      type: 'string', label: 'Visa Number' },
      applicationDate: { alias: 'v', dbCol: 'applicationDate', type: 'date',   label: 'Applied' },
      appointmentDate: { alias: 'v', dbCol: 'appointmentDate', type: 'date',   label: 'Appointment' },
      approvalDate:    { alias: 'v', dbCol: 'approvalDate',    type: 'date',   label: 'Approved' },
      expiryDate:      { alias: 'v', dbCol: 'expiryDate',      type: 'date',   label: 'Expiry' },
      embassy:         { alias: 'v', dbCol: 'embassy',         type: 'string', label: 'Embassy' },
      createdAt:       { alias: 'v', dbCol: 'createdAt',       type: 'date',   label: 'Created At' },
    },
  }),

  // ─── DISABLED: catalog accessed only through join sources ─────────────
  // `document_types` is a global catalog (no tenantId). It is accessible
  // for SELECT-style reporting via `documents_with_type` and
  // `employees_documents_type` using `kind: 'catalog'` joins. Exposing
  // it as a stand-alone source would let any tenant member enumerate
  // catalog rows — fine in principle, but Phase 2.4 keeps it behind the
  // joined sources until a product decision is made on direct exposure.
  // See `SAAS_PHASE2_CATALOG_SOURCES_DECISION.md`.
  document_types:    DISABLED('Phase 2.4 — global catalog; reachable via joined sources (documents_with_type, employees_documents_type) using kind=catalog. Direct exposure pending product decision.'),

  // ─── READY (Phase 2.4): tenant-safe joined sources ────────────────────
  employees_documents: READY({
    key: 'employees_documents',
    label: 'Employees + Documents',
    group: 'combined',
    tables: ['employees', 'documents'],
    primaryTable: 'employees',
    primaryAlias: 'e',
    softDelete: true,
    tenantColumn: 'tenantId',
    agencyColumn: 'agencyId',
    tenantAwareJoins: [{
      joinType: 'LEFT',
      table: 'documents',
      alias: 'd',
      structuredOn: {
        fk:     { leftAlias: 'e', leftCol: 'id',       rightAlias: 'd', rightCol: 'entityId' },
        tenant: { leftAlias: 'e', leftCol: 'tenantId', rightAlias: 'd', rightCol: 'tenantId' },
        literals: [{ alias: 'd', col: 'entityType', literal: 'EMPLOYEE' }],
        nullChecks: [{ alias: 'd', col: 'deletedAt' }],
      },
    }],
    fields: {
      empId:           { alias: 'e', dbCol: 'id',             type: 'string', label: 'Employee ID' },
      empFirstName:    { alias: 'e', dbCol: 'firstName',      type: 'string', label: 'First Name' },
      empLastName:     { alias: 'e', dbCol: 'lastName',       type: 'string', label: 'Last Name' },
      empEmail:        { alias: 'e', dbCol: 'email',          type: 'string', label: 'Email' },
      empNationality:  { alias: 'e', dbCol: 'nationality',    type: 'string', label: 'Nationality' },
      empStatus:       { alias: 'e', dbCol: 'status',         type: 'enum',   label: 'Employee Status' },
      empCountry:      { alias: 'e', dbCol: 'country',        type: 'string', label: 'Country' },
      docName:         { alias: 'd', dbCol: 'name',           type: 'string', label: 'Document Name' },
      docNumber:       { alias: 'd', dbCol: 'documentNumber', type: 'string', label: 'Doc Number' },
      docStatus:       { alias: 'd', dbCol: 'status',         type: 'enum',   label: 'Doc Status' },
      docIssueDate:    { alias: 'd', dbCol: 'issueDate',      type: 'date',   label: 'Doc Issue Date' },
      docExpiryDate:   { alias: 'd', dbCol: 'expiryDate',     type: 'date',   label: 'Doc Expiry' },
      docIssuer:       { alias: 'd', dbCol: 'issuer',         type: 'string', label: 'Doc Issuer' },
      docCreatedAt:    { alias: 'd', dbCol: 'createdAt',      type: 'date',   label: 'Doc Created At' },
    },
    defaultSort: { field: 'empLastName', direction: 'ASC' },
  }),

  employees_work_permits: READY({
    key: 'employees_work_permits',
    label: 'Employees + Work Permits',
    group: 'combined',
    tables: ['employees', 'work_permits'],
    primaryTable: 'employees',
    primaryAlias: 'e',
    softDelete: true,
    tenantColumn: 'tenantId',
    agencyColumn: 'agencyId',
    tenantAwareJoins: [{
      joinType: 'LEFT',
      table: 'work_permits',
      alias: 'wp',
      structuredOn: {
        fk:     { leftAlias: 'e', leftCol: 'id',       rightAlias: 'wp', rightCol: 'employeeId' },
        tenant: { leftAlias: 'e', leftCol: 'tenantId', rightAlias: 'wp', rightCol: 'tenantId' },
      },
    }],
    fields: {
      empId:           { alias: 'e',  dbCol: 'id',              type: 'string', label: 'Employee ID' },
      empFirstName:    { alias: 'e',  dbCol: 'firstName',       type: 'string', label: 'First Name' },
      empLastName:     { alias: 'e',  dbCol: 'lastName',        type: 'string', label: 'Last Name' },
      empEmail:        { alias: 'e',  dbCol: 'email',           type: 'string', label: 'Email' },
      empNationality:  { alias: 'e',  dbCol: 'nationality',     type: 'string', label: 'Nationality' },
      empStatus:       { alias: 'e',  dbCol: 'status',          type: 'enum',   label: 'Employee Status' },
      empCountry:      { alias: 'e',  dbCol: 'country',         type: 'string', label: 'Country' },
      wpPermitType:    { alias: 'wp', dbCol: 'permitType',      type: 'string', label: 'Permit Type' },
      wpStatus:        { alias: 'wp', dbCol: 'status',          type: 'enum',   label: 'Permit Status' },
      wpNumber:        { alias: 'wp', dbCol: 'permitNumber',    type: 'string', label: 'Permit No.' },
      wpAppliedDate:   { alias: 'wp', dbCol: 'applicationDate', type: 'date',   label: 'Applied Date' },
      wpApprovedDate:  { alias: 'wp', dbCol: 'approvalDate',    type: 'date',   label: 'Approval Date' },
      wpExpiryDate:    { alias: 'wp', dbCol: 'expiryDate',      type: 'date',   label: 'Permit Expiry' },
    },
  }),

  employees_compliance: READY({
    key: 'employees_compliance',
    label: 'Employees + Compliance Alerts',
    group: 'combined',
    tables: ['employees', 'compliance_alerts'],
    primaryTable: 'employees',
    primaryAlias: 'e',
    softDelete: true,
    tenantColumn: 'tenantId',
    agencyColumn: 'agencyId',
    tenantAwareJoins: [{
      joinType: 'LEFT',
      table: 'compliance_alerts',
      alias: 'ca',
      structuredOn: {
        fk:     { leftAlias: 'e', leftCol: 'id',       rightAlias: 'ca', rightCol: 'entityId' },
        tenant: { leftAlias: 'e', leftCol: 'tenantId', rightAlias: 'ca', rightCol: 'tenantId' },
        literals: [{ alias: 'ca', col: 'entityType', literal: 'EMPLOYEE' }],
      },
    }],
    fields: {
      empId:          { alias: 'e',  dbCol: 'id',          type: 'string', label: 'Employee ID' },
      empFirstName:   { alias: 'e',  dbCol: 'firstName',   type: 'string', label: 'First Name' },
      empLastName:    { alias: 'e',  dbCol: 'lastName',    type: 'string', label: 'Last Name' },
      empEmail:       { alias: 'e',  dbCol: 'email',       type: 'string', label: 'Email' },
      empNationality: { alias: 'e',  dbCol: 'nationality', type: 'string', label: 'Nationality' },
      empStatus:      { alias: 'e',  dbCol: 'status',      type: 'enum',   label: 'Employee Status' },
      caAlertType:    { alias: 'ca', dbCol: 'alertType',   type: 'string', label: 'Alert Type' },
      caSeverity:     { alias: 'ca', dbCol: 'severity',    type: 'enum',   label: 'Severity' },
      caMessage:      { alias: 'ca', dbCol: 'message',     type: 'string', label: 'Alert Message' },
      caStatus:       { alias: 'ca', dbCol: 'status',      type: 'enum',   label: 'Alert Status' },
      caDueDate:      { alias: 'ca', dbCol: 'dueDate',     type: 'date',   label: 'Due Date' },
      caCreatedAt:    { alias: 'ca', dbCol: 'createdAt',   type: 'date',   label: 'Alert Date' },
    },
  }),

  applicants_documents: READY({
    key: 'applicants_documents',
    label: 'Applicants + Documents',
    group: 'combined',
    tables: ['applicants', 'documents'],
    primaryTable: 'applicants',
    primaryAlias: 'ap',
    softDelete: true,
    tenantColumn: 'tenantId',
    agencyColumn: 'agencyId',
    tenantAwareJoins: [{
      joinType: 'LEFT',
      table: 'documents',
      alias: 'd',
      structuredOn: {
        fk:     { leftAlias: 'ap', leftCol: 'id',       rightAlias: 'd', rightCol: 'entityId' },
        tenant: { leftAlias: 'ap', leftCol: 'tenantId', rightAlias: 'd', rightCol: 'tenantId' },
        literals: [{ alias: 'd', col: 'entityType', literal: 'APPLICANT' }],
        nullChecks: [{ alias: 'd', col: 'deletedAt' }],
      },
    }],
    fields: {
      apId:           { alias: 'ap', dbCol: 'id',                  type: 'string',  label: 'Applicant ID' },
      apFirstName:    { alias: 'ap', dbCol: 'firstName',           type: 'string',  label: 'First Name' },
      apLastName:     { alias: 'ap', dbCol: 'lastName',            type: 'string',  label: 'Last Name' },
      apEmail:        { alias: 'ap', dbCol: 'email',               type: 'string',  label: 'Email' },
      apNationality:  { alias: 'ap', dbCol: 'nationality',         type: 'string',  label: 'Nationality' },
      apStatus:       { alias: 'ap', dbCol: 'status',              type: 'enum',    label: 'Applicant Status' },
      apResidency:    { alias: 'ap', dbCol: 'residencyStatus',     type: 'string',  label: 'Residency' },
      apWorkAuth:     { alias: 'ap', dbCol: 'hasWorkAuthorization', type: 'boolean', label: 'Work Auth' },
      apCreatedAt:    { alias: 'ap', dbCol: 'createdAt',           type: 'date',    label: 'Applied At' },
      docName:        { alias: 'd',  dbCol: 'name',                type: 'string',  label: 'Document Name' },
      docNumber:      { alias: 'd',  dbCol: 'documentNumber',      type: 'string',  label: 'Doc Number' },
      docStatus:      { alias: 'd',  dbCol: 'status',              type: 'enum',    label: 'Doc Status' },
      docExpiryDate:  { alias: 'd',  dbCol: 'expiryDate',          type: 'date',    label: 'Doc Expiry' },
    },
  }),

  applicants_compliance: READY({
    key: 'applicants_compliance',
    label: 'Applicants + Compliance Alerts',
    group: 'combined',
    tables: ['applicants', 'compliance_alerts'],
    primaryTable: 'applicants',
    primaryAlias: 'ap',
    softDelete: true,
    tenantColumn: 'tenantId',
    agencyColumn: 'agencyId',
    tenantAwareJoins: [{
      joinType: 'LEFT',
      table: 'compliance_alerts',
      alias: 'ca',
      structuredOn: {
        fk:     { leftAlias: 'ap', leftCol: 'id',       rightAlias: 'ca', rightCol: 'entityId' },
        tenant: { leftAlias: 'ap', leftCol: 'tenantId', rightAlias: 'ca', rightCol: 'tenantId' },
        literals: [{ alias: 'ca', col: 'entityType', literal: 'APPLICANT' }],
      },
    }],
    fields: {
      apId:           { alias: 'ap', dbCol: 'id',          type: 'string', label: 'Applicant ID' },
      apFirstName:    { alias: 'ap', dbCol: 'firstName',   type: 'string', label: 'First Name' },
      apLastName:     { alias: 'ap', dbCol: 'lastName',    type: 'string', label: 'Last Name' },
      apEmail:        { alias: 'ap', dbCol: 'email',       type: 'string', label: 'Email' },
      apNationality:  { alias: 'ap', dbCol: 'nationality', type: 'string', label: 'Nationality' },
      apStatus:       { alias: 'ap', dbCol: 'status',      type: 'enum',   label: 'Applicant Status' },
      caAlertType:    { alias: 'ca', dbCol: 'alertType',   type: 'string', label: 'Alert Type' },
      caSeverity:     { alias: 'ca', dbCol: 'severity',    type: 'enum',   label: 'Severity' },
      caMessage:      { alias: 'ca', dbCol: 'message',     type: 'string', label: 'Alert Message' },
      caStatus:       { alias: 'ca', dbCol: 'status',      type: 'enum',   label: 'Alert Status' },
      caDueDate:      { alias: 'ca', dbCol: 'dueDate',     type: 'date',   label: 'Due Date' },
    },
  }),

  employees_visas: READY({
    key: 'employees_visas',
    label: 'Employees + Visas',
    group: 'combined',
    tables: ['employees', 'visas'],
    primaryTable: 'employees',
    primaryAlias: 'e',
    softDelete: true,
    tenantColumn: 'tenantId',
    agencyColumn: 'agencyId',
    tenantAwareJoins: [{
      joinType: 'LEFT',
      table: 'visas',
      alias: 'v',
      structuredOn: {
        fk:     { leftAlias: 'e', leftCol: 'id',       rightAlias: 'v', rightCol: 'entityId' },
        tenant: { leftAlias: 'e', leftCol: 'tenantId', rightAlias: 'v', rightCol: 'tenantId' },
        literals: [{ alias: 'v', col: 'entityType', literal: 'EMPLOYEE' }],
      },
    }],
    fields: {
      empId:          { alias: 'e', dbCol: 'id',              type: 'string', label: 'Employee ID' },
      empFirstName:   { alias: 'e', dbCol: 'firstName',       type: 'string', label: 'First Name' },
      empLastName:    { alias: 'e', dbCol: 'lastName',        type: 'string', label: 'Last Name' },
      empEmail:       { alias: 'e', dbCol: 'email',           type: 'string', label: 'Email' },
      empNationality: { alias: 'e', dbCol: 'nationality',     type: 'string', label: 'Nationality' },
      empStatus:      { alias: 'e', dbCol: 'status',          type: 'enum',   label: 'Employee Status' },
      empCountry:     { alias: 'e', dbCol: 'country',         type: 'string', label: 'Country' },
      visaType:       { alias: 'v', dbCol: 'visaType',        type: 'string', label: 'Visa Type' },
      visaStatus:     { alias: 'v', dbCol: 'status',          type: 'enum',   label: 'Visa Status' },
      visaNumber:     { alias: 'v', dbCol: 'visaNumber',      type: 'string', label: 'Visa Number' },
      visaApplied:    { alias: 'v', dbCol: 'applicationDate', type: 'date',   label: 'Applied' },
      visaApproved:   { alias: 'v', dbCol: 'approvalDate',    type: 'date',   label: 'Approved' },
      visaExpiry:     { alias: 'v', dbCol: 'expiryDate',      type: 'date',   label: 'Visa Expiry' },
      visaEmbassy:    { alias: 'v', dbCol: 'embassy',         type: 'string', label: 'Embassy' },
    },
  }),

  applicants_visas: READY({
    key: 'applicants_visas',
    label: 'Applicants + Visas',
    group: 'combined',
    tables: ['applicants', 'visas'],
    primaryTable: 'applicants',
    primaryAlias: 'ap',
    softDelete: true,
    tenantColumn: 'tenantId',
    agencyColumn: 'agencyId',
    tenantAwareJoins: [{
      joinType: 'LEFT',
      table: 'visas',
      alias: 'v',
      structuredOn: {
        fk:     { leftAlias: 'ap', leftCol: 'id',       rightAlias: 'v', rightCol: 'entityId' },
        tenant: { leftAlias: 'ap', leftCol: 'tenantId', rightAlias: 'v', rightCol: 'tenantId' },
        literals: [{ alias: 'v', col: 'entityType', literal: 'APPLICANT' }],
      },
    }],
    fields: {
      apId:           { alias: 'ap', dbCol: 'id',                  type: 'string',  label: 'Applicant ID' },
      apFirstName:    { alias: 'ap', dbCol: 'firstName',           type: 'string',  label: 'First Name' },
      apLastName:     { alias: 'ap', dbCol: 'lastName',            type: 'string',  label: 'Last Name' },
      apEmail:        { alias: 'ap', dbCol: 'email',               type: 'string',  label: 'Email' },
      apNationality:  { alias: 'ap', dbCol: 'nationality',         type: 'string',  label: 'Nationality' },
      apStatus:       { alias: 'ap', dbCol: 'status',              type: 'enum',    label: 'Applicant Status' },
      apWorkAuth:     { alias: 'ap', dbCol: 'hasWorkAuthorization', type: 'boolean', label: 'Work Auth' },
      visaType:       { alias: 'v',  dbCol: 'visaType',            type: 'string',  label: 'Visa Type' },
      visaStatus:     { alias: 'v',  dbCol: 'status',              type: 'enum',    label: 'Visa Status' },
      visaNumber:     { alias: 'v',  dbCol: 'visaNumber',          type: 'string',  label: 'Visa Number' },
      visaApplied:    { alias: 'v',  dbCol: 'applicationDate',     type: 'date',    label: 'Applied' },
      visaApproved:   { alias: 'v',  dbCol: 'approvalDate',        type: 'date',    label: 'Approved' },
      visaExpiry:     { alias: 'v',  dbCol: 'expiryDate',          type: 'date',    label: 'Visa Expiry' },
      visaEmbassy:    { alias: 'v',  dbCol: 'embassy',             type: 'string',  label: 'Embassy' },
    },
  }),

  employees_agencies: READY({
    key: 'employees_agencies',
    label: 'Employees + Agencies',
    group: 'combined',
    tables: ['employees', 'agencies'],
    primaryTable: 'employees',
    primaryAlias: 'e',
    softDelete: true,
    tenantColumn: 'tenantId',
    agencyColumn: 'agencyId',
    tenantAwareJoins: [{
      joinType: 'LEFT',
      table: 'agencies',
      alias: 'ag',
      structuredOn: {
        fk:     { leftAlias: 'e', leftCol: 'agencyId', rightAlias: 'ag', rightCol: 'id' },
        tenant: { leftAlias: 'e', leftCol: 'tenantId', rightAlias: 'ag', rightCol: 'tenantId' },
        nullChecks: [{ alias: 'ag', col: 'deletedAt' }],
      },
    }],
    fields: {
      empId:           { alias: 'e',  dbCol: 'id',            type: 'string', label: 'Employee ID' },
      empFirstName:    { alias: 'e',  dbCol: 'firstName',     type: 'string', label: 'First Name' },
      empLastName:     { alias: 'e',  dbCol: 'lastName',      type: 'string', label: 'Last Name' },
      empEmail:        { alias: 'e',  dbCol: 'email',         type: 'string', label: 'Email' },
      empNationality:  { alias: 'e',  dbCol: 'nationality',   type: 'string', label: 'Nationality' },
      empStatus:       { alias: 'e',  dbCol: 'status',        type: 'enum',   label: 'Employee Status' },
      empCity:         { alias: 'e',  dbCol: 'city',          type: 'string', label: 'City' },
      empCountry:      { alias: 'e',  dbCol: 'country',       type: 'string', label: 'Country' },
      empCreatedAt:    { alias: 'e',  dbCol: 'createdAt',     type: 'date',   label: 'Employee Since' },
      agName:          { alias: 'ag', dbCol: 'name',          type: 'string', label: 'Agency Name' },
      agCountry:       { alias: 'ag', dbCol: 'country',       type: 'string', label: 'Agency Country' },
      agContact:       { alias: 'ag', dbCol: 'contactPerson', type: 'string', label: 'Agency Contact' },
      agStatus:        { alias: 'ag', dbCol: 'status',        type: 'enum',   label: 'Agency Status' },
    },
  }),

  documents_with_type: READY({
    key: 'documents_with_type',
    label: 'Documents + Document Types',
    group: 'combined',
    tables: ['documents', 'document_types'],
    primaryTable: 'documents',
    primaryAlias: 'doc',
    softDelete: true,
    tenantColumn: 'tenantId',
    agencyColumn: null,                 // entity-keyed; agency scope through parent
    tenantAwareJoins: [{
      joinType: 'LEFT',
      table: 'document_types',
      alias: 'dt',
      kind: 'catalog',                  // global catalog — no tenantId on dt
      structuredOn: {
        fk: { leftAlias: 'doc', leftCol: 'documentTypeId', rightAlias: 'dt', rightCol: 'id' },
      },
    }],
    fields: {
      docId:            { alias: 'doc', dbCol: 'id',               type: 'string',  label: 'Document ID' },
      docName:          { alias: 'doc', dbCol: 'name',             type: 'string',  label: 'Document Name' },
      docEntityType:    { alias: 'doc', dbCol: 'entityType',       type: 'enum',    label: 'Entity Type' },
      docNumber:        { alias: 'doc', dbCol: 'documentNumber',   type: 'string',  label: 'Doc Number' },
      docStatus:        { alias: 'doc', dbCol: 'status',           type: 'enum',    label: 'Status' },
      docIssueDate:     { alias: 'doc', dbCol: 'issueDate',        type: 'date',    label: 'Issue Date' },
      docExpiryDate:    { alias: 'doc', dbCol: 'expiryDate',       type: 'date',    label: 'Expiry Date' },
      docIssuer:        { alias: 'doc', dbCol: 'issuer',           type: 'string',  label: 'Issuer' },
      docFileSize:      { alias: 'doc', dbCol: 'fileSize',         type: 'number',  label: 'File Size (bytes)' },
      docCreatedAt:     { alias: 'doc', dbCol: 'createdAt',        type: 'date',    label: 'Uploaded At' },
      dtTypeName:       { alias: 'dt',  dbCol: 'name',             type: 'string',  label: 'Document Type' },
      dtCategory:       { alias: 'dt',  dbCol: 'category',         type: 'string',  label: 'Type Category' },
      dtRequired:       { alias: 'dt',  dbCol: 'required',         type: 'boolean', label: 'Required' },
      dtTrackExpiry:    { alias: 'dt',  dbCol: 'trackExpiry',      type: 'boolean', label: 'Track Expiry' },
      dtRenewalDays:    { alias: 'dt',  dbCol: 'renewalPeriodDays', type: 'number',  label: 'Renewal Period (days)' },
    },
  }),

  employees_documents_type: READY({
    key: 'employees_documents_type',
    label: 'Employees + Documents + Types',
    group: 'combined',
    tables: ['employees', 'documents', 'document_types'],
    primaryTable: 'employees',
    primaryAlias: 'e',
    softDelete: true,
    tenantColumn: 'tenantId',
    agencyColumn: 'agencyId',
    tenantAwareJoins: [
      {
        joinType: 'LEFT',
        table: 'documents',
        alias: 'd',
        structuredOn: {
          fk:     { leftAlias: 'e', leftCol: 'id',       rightAlias: 'd', rightCol: 'entityId' },
          tenant: { leftAlias: 'e', leftCol: 'tenantId', rightAlias: 'd', rightCol: 'tenantId' },
          literals: [{ alias: 'd', col: 'entityType', literal: 'EMPLOYEE' }],
          nullChecks: [{ alias: 'd', col: 'deletedAt' }],
        },
      },
      {
        joinType: 'LEFT',
        table: 'document_types',
        alias: 'dt',
        kind: 'catalog',
        structuredOn: {
          fk: { leftAlias: 'd', leftCol: 'documentTypeId', rightAlias: 'dt', rightCol: 'id' },
        },
      },
    ],
    fields: {
      empId:         { alias: 'e',   dbCol: 'id',                type: 'string',  label: 'Employee ID' },
      empFirstName:  { alias: 'e',   dbCol: 'firstName',         type: 'string',  label: 'First Name' },
      empLastName:   { alias: 'e',   dbCol: 'lastName',          type: 'string',  label: 'Last Name' },
      empEmail:      { alias: 'e',   dbCol: 'email',             type: 'string',  label: 'Email' },
      empNationality:{ alias: 'e',   dbCol: 'nationality',       type: 'string',  label: 'Nationality' },
      empStatus:     { alias: 'e',   dbCol: 'status',            type: 'enum',    label: 'Employee Status' },
      docName:       { alias: 'd',   dbCol: 'name',              type: 'string',  label: 'Document Name' },
      docNumber:     { alias: 'd',   dbCol: 'documentNumber',    type: 'string',  label: 'Doc Number' },
      docStatus:     { alias: 'd',   dbCol: 'status',            type: 'enum',    label: 'Doc Status' },
      docExpiry:     { alias: 'd',   dbCol: 'expiryDate',        type: 'date',    label: 'Doc Expiry' },
      dtTypeName:    { alias: 'dt',  dbCol: 'name',              type: 'string',  label: 'Document Type' },
      dtCategory:    { alias: 'dt',  dbCol: 'category',          type: 'string',  label: 'Type Category' },
      dtRequired:    { alias: 'dt',  dbCol: 'required',          type: 'boolean', label: 'Required' },
      dtRenewalDays: { alias: 'dt',  dbCol: 'renewalPeriodDays', type: 'number',  label: 'Renewal Period (days)' },
    },
  }),

  // ─── Phase 3 Reports Hardening — Phase E Batch 1 (Vehicles fleet) ───
  // Single-table sources. All three carry `tenantId` and the engine
  // enforces it as the first WHERE term. Workshop / MaintenanceRecord
  // are intentionally not joined to Vehicle in Phase E to keep the
  // composer untouched; users can build separate reports for cross-
  // reference. A future phase can layer in the tenant-equality joins.

  vehicles: READY({
    key: 'vehicles',
    label: 'Vehicles',
    group: 'single',
    tables: ['vehicles'],
    primaryTable: 'vehicles',
    primaryAlias: 'v',
    softDelete: true,
    tenantColumn: 'tenantId',
    agencyColumn: 'agencyId',
    tenantAwareJoins: [],
    fields: {
      id:                     { alias: 'v', dbCol: 'id',                     type: 'uuid',   label: 'ID', hideByDefault: true },
      registrationNumber:     { alias: 'v', dbCol: 'registrationNumber',     type: 'string', label: 'Registration #' },
      type:                   { alias: 'v', dbCol: 'type',                   type: 'string', label: 'Type' },
      status:                 { alias: 'v', dbCol: 'status',                 type: 'string', label: 'Status' },
      make:                   { alias: 'v', dbCol: 'make',                   type: 'string', label: 'Make' },
      model:                  { alias: 'v', dbCol: 'model',                  type: 'string', label: 'Model' },
      year:                   { alias: 'v', dbCol: 'year',                   type: 'number', label: 'Year' },
      color:                  { alias: 'v', dbCol: 'color',                  type: 'string', label: 'Colour' },
      licensePlate:           { alias: 'v', dbCol: 'licensePlate',           type: 'string', label: 'Plate' },
      vin:                    { alias: 'v', dbCol: 'vin',                    type: 'string', label: 'VIN' },
      fuelType:               { alias: 'v', dbCol: 'fuelType',               type: 'string', label: 'Fuel Type' },
      currentMileage:         { alias: 'v', dbCol: 'currentMileage',         type: 'number', label: 'Mileage' },
      motExpiryDate:          { alias: 'v', dbCol: 'motExpiryDate',          type: 'date',   label: 'MOT Expiry' },
      taxExpiryDate:          { alias: 'v', dbCol: 'taxExpiryDate',          type: 'date',   label: 'Tax Expiry' },
      insuranceExpiryDate:    { alias: 'v', dbCol: 'insuranceExpiryDate',    type: 'date',   label: 'Insurance Expiry' },
      registrationExpiryDate: { alias: 'v', dbCol: 'registrationExpiryDate', type: 'date',   label: 'Registration Expiry' },
      createdAt:              { alias: 'v', dbCol: 'createdAt',              type: 'date',   label: 'Created At' },
    },
    defaultColumns: ['registrationNumber', 'make', 'model', 'year', 'type', 'status'],
  }),

  workshops: READY({
    key: 'workshops',
    label: 'Workshops',
    group: 'single',
    tables: ['workshops'],
    primaryTable: 'workshops',
    primaryAlias: 'w',
    softDelete: true,
    tenantColumn: 'tenantId',
    agencyColumn: null,
    tenantAwareJoins: [],
    fields: {
      id:                         { alias: 'w', dbCol: 'id',                         type: 'uuid',    label: 'ID', hideByDefault: true },
      name:                       { alias: 'w', dbCol: 'name',                       type: 'string',  label: 'Name' },
      companyName:                { alias: 'w', dbCol: 'companyName',                type: 'string',  label: 'Company' },
      city:                       { alias: 'w', dbCol: 'city',                       type: 'string',  label: 'City' },
      country:                    { alias: 'w', dbCol: 'country',                    type: 'string',  label: 'Country' },
      contactName:                { alias: 'w', dbCol: 'contactName',                type: 'string',  label: 'Contact' },
      contactPersonPhone:         { alias: 'w', dbCol: 'contactPersonPhone',         type: 'string',  label: 'Contact Phone' },
      contactPersonEmail:         { alias: 'w', dbCol: 'contactPersonEmail',         type: 'string',  label: 'Contact Email' },
      phone:                      { alias: 'w', dbCol: 'phone',                      type: 'string',  label: 'Phone' },
      email:                      { alias: 'w', dbCol: 'email',                      type: 'string',  label: 'Email' },
      vatNumber:                  { alias: 'w', dbCol: 'vatNumber',                  type: 'string',  label: 'VAT #' },
      businessRegistrationNumber: { alias: 'w', dbCol: 'businessRegistrationNumber', type: 'string',  label: 'Business Reg. #' },
      status:                     { alias: 'w', dbCol: 'status',                     type: 'string',  label: 'Status' },
      isActive:                   { alias: 'w', dbCol: 'isActive',                   type: 'boolean', label: 'Active' },
      createdAt:                  { alias: 'w', dbCol: 'createdAt',                  type: 'date',    label: 'Created At' },
      // Banking columns (iban / swiftBicCode / bankName) are
      // intentionally NOT exposed — sensitive financial data should
      // gate on `finance:read`, not the general workshops report.
    },
    defaultColumns: ['name', 'city', 'country', 'contactName', 'phone'],
  }),

  // ─── Phase 3 Reports Hardening — Phase E Batch 2 (Operations) ──────
  // Single-table sources only. Composer not extended in this batch,
  // so cross-entity columns (employeeNumber on Attendance, business
  // numbers on Finance, etc.) are documented limitations.

  attendance: READY({
    key: 'attendance',
    label: 'Attendance',
    group: 'single',
    tables: ['attendance_records'],
    primaryTable: 'attendance_records',
    primaryAlias: 'a',
    // attendance_records has no `deletedAt`; the legacy engine likewise
    // skips soft-delete on this table.
    softDelete: false,
    tenantColumn: 'tenantId',
    // No flat agencyId column on AttendanceRecord — agency scope flows
    // through the parent Employee. With single-table sources only,
    // agency-scoped actors with `attendance:read` see ALL their
    // tenant's attendance, not just their agency's. The
    // `attendance:read` permission gate is the primary access control
    // until a future phase adds the employee join.
    agencyColumn: null,
    tenantAwareJoins: [],
    fields: {
      id:                 { alias: 'a', dbCol: 'id',                 type: 'uuid',   label: 'ID', hideByDefault: true },
      // employeeId is hidden — a join would be needed to surface
      // employeeNumber / firstName / lastName. Deferred to a later
      // phase ("composer not extended in this batch").
      employeeId:         { alias: 'a', dbCol: 'employeeId',         type: 'uuid',   label: 'Employee ID', hideByDefault: true },
      date:               { alias: 'a', dbCol: 'date',               type: 'date',   label: 'Date' },
      status:             { alias: 'a', dbCol: 'status',             type: 'enum',   label: 'Status' },
      checkIn:            { alias: 'a', dbCol: 'checkIn',            type: 'string', label: 'Check In' },
      checkOut:           { alias: 'a', dbCol: 'checkOut',           type: 'string', label: 'Check Out' },
      breakIn:            { alias: 'a', dbCol: 'breakIn',            type: 'string', label: 'Break In' },
      breakOut:           { alias: 'a', dbCol: 'breakOut',           type: 'string', label: 'Break Out' },
      interruptionIn:     { alias: 'a', dbCol: 'interruptionIn',     type: 'string', label: 'Interruption In' },
      interruptionOut:    { alias: 'a', dbCol: 'interruptionOut',    type: 'string', label: 'Interruption Out' },
      interruptionStatus: { alias: 'a', dbCol: 'interruptionStatus', type: 'enum',   label: 'Interruption Status' },
      workingHours:       { alias: 'a', dbCol: 'workingHours',       type: 'number', label: 'Working Hours' },
      notes:              { alias: 'a', dbCol: 'notes',              type: 'string', label: 'Notes' },
      createdAt:          { alias: 'a', dbCol: 'createdAt',          type: 'date',   label: 'Created At' },
    },
    defaultColumns: ['date', 'status', 'checkIn', 'checkOut', 'breakIn', 'breakOut', 'workingHours'],
  }),

  finance: READY({
    key: 'finance',
    label: 'Finance Records',
    group: 'single',
    tables: ['financial_records'],
    primaryTable: 'financial_records',
    primaryAlias: 'fr',
    softDelete: true,
    tenantColumn: 'tenantId',
    agencyColumn: null,
    tenantAwareJoins: [],
    fields: {
      id:                         { alias: 'fr', dbCol: 'id',                         type: 'uuid',    label: 'ID', hideByDefault: true },
      // Entity-link UUIDs are hidden — a join would be needed to
      // surface employeeNumber / candidateNumber / applicantNumber.
      // Deferred to a later phase.
      entityType:                 { alias: 'fr', dbCol: 'entityType',                 type: 'string',  label: 'Entity Type' },
      entityId:                   { alias: 'fr', dbCol: 'entityId',                   type: 'uuid',    label: 'Entity ID', hideByDefault: true },
      applicantId:                { alias: 'fr', dbCol: 'applicantId',                type: 'uuid',    label: 'Applicant ID', hideByDefault: true },
      stageAtCreation:            { alias: 'fr', dbCol: 'stageAtCreation',            type: 'string',  label: 'Stage At Creation' },
      transactionDate:            { alias: 'fr', dbCol: 'transactionDate',            type: 'date',    label: 'Transaction Date' },
      transactionType:            { alias: 'fr', dbCol: 'transactionType',            type: 'string',  label: 'Transaction Type' },
      currency:                   { alias: 'fr', dbCol: 'currency',                   type: 'string',  label: 'Currency' },
      paymentMethod:              { alias: 'fr', dbCol: 'paymentMethod',              type: 'string',  label: 'Payment Method' },
      paidByName:                 { alias: 'fr', dbCol: 'paidByName',                 type: 'string',  label: 'Paid By' },
      companyDisbursedAmount:     { alias: 'fr', dbCol: 'companyDisbursedAmount',     type: 'decimal', label: 'Company Disbursed' },
      employeeOrAgencyPaidAmount: { alias: 'fr', dbCol: 'employeeOrAgencyPaidAmount', type: 'decimal', label: 'Employee/Agency Paid' },
      status:                     { alias: 'fr', dbCol: 'status',                     type: 'string',  label: 'Status' },
      deductionAmount:            { alias: 'fr', dbCol: 'deductionAmount',            type: 'decimal', label: 'Deduction Amount' },
      deductionDate:              { alias: 'fr', dbCol: 'deductionDate',              type: 'date',    label: 'Deduction Date' },
      payrollReference:           { alias: 'fr', dbCol: 'payrollReference',           type: 'string',  label: 'Payroll Reference' },
      description:                { alias: 'fr', dbCol: 'description',                type: 'string',  label: 'Description' },
      createdAt:                  { alias: 'fr', dbCol: 'createdAt',                  type: 'date',    label: 'Created At' },
      // `paidById` / `createdById` (User UUIDs) and `notes` (free
      // long-text) are intentionally excluded.
    },
    defaultColumns: ['transactionDate', 'transactionType', 'companyDisbursedAmount', 'currency', 'paymentMethod', 'status'],
  }),

  // ─── Phase 3 Reports Hardening — Phase E Batch 3 (Workflows) ──────────
  // Single-table Workflow configuration source. The two assignment
  // models (CandidateWorkflowAssignment, EmployeeWorkflowAssignment)
  // and the stage progress / approval tables are INTENTIONALLY NOT
  // exposed in this batch:
  //   1. Showing the candidate / employee identity alongside the
  //      assignment requires composer joins that Phase E declined to
  //      introduce.
  //   2. EmployeeWorkflowAssignment carries the audit-known R-6
  //      tenant-attribution concern from Phase 3 #1 — the
  //      assign-employee path is "tenant attribution deferred", so
  //      existing rows may have a NULL `tenantId` and would be
  //      invisible to the engine's tenant predicate even where they
  //      should be visible. Exposing it as a report source could leak
  //      "this assignment is missing" rather than the actual rows —
  //      misleading to the operator.

  workflows: READY({
    key: 'workflows',
    label: 'Workflows',
    group: 'single',
    tables: ['workflows'],
    primaryTable: 'workflows',
    primaryAlias: 'wf',
    softDelete: true,
    tenantColumn: 'tenantId',
    agencyColumn: null,   // Workflow is a per-tenant template; agency scope is N/A.
    tenantAwareJoins: [],
    fields: {
      id:          { alias: 'wf', dbCol: 'id',          type: 'uuid',    label: 'ID', hideByDefault: true },
      // `createdById` (User UUID) intentionally excluded.
      name:        { alias: 'wf', dbCol: 'name',        type: 'string',  label: 'Name' },
      description: { alias: 'wf', dbCol: 'description', type: 'string',  label: 'Description' },
      status:      { alias: 'wf', dbCol: 'status',      type: 'enum',    label: 'Status' },
      isDefault:   { alias: 'wf', dbCol: 'isDefault',   type: 'boolean', label: 'Default' },
      isPublic:    { alias: 'wf', dbCol: 'isPublic',    type: 'boolean', label: 'Public (cross-tenant template)' },
      createdAt:   { alias: 'wf', dbCol: 'createdAt',   type: 'date',    label: 'Created At' },
      updatedAt:   { alias: 'wf', dbCol: 'updatedAt',   type: 'date',    label: 'Updated At' },
    },
    defaultColumns: ['name', 'status', 'isDefault', 'isPublic', 'createdAt', 'updatedAt'],
  }),

  job_ads: READY({
    key: 'job_ads',
    label: 'Job Ads',
    group: 'single',
    tables: ['job_ads'],
    primaryTable: 'job_ads',
    primaryAlias: 'ja',
    softDelete: true,
    tenantColumn: 'tenantId',
    agencyColumn: null,
    tenantAwareJoins: [],
    fields: {
      id:           { alias: 'ja', dbCol: 'id',           type: 'uuid',    label: 'ID', hideByDefault: true },
      title:        { alias: 'ja', dbCol: 'title',        type: 'string',  label: 'Title' },
      // `slug` is the only persistent business-style identifier on
      // JobAd, but it is USER-EDITABLE (see SPIKE-007). Useful for
      // display only — do NOT treat it as a stable key.
      slug:         { alias: 'ja', dbCol: 'slug',         type: 'string',  label: 'Slug' },
      category:     { alias: 'ja', dbCol: 'category',     type: 'string',  label: 'Category' },
      city:         { alias: 'ja', dbCol: 'city',         type: 'string',  label: 'City' },
      country:      { alias: 'ja', dbCol: 'country',      type: 'string',  label: 'Country' },
      contractType: { alias: 'ja', dbCol: 'contractType', type: 'string',  label: 'Contract Type' },
      salaryMin:    { alias: 'ja', dbCol: 'salaryMin',    type: 'decimal', label: 'Salary Min' },
      salaryMax:    { alias: 'ja', dbCol: 'salaryMax',    type: 'decimal', label: 'Salary Max' },
      currency:     { alias: 'ja', dbCol: 'currency',     type: 'string',  label: 'Currency' },
      status:       { alias: 'ja', dbCol: 'status',       type: 'string',  label: 'Status' },
      publishedAt:  { alias: 'ja', dbCol: 'publishedAt',  type: 'date',    label: 'Published At' },
      createdAt:    { alias: 'ja', dbCol: 'createdAt',    type: 'date',    label: 'Created At' },
      // `description` (rich text), `requiredDocuments` (JSON-encoded
      // string[]) and `createdById` (User UUID) are intentionally
      // excluded.
    },
    defaultColumns: ['title', 'slug', 'city', 'country', 'contractType', 'status', 'publishedAt'],
  }),

  maintenance_records: READY({
    key: 'maintenance_records',
    label: 'Maintenance Records',
    group: 'single',
    tables: ['maintenance_records'],
    primaryTable: 'maintenance_records',
    primaryAlias: 'mr',
    softDelete: true,
    tenantColumn: 'tenantId',
    agencyColumn: null,
    tenantAwareJoins: [],
    fields: {
      id:                 { alias: 'mr', dbCol: 'id',                 type: 'uuid',   label: 'ID', hideByDefault: true },
      // Foreign keys are hidden — the user builds a separate Vehicles
      // / Workshops report for the cross-reference until a future
      // phase wires up the tenant-equality joins.
      vehicleId:          { alias: 'mr', dbCol: 'vehicleId',          type: 'uuid',   label: 'Vehicle ID',   hideByDefault: true },
      maintenanceTypeId:  { alias: 'mr', dbCol: 'maintenanceTypeId',  type: 'uuid',   label: 'Type ID',      hideByDefault: true },
      workshopId:         { alias: 'mr', dbCol: 'workshopId',         type: 'uuid',   label: 'Workshop ID',  hideByDefault: true },
      status:             { alias: 'mr', dbCol: 'status',             type: 'enum',   label: 'Status' },
      scheduledDate:      { alias: 'mr', dbCol: 'scheduledDate',      type: 'date',   label: 'Scheduled' },
      completedDate:      { alias: 'mr', dbCol: 'completedDate',      type: 'date',   label: 'Completed' },
      mileageAtService:   { alias: 'mr', dbCol: 'mileageAtService',   type: 'number', label: 'Mileage' },
      nextServiceDate:    { alias: 'mr', dbCol: 'nextServiceDate',    type: 'date',   label: 'Next Service' },
      nextServiceMileage: { alias: 'mr', dbCol: 'nextServiceMileage', type: 'number', label: 'Next Service Mileage' },
      cost:               { alias: 'mr', dbCol: 'cost',               type: 'number', label: 'Cost' },
      laborCost:          { alias: 'mr', dbCol: 'laborCost',          type: 'number', label: 'Labour Cost' },
      partsCost:          { alias: 'mr', dbCol: 'partsCost',          type: 'number', label: 'Parts Cost' },
      description:        { alias: 'mr', dbCol: 'description',        type: 'string', label: 'Description' },
      technicianName:     { alias: 'mr', dbCol: 'technicianName',     type: 'string', label: 'Technician' },
      invoiceNumber:      { alias: 'mr', dbCol: 'invoiceNumber',      type: 'string', label: 'Invoice #' },
      createdAt:          { alias: 'mr', dbCol: 'createdAt',          type: 'date',   label: 'Created At' },
    },
    defaultColumns: ['scheduledDate', 'completedDate', 'status', 'mileageAtService', 'cost', 'invoiceNumber'],
  }),
};

/** Convenience: list of READY source keys. */
export function readySourceKeys(): string[] {
  return Object.entries(TENANT_SAFE_SOURCES)
    .filter(([, m]) => m.status === 'READY')
    .map(([k]) => k);
}

/** Convenience: list of DISABLED source keys with reasons. */
export function disabledSources(): { key: string; reason: string }[] {
  return Object.entries(TENANT_SAFE_SOURCES)
    .filter(([, m]) => m.status === 'DISABLED')
    .map(([key, m]) => ({ key, reason: m.reason ?? 'unspecified' }));
}
