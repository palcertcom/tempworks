import {
  Injectable, NotFoundException, BadRequestException, ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as ExcelJS from 'exceljs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const PDFDocument = require('pdfkit') as typeof import('pdfkit');
import {
  Document, Packer, Paragraph, Table, TableRow, TableCell,
  TextRun, HeadingLevel, WidthType,
} from 'docx';
import { PrismaService } from '../prisma/prisma.service';
import { FeatureFlagsService } from '../saas/feature-flags/feature-flags.service';
import { TENANT_SAFE_SOURCES } from '../saas/reports/runtime/report-sources';
import { tServer, ServerLocale } from '../common/i18n/server-translate';
import { formatDisplayDate, formatDisplayDateTime } from '../common/i18n/date-format';
import { buildSuperUserTenantWhere } from '../saas/prisma/super-user-tenant-filter';
import {
  CreateReportDto, UpdateReportDto, RunReportDto, ExportFormat,
  ReportFilterDto, ReportColumnDto, ReportSortingDto,
} from './dto/report.dto';

// ─── Phase 3 Reports Hardening — Phase A ──────────────────────────────────────
// Limits enforced server-side regardless of what the client sends.

/** Hard cap on rows returned by a single Run page. */
export const REPORTS_RUN_MAX_LIMIT = 1000;
/** Fixed window for Preview — never tunable from the client. */
export const REPORTS_PREVIEW_LIMIT = 50;

/**
 * Map each data-source key to the parent module permission required to
 * build, preview, run, or export reports off it. Reading
 * `reports:read` alone used to unlock every source including finance
 * and attendance — this is the missing gate.
 *
 * Sources whose data is the catalog itself (DocumentType, etc.) fall
 * back to a generic `reports:read` requirement (no extra gate).
 */
export const REPORT_SOURCE_PERMISSION: Record<string, string> = {
  employees:                'employees:read',
  employees_documents:      'employees:read',
  employees_work_permits:   'employees:read',
  employees_compliance:     'employees:read',
  employees_agencies:       'employees:read',
  employees_visas:          'employees:read',
  employees_documents_type: 'employees:read',
  applicants:               'applicants:read',
  applicants_documents:     'applicants:read',
  applicants_compliance:    'applicants:read',
  applicants_visas:         'applicants:read',
  documents:                'documents:read',
  documents_with_type:      'documents:read',
  document_types:           'documents:read',
  work_permits:             'documents:read',
  visas:                    'documents:read',
  compliance_alerts:        'compliance:read',
  agencies:                 'agencies:read',
  // Phase 3 Reports Hardening — Phase E Batch 1 (Vehicles fleet).
  // Workshops + Maintenance Records are part of the vehicles module
  // and share its permission key; no separate `workshops:read` exists.
  vehicles:                 'vehicles:read',
  workshops:                'vehicles:read',
  maintenance_records:      'vehicles:read',
  // Phase 3 Reports Hardening — Phase E Batch 2 (Operations).
  attendance:               'attendance:read',
  finance:                  'finance:read',
  job_ads:                  'job-ads:read',
  // Phase 3 Reports Hardening — Phase E Batch 3 (Workflows).
  workflows:                'workflow:read',
};

/** Sources the caller is entitled to build/run/preview/export. */
export function permittedSourcesFor(callerPermissions: ReadonlySet<string>): string[] {
  const keys = Object.keys(REPORT_SOURCE_PERMISSION);
  return keys.filter(k => callerPermissions.has(REPORT_SOURCE_PERMISSION[k]));
}

// ─── Data-Source Registry ─────────────────────────────────────────────────────

interface FieldDef {
  alias: string;   // table alias used in query
  dbCol: string;   // actual column name in the DB
  type: string;
  label: string;
  // Phase 3 Reports Hardening — Phase D. When true, the field is
  // excluded from the default column picker and never auto-selected.
  hideByDefault?: boolean;
}

interface JoinDef {
  joinType: 'LEFT' | 'INNER';
  table: string;   // DB table name
  alias: string;   // alias in the query
  /** Fully-written, static ON condition using aliases.  All values are
   *  hardcoded here — never interpolated from user input — so Prisma.raw is safe. */
  on: string;
}

interface SourceDef {
  label: string;
  group: 'single' | 'combined';
  /** Human-readable names of every table that participates */
  tables: string[];
  primaryTable: string;
  primaryAlias: string;
  /** Primary table has a deletedAt soft-delete column */
  softDelete: boolean;
  joins: JoinDef[];
  fields: Record<string, FieldDef>;
  // Phase 3 Reports Hardening — Phase D. Ordered field keys auto-
  // selected in the builder when this source is picked.
  defaultColumns?: readonly string[];
}

const SOURCE_DEFS: Record<string, SourceDef> = {
  // ── Single-table sources ──────────────────────────────────────────────────
  employees: {
    label: 'Employees', group: 'single', tables: ['Employees'],
    primaryTable: 'employees', primaryAlias: 'e', softDelete: true, joins: [],
    fields: {
      // Phase 3 Reports Hardening — Phase D (#19): UUID hidden by
      // default; business identifiers (employeeNumber, lead/candidate
      // carry-forward numbers) lead the picker.
      id:              { alias: 'e', dbCol: 'id',              type: 'string', label: 'ID', hideByDefault: true },
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
    },
    defaultColumns: ['employeeNumber', 'firstName', 'lastName', 'email', 'status'],
  },

  applicants: {
    label: 'Applicants', group: 'single', tables: ['Applicants'],
    primaryTable: 'applicants', primaryAlias: 'ap', softDelete: true, joins: [],
    fields: {
      id:                   { alias: 'ap', dbCol: 'id',                   type: 'string',  label: 'ID', hideByDefault: true },
      // Phase 3 Reports Hardening — Phase D (#19): Lead + Candidate
      // numbers both default-selected so the report shows whichever
      // tier the row is in. The composer is unchanged — no in-SQL
      // COALESCE in Phase D.
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
    },
    defaultColumns: ['candidateNumber', 'leadNumber', 'firstName', 'lastName', 'tier', 'status'],
  },

  documents: {
    label: 'Documents', group: 'single', tables: ['Documents'],
    primaryTable: 'documents', primaryAlias: 'doc', softDelete: true, joins: [],
    fields: {
      id:             { alias: 'doc', dbCol: 'id',             type: 'string', label: 'ID', hideByDefault: true },
      // Phase 3 Reports Hardening — Phase D (#19): `docId` is the
      // business-friendly identifier (e.g. DOCC20260400001PASS001);
      // `documentNumber` is the issuer's printed number.
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
  },

  compliance_alerts: {
    label: 'Compliance Alerts', group: 'single', tables: ['Compliance Alerts'],
    primaryTable: 'compliance_alerts', primaryAlias: 'ca', softDelete: false, joins: [],
    fields: {
      id:         { alias: 'ca', dbCol: 'id',         type: 'string', label: 'ID', hideByDefault: true },
      entityType: { alias: 'ca', dbCol: 'entityType', type: 'enum',   label: 'Entity Type' },
      alertType:  { alias: 'ca', dbCol: 'alertType',  type: 'string', label: 'Alert Type' },
      severity:   { alias: 'ca', dbCol: 'severity',   type: 'enum',   label: 'Severity' },
      message:    { alias: 'ca', dbCol: 'message',    type: 'string', label: 'Message' },
      status:     { alias: 'ca', dbCol: 'status',     type: 'enum',   label: 'Status' },
      dueDate:    { alias: 'ca', dbCol: 'dueDate',    type: 'date',   label: 'Due Date' },
      createdAt:  { alias: 'ca', dbCol: 'createdAt',  type: 'date',   label: 'Created At' },
    },
    defaultColumns: ['entityType', 'alertType', 'severity', 'status', 'dueDate'],
  },

  agencies: {
    label: 'Agencies', group: 'single', tables: ['Agencies'],
    primaryTable: 'agencies', primaryAlias: 'ag', softDelete: true, joins: [],
    fields: {
      id:            { alias: 'ag', dbCol: 'id',            type: 'string', label: 'ID', hideByDefault: true },
      name:          { alias: 'ag', dbCol: 'name',          type: 'string', label: 'Name' },
      country:       { alias: 'ag', dbCol: 'country',       type: 'string', label: 'Country' },
      contactPerson: { alias: 'ag', dbCol: 'contactPerson', type: 'string', label: 'Contact' },
      email:         { alias: 'ag', dbCol: 'email',         type: 'string', label: 'Email' },
      phone:         { alias: 'ag', dbCol: 'phone',         type: 'string', label: 'Phone' },
      status:        { alias: 'ag', dbCol: 'status',        type: 'enum',   label: 'Status' },
      createdAt:     { alias: 'ag', dbCol: 'createdAt',     type: 'date',   label: 'Created At' },
    },
    defaultColumns: ['name', 'country', 'contactPerson', 'email', 'status'],
  },

  work_permits: {
    label: 'Work Permits', group: 'single', tables: ['Work Permits'],
    primaryTable: 'work_permits', primaryAlias: 'wp', softDelete: false, joins: [],
    fields: {
      id:              { alias: 'wp', dbCol: 'id',              type: 'string', label: 'ID' },
      permitType:      { alias: 'wp', dbCol: 'permitType',      type: 'string', label: 'Permit Type' },
      status:          { alias: 'wp', dbCol: 'status',          type: 'enum',   label: 'Status' },
      permitNumber:    { alias: 'wp', dbCol: 'permitNumber',    type: 'string', label: 'Permit No.' },
      applicationDate: { alias: 'wp', dbCol: 'applicationDate', type: 'date',   label: 'Applied' },
      approvalDate:    { alias: 'wp', dbCol: 'approvalDate',    type: 'date',   label: 'Approved' },
      expiryDate:      { alias: 'wp', dbCol: 'expiryDate',      type: 'date',   label: 'Expiry' },
      createdAt:       { alias: 'wp', dbCol: 'createdAt',       type: 'date',   label: 'Created At' },
    },
  },

  // ── Combined / multi-table sources ───────────────────────────────────────
  employees_documents: {
    label: 'Employees + Documents',
    group: 'combined',
    tables: ['Employees', 'Documents'],
    primaryTable: 'employees',
    primaryAlias: 'e',
    softDelete: true,
    joins: [{
      joinType: 'LEFT',
      table: 'documents',
      alias: 'd',
      on: `e.id = d."entityId" AND d."entityType" = 'EMPLOYEE' AND d."deletedAt" IS NULL`,
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
  },

  employees_work_permits: {
    label: 'Employees + Work Permits',
    group: 'combined',
    tables: ['Employees', 'Work Permits'],
    primaryTable: 'employees',
    primaryAlias: 'e',
    softDelete: true,
    joins: [{
      joinType: 'LEFT',
      table: 'work_permits',
      alias: 'wp',
      on: `e.id = wp."employeeId"`,
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
  },

  employees_compliance: {
    label: 'Employees + Compliance Alerts',
    group: 'combined',
    tables: ['Employees', 'Compliance Alerts'],
    primaryTable: 'employees',
    primaryAlias: 'e',
    softDelete: true,
    joins: [{
      joinType: 'LEFT',
      table: 'compliance_alerts',
      alias: 'ca',
      on: `e.id = ca."entityId" AND ca."entityType" = 'EMPLOYEE'`,
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
  },

  applicants_documents: {
    label: 'Applicants + Documents',
    group: 'combined',
    tables: ['Applicants', 'Documents'],
    primaryTable: 'applicants',
    primaryAlias: 'ap',
    softDelete: true,
    joins: [{
      joinType: 'LEFT',
      table: 'documents',
      alias: 'd',
      on: `ap.id = d."entityId" AND d."entityType" = 'APPLICANT' AND d."deletedAt" IS NULL`,
    }],
    fields: {
      apId:           { alias: 'ap', dbCol: 'id',              type: 'string',  label: 'Applicant ID' },
      apFirstName:    { alias: 'ap', dbCol: 'firstName',       type: 'string',  label: 'First Name' },
      apLastName:     { alias: 'ap', dbCol: 'lastName',        type: 'string',  label: 'Last Name' },
      apEmail:        { alias: 'ap', dbCol: 'email',           type: 'string',  label: 'Email' },
      apNationality:  { alias: 'ap', dbCol: 'nationality',     type: 'string',  label: 'Nationality' },
      apStatus:       { alias: 'ap', dbCol: 'status',          type: 'enum',    label: 'Applicant Status' },
      apResidency:    { alias: 'ap', dbCol: 'residencyStatus', type: 'string',  label: 'Residency' },
      apWorkAuth:     { alias: 'ap', dbCol: 'hasWorkAuthorization', type: 'boolean', label: 'Work Auth' },
      apCreatedAt:    { alias: 'ap', dbCol: 'createdAt',       type: 'date',    label: 'Applied At' },
      docName:        { alias: 'd',  dbCol: 'name',            type: 'string',  label: 'Document Name' },
      docNumber:      { alias: 'd',  dbCol: 'documentNumber',  type: 'string',  label: 'Doc Number' },
      docStatus:      { alias: 'd',  dbCol: 'status',          type: 'enum',    label: 'Doc Status' },
      docExpiryDate:  { alias: 'd',  dbCol: 'expiryDate',      type: 'date',    label: 'Doc Expiry' },
    },
  },

  employees_agencies: {
    label: 'Employees + Agencies',
    group: 'combined',
    tables: ['Employees', 'Agencies'],
    primaryTable: 'employees',
    primaryAlias: 'e',
    softDelete: true,
    joins: [{
      joinType: 'LEFT',
      table: 'agencies',
      alias: 'ag',
      on: `e."agencyId" = ag.id AND ag."deletedAt" IS NULL`,
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
  },

  applicants_compliance: {
    label: 'Applicants + Compliance Alerts',
    group: 'combined',
    tables: ['Applicants', 'Compliance Alerts'],
    primaryTable: 'applicants',
    primaryAlias: 'ap',
    softDelete: true,
    joins: [{
      joinType: 'LEFT',
      table: 'compliance_alerts',
      alias: 'ca',
      on: `ap.id = ca."entityId" AND ca."entityType" = 'APPLICANT'`,
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
  },

  // ── Additional detail tables ──────────────────────────────────────────────
  document_types: {
    label: 'Document Types', group: 'single', tables: ['Document Types'],
    primaryTable: 'document_types', primaryAlias: 'dt', softDelete: false, joins: [],
    fields: {
      id:               { alias: 'dt', dbCol: 'id',               type: 'string',  label: 'ID' },
      name:             { alias: 'dt', dbCol: 'name',             type: 'string',  label: 'Type Name' },
      description:      { alias: 'dt', dbCol: 'description',      type: 'string',  label: 'Description' },
      category:         { alias: 'dt', dbCol: 'category',         type: 'string',  label: 'Category' },
      required:         { alias: 'dt', dbCol: 'required',         type: 'boolean', label: 'Required' },
      trackExpiry:      { alias: 'dt', dbCol: 'trackExpiry',      type: 'boolean', label: 'Track Expiry' },
      renewalPeriodDays:{ alias: 'dt', dbCol: 'renewalPeriodDays',type: 'number',  label: 'Renewal Period (days)' },
      isActive:         { alias: 'dt', dbCol: 'isActive',         type: 'boolean', label: 'Is Active' },
      createdAt:        { alias: 'dt', dbCol: 'createdAt',        type: 'date',    label: 'Created At' },
    },
  },

  visas: {
    label: 'Visas', group: 'single', tables: ['Visas'],
    primaryTable: 'visas', primaryAlias: 'v', softDelete: false, joins: [],
    fields: {
      id:              { alias: 'v', dbCol: 'id',              type: 'string', label: 'ID' },
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
  },

  documents_with_type: {
    label: 'Documents + Document Types',
    group: 'combined',
    tables: ['Documents', 'Document Types'],
    primaryTable: 'documents',
    primaryAlias: 'doc',
    softDelete: true,
    joins: [{
      joinType: 'LEFT',
      table: 'document_types',
      alias: 'dt',
      on: `doc."documentTypeId" = dt.id`,
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
      dtRenewalDays:    { alias: 'dt',  dbCol: 'renewalPeriodDays',type: 'number',  label: 'Renewal Period (days)' },
    },
  },

  employees_visas: {
    label: 'Employees + Visas',
    group: 'combined',
    tables: ['Employees', 'Visas'],
    primaryTable: 'employees',
    primaryAlias: 'e',
    softDelete: true,
    joins: [{
      joinType: 'LEFT',
      table: 'visas',
      alias: 'v',
      on: `e.id = v."entityId" AND v."entityType" = 'EMPLOYEE'`,
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
  },

  applicants_visas: {
    label: 'Applicants + Visas',
    group: 'combined',
    tables: ['Applicants', 'Visas'],
    primaryTable: 'applicants',
    primaryAlias: 'ap',
    softDelete: true,
    joins: [{
      joinType: 'LEFT',
      table: 'visas',
      alias: 'v',
      on: `ap.id = v."entityId" AND v."entityType" = 'APPLICANT'`,
    }],
    fields: {
      apId:           { alias: 'ap', dbCol: 'id',              type: 'string',  label: 'Applicant ID' },
      apFirstName:    { alias: 'ap', dbCol: 'firstName',       type: 'string',  label: 'First Name' },
      apLastName:     { alias: 'ap', dbCol: 'lastName',        type: 'string',  label: 'Last Name' },
      apEmail:        { alias: 'ap', dbCol: 'email',           type: 'string',  label: 'Email' },
      apNationality:  { alias: 'ap', dbCol: 'nationality',     type: 'string',  label: 'Nationality' },
      apStatus:       { alias: 'ap', dbCol: 'status',          type: 'enum',    label: 'Applicant Status' },
      apWorkAuth:     { alias: 'ap', dbCol: 'hasWorkAuthorization', type: 'boolean', label: 'Work Auth' },
      visaType:       { alias: 'v',  dbCol: 'visaType',        type: 'string',  label: 'Visa Type' },
      visaStatus:     { alias: 'v',  dbCol: 'status',          type: 'enum',    label: 'Visa Status' },
      visaNumber:     { alias: 'v',  dbCol: 'visaNumber',      type: 'string',  label: 'Visa Number' },
      visaApplied:    { alias: 'v',  dbCol: 'applicationDate', type: 'date',    label: 'Applied' },
      visaApproved:   { alias: 'v',  dbCol: 'approvalDate',    type: 'date',    label: 'Approved' },
      visaExpiry:     { alias: 'v',  dbCol: 'expiryDate',      type: 'date',    label: 'Visa Expiry' },
      visaEmbassy:    { alias: 'v',  dbCol: 'embassy',         type: 'string',  label: 'Embassy' },
    },
  },

  employees_documents_type: {
    label: 'Employees + Documents + Types',
    group: 'combined',
    tables: ['Employees', 'Documents', 'Document Types'],
    primaryTable: 'employees',
    primaryAlias: 'e',
    softDelete: true,
    joins: [
      {
        joinType: 'LEFT',
        table: 'documents',
        alias: 'd',
        on: `e.id = d."entityId" AND d."entityType" = 'EMPLOYEE' AND d."deletedAt" IS NULL`,
      },
      {
        joinType: 'LEFT',
        table: 'document_types',
        alias: 'dt',
        on: `d."documentTypeId" = dt.id`,
      },
    ],
    fields: {
      empId:         { alias: 'e',   dbCol: 'id',               type: 'string',  label: 'Employee ID' },
      empFirstName:  { alias: 'e',   dbCol: 'firstName',        type: 'string',  label: 'First Name' },
      empLastName:   { alias: 'e',   dbCol: 'lastName',         type: 'string',  label: 'Last Name' },
      empEmail:      { alias: 'e',   dbCol: 'email',            type: 'string',  label: 'Email' },
      empNationality:{ alias: 'e',   dbCol: 'nationality',      type: 'string',  label: 'Nationality' },
      empStatus:     { alias: 'e',   dbCol: 'status',           type: 'enum',    label: 'Employee Status' },
      docName:       { alias: 'd',   dbCol: 'name',             type: 'string',  label: 'Document Name' },
      docNumber:     { alias: 'd',   dbCol: 'documentNumber',   type: 'string',  label: 'Doc Number' },
      docStatus:     { alias: 'd',   dbCol: 'status',           type: 'enum',    label: 'Doc Status' },
      docExpiry:     { alias: 'd',   dbCol: 'expiryDate',       type: 'date',    label: 'Doc Expiry' },
      dtTypeName:    { alias: 'dt',  dbCol: 'name',             type: 'string',  label: 'Document Type' },
      dtCategory:    { alias: 'dt',  dbCol: 'category',         type: 'string',  label: 'Type Category' },
      dtRequired:    { alias: 'dt',  dbCol: 'required',         type: 'boolean', label: 'Required' },
      dtRenewalDays: { alias: 'dt',  dbCol: 'renewalPeriodDays',type: 'number',  label: 'Renewal Period (days)' },
    },
  },

  // ─── Phase 3 Reports Hardening — Phase E Batch 1 (Vehicles fleet) ────────
  // Single-table sources mirroring the tenant-safe registry. Sensitive
  // banking columns (iban / swiftBicCode / bankName) on workshops are
  // intentionally not exposed; FK UUIDs on maintenance_records are
  // marked hideByDefault for the same reason.

  vehicles: {
    label: 'Vehicles', group: 'single', tables: ['Vehicles'],
    primaryTable: 'vehicles', primaryAlias: 'v', softDelete: true, joins: [],
    fields: {
      id:                     { alias: 'v', dbCol: 'id',                     type: 'string', label: 'ID', hideByDefault: true },
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
  },

  workshops: {
    label: 'Workshops', group: 'single', tables: ['Workshops'],
    primaryTable: 'workshops', primaryAlias: 'w', softDelete: true, joins: [],
    fields: {
      id:                         { alias: 'w', dbCol: 'id',                         type: 'string',  label: 'ID', hideByDefault: true },
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
    },
    defaultColumns: ['name', 'city', 'country', 'contactName', 'phone'],
  },

  maintenance_records: {
    label: 'Maintenance Records', group: 'single', tables: ['Maintenance Records'],
    primaryTable: 'maintenance_records', primaryAlias: 'mr', softDelete: true, joins: [],
    fields: {
      id:                 { alias: 'mr', dbCol: 'id',                 type: 'string', label: 'ID', hideByDefault: true },
      vehicleId:          { alias: 'mr', dbCol: 'vehicleId',          type: 'string', label: 'Vehicle ID',  hideByDefault: true },
      maintenanceTypeId:  { alias: 'mr', dbCol: 'maintenanceTypeId',  type: 'string', label: 'Type ID',     hideByDefault: true },
      workshopId:         { alias: 'mr', dbCol: 'workshopId',         type: 'string', label: 'Workshop ID', hideByDefault: true },
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
  },

  // ─── Phase 3 Reports Hardening — Phase E Batch 2 (Operations) ──────────
  // Single-table sources. Composer not extended — cross-entity columns
  // (employeeNumber on Attendance, candidate/applicant business numbers
  // on Finance) are documented limitations.

  attendance: {
    label: 'Attendance', group: 'single', tables: ['Attendance'],
    primaryTable: 'attendance_records', primaryAlias: 'a', softDelete: false, joins: [],
    fields: {
      id:                 { alias: 'a', dbCol: 'id',                 type: 'string', label: 'ID', hideByDefault: true },
      employeeId:         { alias: 'a', dbCol: 'employeeId',         type: 'string', label: 'Employee ID', hideByDefault: true },
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
  },

  finance: {
    label: 'Finance Records', group: 'single', tables: ['Finance Records'],
    primaryTable: 'financial_records', primaryAlias: 'fr', softDelete: true, joins: [],
    fields: {
      id:                         { alias: 'fr', dbCol: 'id',                         type: 'string', label: 'ID', hideByDefault: true },
      entityType:                 { alias: 'fr', dbCol: 'entityType',                 type: 'string', label: 'Entity Type' },
      entityId:                   { alias: 'fr', dbCol: 'entityId',                   type: 'string', label: 'Entity ID', hideByDefault: true },
      applicantId:                { alias: 'fr', dbCol: 'applicantId',                type: 'string', label: 'Applicant ID', hideByDefault: true },
      stageAtCreation:            { alias: 'fr', dbCol: 'stageAtCreation',            type: 'string', label: 'Stage At Creation' },
      transactionDate:            { alias: 'fr', dbCol: 'transactionDate',            type: 'date',   label: 'Transaction Date' },
      transactionType:            { alias: 'fr', dbCol: 'transactionType',            type: 'string', label: 'Transaction Type' },
      currency:                   { alias: 'fr', dbCol: 'currency',                   type: 'string', label: 'Currency' },
      paymentMethod:              { alias: 'fr', dbCol: 'paymentMethod',              type: 'string', label: 'Payment Method' },
      paidByName:                 { alias: 'fr', dbCol: 'paidByName',                 type: 'string', label: 'Paid By' },
      companyDisbursedAmount:     { alias: 'fr', dbCol: 'companyDisbursedAmount',     type: 'number', label: 'Company Disbursed' },
      employeeOrAgencyPaidAmount: { alias: 'fr', dbCol: 'employeeOrAgencyPaidAmount', type: 'number', label: 'Employee/Agency Paid' },
      status:                     { alias: 'fr', dbCol: 'status',                     type: 'string', label: 'Status' },
      deductionAmount:            { alias: 'fr', dbCol: 'deductionAmount',            type: 'number', label: 'Deduction Amount' },
      deductionDate:              { alias: 'fr', dbCol: 'deductionDate',              type: 'date',   label: 'Deduction Date' },
      payrollReference:           { alias: 'fr', dbCol: 'payrollReference',           type: 'string', label: 'Payroll Reference' },
      description:                { alias: 'fr', dbCol: 'description',                type: 'string', label: 'Description' },
      createdAt:                  { alias: 'fr', dbCol: 'createdAt',                  type: 'date',   label: 'Created At' },
    },
    defaultColumns: ['transactionDate', 'transactionType', 'companyDisbursedAmount', 'currency', 'paymentMethod', 'status'],
  },

  // ─── Phase 3 Reports Hardening — Phase E Batch 3 (Workflows) ──────────
  // Single-table Workflow source only. CandidateWorkflowAssignment /
  // EmployeeWorkflowAssignment + stage progress / approval tables are
  // intentionally NOT exposed in this batch — see the tenant-safe
  // registry comment for the full rationale (composer joins not added;
  // EmployeeWorkflowAssignment carries the audit-known R-6 tenant-
  // attribution gap from Phase 3 #1).

  workflows: {
    label: 'Workflows', group: 'single', tables: ['Workflows'],
    primaryTable: 'workflows', primaryAlias: 'wf', softDelete: true, joins: [],
    fields: {
      id:          { alias: 'wf', dbCol: 'id',          type: 'string',  label: 'ID', hideByDefault: true },
      name:        { alias: 'wf', dbCol: 'name',        type: 'string',  label: 'Name' },
      description: { alias: 'wf', dbCol: 'description', type: 'string',  label: 'Description' },
      status:      { alias: 'wf', dbCol: 'status',      type: 'enum',    label: 'Status' },
      isDefault:   { alias: 'wf', dbCol: 'isDefault',   type: 'boolean', label: 'Default' },
      isPublic:    { alias: 'wf', dbCol: 'isPublic',    type: 'boolean', label: 'Public (cross-tenant template)' },
      createdAt:   { alias: 'wf', dbCol: 'createdAt',   type: 'date',    label: 'Created At' },
      updatedAt:   { alias: 'wf', dbCol: 'updatedAt',   type: 'date',    label: 'Updated At' },
    },
    defaultColumns: ['name', 'status', 'isDefault', 'isPublic', 'createdAt', 'updatedAt'],
  },

  job_ads: {
    label: 'Job Ads', group: 'single', tables: ['Job Ads'],
    primaryTable: 'job_ads', primaryAlias: 'ja', softDelete: true, joins: [],
    fields: {
      id:           { alias: 'ja', dbCol: 'id',           type: 'string', label: 'ID', hideByDefault: true },
      title:        { alias: 'ja', dbCol: 'title',        type: 'string', label: 'Title' },
      slug:         { alias: 'ja', dbCol: 'slug',         type: 'string', label: 'Slug' },
      category:     { alias: 'ja', dbCol: 'category',     type: 'string', label: 'Category' },
      city:         { alias: 'ja', dbCol: 'city',         type: 'string', label: 'City' },
      country:      { alias: 'ja', dbCol: 'country',      type: 'string', label: 'Country' },
      contractType: { alias: 'ja', dbCol: 'contractType', type: 'string', label: 'Contract Type' },
      salaryMin:    { alias: 'ja', dbCol: 'salaryMin',    type: 'number', label: 'Salary Min' },
      salaryMax:    { alias: 'ja', dbCol: 'salaryMax',    type: 'number', label: 'Salary Max' },
      currency:     { alias: 'ja', dbCol: 'currency',     type: 'string', label: 'Currency' },
      status:       { alias: 'ja', dbCol: 'status',       type: 'string', label: 'Status' },
      publishedAt:  { alias: 'ja', dbCol: 'publishedAt',  type: 'date',   label: 'Published At' },
      createdAt:    { alias: 'ja', dbCol: 'createdAt',    type: 'date',   label: 'Created At' },
    },
    defaultColumns: ['title', 'slug', 'city', 'country', 'contractType', 'status', 'publishedAt'],
  },
};

// ─── Service ─────────────────────────────────────────────────────────────────

@Injectable()
export class ReportsService {
  constructor(
    private prisma: PrismaService,
    private flags: FeatureFlagsService,
  ) {}

  /**
   * Phase 2.1 integration switch.
   *
   * - When `TENANT_SAFE_REPORTS_ENABLED=false` (production default),
   *   this method returns false and the legacy executeReport runs.
   * - When true, the report's source must be marked READY in the
   *   tenant-safe registry; if it is, the safe runtime is invoked.
   *   Sources marked DISABLED still go through the legacy path so
   *   reports keep working during a partial migration.
   *
   * The actual delegation lives inside `executeReport()` so the
   * legacy code path is untouched when the flag is OFF.
   */
  private isTenantSafeRoute(source: string): boolean {
    if (!this.flags.tenantSafeReportsEnabled()) return false;
    // One-shot bypass used by `executeReportTenantSafe` when context is
    // missing AND TENANT_CONTEXT_REQUIRED_FOR_SAFE_REPORTS=false. Lets
    // a single re-entry fall through to the legacy engine without
    // ever returning to the safe path within the same call.
    if ((this as any).__forceLegacyOnce) return false;
    const m = TENANT_SAFE_SOURCES[source];
    return !!m && m.status === 'READY';
  }

  // ── Phase 3 Reports Hardening — Phase A helpers ──────────────────────────

  /**
   * Resolve the caller's effective permission set (role + agency
   * overrides), mirroring the RolesGuard lookup. Used by the per-source
   * gate so a user with `reports:read` can't build, run, or export a
   * Finance/Attendance/Document source they have no module access to.
   */
  private async resolveCallerPermissions(userId?: string, agencyId?: string): Promise<Set<string>> {
    if (!userId) return new Set();
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        role: { select: { permissions: { select: { permission: { select: { name: true } } } } } },
      },
    });
    const set = new Set<string>((user?.role?.permissions ?? []).map(rp => rp.permission.name));
    if (agencyId) {
      const overrides = await this.prisma.agencyPermissionOverride.findMany({
        where: { agencyId },
        select: { permission: true, allow: true },
      });
      for (const o of overrides) {
        if (o.allow) set.add(o.permission);
        else set.delete(o.permission);
      }
    }
    return set;
  }

  /**
   * Throw ForbiddenException if the caller lacks the parent-module
   * permission gating the requested data source. Sources not listed
   * in REPORT_SOURCE_PERMISSION are treated as catalog/global and need
   * only the generic `reports:read` (the controller already enforces it).
   */
  private async assertSourcePermitted(source: string, caller?: { id?: string; agencyId?: string }) {
    const required = REPORT_SOURCE_PERMISSION[source];
    if (!required) return; // catalog/global source
    const perms = await this.resolveCallerPermissions(caller?.id, caller?.agencyId);
    if (!perms.has(required)) {
      throw new ForbiddenException({
        code: 'REPORT.SOURCE_FORBIDDEN',
        message: `You do not have permission to build reports on "${source}".`,
        params: { source, required },
      });
    }
  }

  /** Enforce at-least-one column for create/update/preview. */
  private assertColumnsNotEmpty(columns?: { columnName: string }[]) {
    if (!columns || columns.length === 0) {
      throw new BadRequestException({
        code: 'REPORT.COLUMNS_EMPTY',
        message: 'Select at least one column before previewing, saving, or running the report.',
      });
    }
  }

  /** Clamp an arbitrary client limit into the safe window. */
  private clampRunLimit(raw?: number | string): number {
    const n = Number(raw ?? 100);
    if (!Number.isFinite(n) || n <= 0) return 100;
    return Math.min(Math.max(1, Math.floor(n)), REPORTS_RUN_MAX_LIMIT);
  }

  // ── Schema introspection ─────────────────────────────────────────────────

  /**
   * List sources the CALLER is entitled to build reports on, given
   * their parent-module permissions. Sources with no entry in the
   * permission map (catalog/global) are always returned.
   */
  async getDataSources(caller?: { id?: string; agencyId?: string }) {
    const perms = caller?.id ? await this.resolveCallerPermissions(caller.id, caller.agencyId) : null;
    return Object.entries(SOURCE_DEFS)
      .filter(([key]) => {
        const required = REPORT_SOURCE_PERMISSION[key];
        if (!required) return true;             // global/catalog
        if (!perms) return false;               // anonymous: empty list
        return perms.has(required);
      })
      .map(([key, def]) => ({
        key,
        label: def.label,
        group: def.group,
        tables: def.tables,
        // Phase 3 Reports Hardening — Phase D: surface `hideByDefault`
        // so the frontend can collapse raw-UUID columns behind a
        // "Show advanced" toggle, and `defaultColumns` so the builder
        // can pre-populate business-friendly identifiers when the
        // source is picked.
        fields: Object.entries(def.fields).map(([f, meta]) => ({
          key: f,
          label: meta.label,
          type: meta.type,
          hideByDefault: meta.hideByDefault ?? false,
        })),
        defaultColumns: def.defaultColumns ?? [],
      }));
  }

  // ── Phase 3 Reports Hardening — Phase B (#17) ownership / sharing ───────

  /**
   * Permission rank used to compare an actor's grant against an
   * operation. Higher number ⇒ more capability.
   *   VIEW(1)  RUN(2)  EDIT(3)  SHARE(4)
   */
  private static readonly SHARE_RANK: Record<string, number> = {
    VIEW: 1, RUN: 2, EDIT: 3, SHARE: 4,
  };

  private grantRank(p?: string | null): number {
    return p ? (ReportsService.SHARE_RANK[p] ?? 0) : 0;
  }

  /**
   * Resolve the access level the actor has on a report.
   *   - owner             → SHARE (full)
   *   - PUBLIC_IN_TENANT  → RUN   (same-tenant + reports:read; edit/share still need explicit grant)
   *   - explicit share    → whatever the row says
   *   - otherwise         → null  (no access; treat as 404 to avoid existence-disclosure)
   */
  private async resolveReportAccess(
    report: { id: string; createdById: string | null; tenantId: string | null; visibility: any },
    caller?: { id?: string; agencyId?: string; tenantId?: string | null },
  ): Promise<{ level: 'OWNER' | 'SHARE' | 'EDIT' | 'RUN' | 'VIEW' | null }> {
    if (!caller?.id) return { level: null };
    if (report.createdById && report.createdById === caller.id) return { level: 'OWNER' };

    // Explicit share row wins over visibility-derived access, unless
    // tenant fences exclude the actor.
    const share = await this.prisma.reportShare.findUnique({
      where: { reportId_userId: { reportId: report.id, userId: caller.id } },
      select: { permission: true },
    });
    // Cross-tenant rejection: a shared user from a different tenant
    // must not gain access just because someone shared it with them.
    const sameTenant = !!(report.tenantId && caller.tenantId && report.tenantId === caller.tenantId);
    if (share && sameTenant) {
      return { level: share.permission as any };
    }

    if (report.visibility === 'PUBLIC_IN_TENANT' && sameTenant) {
      const perms = await this.resolveCallerPermissions(caller.id, caller.agencyId);
      if (perms.has('reports:read')) return { level: 'RUN' };
    }
    return { level: null };
  }

  private async assertReportAccessOrThrow(
    report: any,
    caller: any,
    needed: 'VIEW' | 'RUN' | 'EDIT' | 'SHARE',
  ): Promise<void> {
    const { level } = await this.resolveReportAccess(report, caller);
    if (level === 'OWNER') return; // owner always wins
    const have = this.grantRank(level);
    const want = this.grantRank(needed);
    if (have < want) {
      // Use 404 instead of 403 so we don't disclose the existence of
      // reports in other tenants / shared spaces the actor can't see.
      throw new NotFoundException({ code: 'REPORT.NOT_FOUND', message: 'Report not found' });
    }
  }

  /** WHERE clause that limits a list query to reports the actor can see. */
  private async accessibleReportsWhere(caller?: { id?: string; tenantId?: string | null; agencyId?: string }) {
    if (!caller?.id) return { id: '__none__' }; // anonymous: empty
    const perms = await this.resolveCallerPermissions(caller.id, caller.agencyId);
    const reportsRead = perms.has('reports:read');
    const ors: any[] = [
      { createdById: caller.id },                                  // owner
      { shares: { some: { userId: caller.id } } },                 // sharee (tenant-fenced below)
    ];
    if (reportsRead && caller.tenantId) {
      ors.push({ visibility: 'PUBLIC_IN_TENANT', tenantId: caller.tenantId }); // public-in-tenant
    }
    return { deletedAt: null, OR: ors };
  }

  // ── CRUD ─────────────────────────────────────────────────────────────────

  async create(dto: CreateReportDto, userId?: string, caller?: { agencyId?: string; tenantId?: string | null }) {
    await this.assertSourcePermitted(dto.dataSource, { id: userId, agencyId: caller?.agencyId });
    this.assertColumnsNotEmpty(dto.columns);

    return this.prisma.report.create({
      data: {
        name:        dto.name,
        description: dto.description,
        dataSource:  dto.dataSource,
        createdById: userId,
        tenantId:    caller?.tenantId ?? null,
        // visibility defaults to PRIVATE at the column level; we set it
        // explicitly so the audit log records it.
        visibility:  'PRIVATE' as any,
        filters: { create: (dto.filters  ?? []).map(this.mapFilter) },
        columns: { create: (dto.columns  ?? []).map(this.mapColumn) },
        sorting: { create: (dto.sorting  ?? []).map(this.mapSorting) },
      },
      include: this.include,
    });
  }

  async findAll(
    caller?: { id?: string; agencyId?: string; agencyIsSystem?: boolean; tenantId?: string | null },
    tenantIdQuery?: string,
  ) {
    // Phase 3 Reports Hardening — list only reports the actor can see.
    // Phase F2 (SPIKE-010) — SUPER USER may override the session tenant
    // for the access check via ?tenantId=. Non-SUPER callers' value is
    // dropped (helper checks agencyIsSystem === true).
    const effectiveCaller = caller
      ? { ...caller, tenantId: (caller.agencyIsSystem && tenantIdQuery?.trim()) ? tenantIdQuery.trim() : caller.tenantId }
      : caller;
    const where = await this.accessibleReportsWhere(effectiveCaller);
    return this.prisma.report.findMany({
      where,
      include: this.include,
      orderBy: { updatedAt: 'desc' },
    });
  }

  /** Internal lookup with no access check — only used by methods that
   *  immediately gate it via `assertReportAccessOrThrow`. */
  private async loadReportRaw(id: string) {
    const report = await this.prisma.report.findFirst({
      where: { id, deletedAt: null },
      include: this.include,
    });
    if (!report) throw new NotFoundException({ code: 'REPORT.NOT_FOUND', message: 'Report not found' });
    return report;
  }

  async findOne(id: string, caller?: { id?: string; agencyId?: string; tenantId?: string | null }) {
    const report = await this.loadReportRaw(id);
    if (caller) await this.assertReportAccessOrThrow(report, caller, 'VIEW');
    return report;
  }

  async update(id: string, dto: UpdateReportDto, caller?: { id?: string; agencyId?: string; tenantId?: string | null }) {
    const report = await this.loadReportRaw(id);
    // Editing requires EDIT level (owner counts automatically).
    if (caller) await this.assertReportAccessOrThrow(report, caller, 'EDIT');
    if (dto.dataSource) await this.assertSourcePermitted(dto.dataSource, caller);
    this.assertColumnsNotEmpty(dto.columns);
    await this.prisma.$transaction([
      this.prisma.reportFilter.deleteMany({ where: { reportId: id } }),
      this.prisma.reportColumn.deleteMany({ where: { reportId: id } }),
      this.prisma.reportSorting.deleteMany({ where: { reportId: id } }),
      this.prisma.report.update({
        where: { id },
        data: {
          name: dto.name, description: dto.description, dataSource: dto.dataSource,
          filters: { create: (dto.filters  ?? []).map(this.mapFilter) },
          columns: { create: (dto.columns  ?? []).map(this.mapColumn) },
          sorting: { create: (dto.sorting  ?? []).map(this.mapSorting) },
        },
      }),
    ]);
    return this.loadReportRaw(id);
  }

  async remove(id: string, caller?: { id?: string; agencyId?: string; tenantId?: string | null }) {
    const report = await this.loadReportRaw(id);
    // Delete is owner-only by design (Phase B). A SHARE-level grant
    // does NOT permit delete; the share model can't grant destructive
    // power on someone else's report.
    if (caller) {
      const { level } = await this.resolveReportAccess(report, caller);
      if (level !== 'OWNER') {
        throw new NotFoundException({ code: 'REPORT.NOT_FOUND', message: 'Report not found' });
      }
    }
    await this.prisma.report.update({ where: { id }, data: { deletedAt: new Date(), deletedBy: caller?.id ?? null } });
    return { message: 'Report deleted' };
  }

  private get include() {
    return {
      filters: true,
      columns: { orderBy: { position: 'asc' as const } },
      sorting: { orderBy: { position: 'asc' as const } },
      // Phase 3 Reports Hardening — display createdBy + shares so the
      // future UI can render "Created by … · Shared with N · Visibility".
      createdBy: { select: { id: true, firstName: true, lastName: true, email: true } },
      shares: {
        select: {
          userId: true,
          permission: true,
          grantedById: true,
          grantedAt: true,
          // Don't pull full user rows; the UI can join on userId when
          // it lands. Phase B keeps this lean.
        },
      },
    };
  }

  // ── Sharing endpoints (Phase B, backend-only) ───────────────────────────

  async setVisibility(
    id: string,
    visibility: 'PRIVATE' | 'SHARED' | 'PUBLIC_IN_TENANT',
    caller?: { id?: string; agencyId?: string; tenantId?: string | null },
  ) {
    const report = await this.loadReportRaw(id);
    if (caller) {
      // Visibility is an ownership-tier operation. SHARE grants alone
      // can't make a private report public; only the owner.
      const { level } = await this.resolveReportAccess(report, caller);
      if (level !== 'OWNER') {
        throw new NotFoundException({ code: 'REPORT.NOT_FOUND', message: 'Report not found' });
      }
    }
    await this.prisma.report.update({ where: { id }, data: { visibility: visibility as any } });
    return this.loadReportRaw(id);
  }

  async shareWithUser(
    id: string,
    body: { userId: string; permission?: 'VIEW' | 'RUN' | 'EDIT' | 'SHARE' },
    caller?: { id?: string; agencyId?: string; tenantId?: string | null },
  ) {
    const report = await this.loadReportRaw(id);
    if (caller) await this.assertReportAccessOrThrow(report, caller, 'SHARE');
    if (!body?.userId) {
      throw new BadRequestException({ code: 'REPORT.SHARE_USER_REQUIRED', message: 'userId is required' });
    }
    // Cross-tenant share guard: the grantee must belong to the same
    // tenant as the report. Use the user's primary agency tenant.
    const grantee = await this.prisma.user.findUnique({
      where: { id: body.userId },
      select: { id: true, agency: { select: { tenantId: true } } },
    });
    if (!grantee) {
      throw new BadRequestException({ code: 'REPORT.SHARE_USER_NOT_FOUND', message: 'User not found' });
    }
    const granteeTenantId = (grantee as any).agency?.tenantId ?? null;
    if (report.tenantId && granteeTenantId && report.tenantId !== granteeTenantId) {
      throw new BadRequestException({
        code: 'REPORT.SHARE_CROSS_TENANT',
        message: 'Cannot share a report with a user outside the report tenant.',
      });
    }
    const permission = (body.permission ?? 'VIEW') as any;
    await this.prisma.reportShare.upsert({
      where: { reportId_userId: { reportId: id, userId: body.userId } },
      update: { permission, grantedById: caller?.id ?? null },
      create: { reportId: id, userId: body.userId, permission, grantedById: caller?.id ?? null },
    });
    // Sharing implicitly promotes a PRIVATE report to SHARED so the
    // list visibility reflects the change.
    if ((report as any).visibility === 'PRIVATE') {
      await this.prisma.report.update({ where: { id }, data: { visibility: 'SHARED' as any } });
    }
    return this.loadReportRaw(id);
  }

  async revokeShare(
    id: string,
    userId: string,
    caller?: { id?: string; agencyId?: string; tenantId?: string | null },
  ) {
    const report = await this.loadReportRaw(id);
    if (caller) await this.assertReportAccessOrThrow(report, caller, 'SHARE');
    await this.prisma.reportShare.deleteMany({ where: { reportId: id, userId } });
    return this.loadReportRaw(id);
  }

  private mapFilter  = (f: ReportFilterDto)  => ({ fieldName: f.fieldName, operator: f.operator, value: f.value ?? '', value2: f.value2, valueType: f.valueType ?? 'string' });
  private mapColumn  = (c: ReportColumnDto)  => ({ columnName: c.columnName, displayName: c.displayName, dataType: c.dataType ?? 'string', isGrouped: c.isGrouped ?? false, isAggregated: c.isAggregated ?? false, aggregationType: c.aggregationType, position: c.position ?? 0 });
  private mapSorting = (s: ReportSortingDto) => ({ columnName: s.columnName, direction: s.direction ?? 'ASC', position: s.position ?? 0 });

  // ── Run (dynamic query) ───────────────────────────────────────────────────

  async run(id: string, opts: RunReportDto = {}, caller?: { id?: string; agencyId?: string; tenantId?: string | null }) {
    const report = await this.loadReportRaw(id);
    // Phase 3 Reports Hardening — Phase B: gate by per-user access
    // (RUN or higher), then the source permission, then clamp the page.
    if (caller) await this.assertReportAccessOrThrow(report, caller, 'RUN');
    await this.assertSourcePermitted(report.dataSource, caller);
    const safeLimit = this.clampRunLimit(opts.limit);
    return this.executeReport(report, { ...opts, limit: safeLimit });
  }

  /**
   * Phase 3 Reports Hardening (Phase A) — preview an UNSAVED report
   * definition. Does not persist anything. Returns at most
   * REPORTS_PREVIEW_LIMIT rows. Used by the frontend "Preview" button
   * so a user can iterate on a draft without polluting the saved
   * reports list.
   *
   * Per-source permissions and tenant safety apply identically to the
   * saved-report Run path; this method is purely a "build it in
   * memory, run it, throw it away" shortcut.
   */
  async previewInline(
    dto: { dataSource: string; columns?: ReportColumnDto[]; filters?: ReportFilterDto[]; sorting?: ReportSortingDto[] },
    caller?: { id?: string; agencyId?: string },
  ) {
    if (!dto?.dataSource) {
      throw new BadRequestException({ code: 'REPORT.DATA_SOURCE_REQUIRED', message: 'dataSource is required.' });
    }
    await this.assertSourcePermitted(dto.dataSource, caller);
    this.assertColumnsNotEmpty(dto.columns);

    const ephemeral = {
      id: '__preview__',
      dataSource: dto.dataSource,
      filters: (dto.filters  ?? []).map(this.mapFilter),
      columns: (dto.columns  ?? []).map(this.mapColumn),
      sorting: (dto.sorting  ?? []).map(this.mapSorting),
    } as any;
    return this.executeReport(ephemeral, { page: 1, limit: REPORTS_PREVIEW_LIMIT });
  }

  /**
   * Tenant-safe execution path (Phase 2.1).
   *
   * Implementation strategy: the dormant runtime under
   * `src/saas/reports/runtime/` builds the WHERE / SELECT / FROM via
   * `buildTenantSafeWhere` and the safe registry. This adapter mounts
   * the same builder inline (no SaaS-module-DI coupling required),
   * derives the active tenant from the `RequestContext` ALS frame,
   * runs the SQL through `this.prisma.$queryRawUnsafe` ONLY because
   * the SQL string is fully static (identifiers via the registry) and
   * all values are positional parameters.
   *
   * Fails loud when:
   *   - flag is ON but no tenant context is in scope
   *   - source is not in the safe registry as READY
   *   - the safe builder rejects the request
   *
   * The legacy code path is untouched.
   */
  private async executeReportTenantSafe(
    report: any,
    opts: RunReportDto,
  ): Promise<{ columns: any[]; rows: any[]; total: number; page: number; limit: number }> {
    /* eslint-disable @typescript-eslint/no-require-imports */
    // Local require keeps this off the legacy module-load path so
    // disabling the flag literally executes zero new code.
    const { TENANT_SAFE_SOURCES: SOURCES } = require('../saas/reports/runtime/report-sources');
    const { composeReportSql } = require('../saas/reports/runtime/compose-sql');
    const { TenantContext, UserContext } = require('../saas/context/als');
    /* eslint-enable @typescript-eslint/no-require-imports */

    const m = SOURCES[report.dataSource as string];
    if (!m || m.status !== 'READY' || !m.def) {
      throw new BadRequestException({
        code: 'REPORT.TENANT_SAFE_SOURCE_DISABLED',
        message: `Source "${report.dataSource}" is not enabled in tenant-safe mode.`,
        detail: m?.reason,
      });
    }

    const tenant = TenantContext.optional?.();
    if (!tenant) {
      // Phase 2.2: when TENANT_CONTEXT_REQUIRED_FOR_SAFE_REPORTS=true,
      // we fail loud as before. When false, we fall back to the legacy
      // engine for this single request — letting staging operators
      // gradually flip flags without bricking traffic. The legacy
      // engine is invoked transparently by re-entering executeReport.
      if (this.flags.tenantContextRequiredForSafeReports()) {
        throw new BadRequestException({
          code: 'REPORT.TENANT_CONTEXT_REQUIRED',
          message: 'Tenant-safe reports require an active TenantContext. ' +
            'Set TENANT_CONTEXT_REQUIRED_FOR_SAFE_REPORTS=false to allow legacy fallback.',
        });
      }
      // Soft fallback to legacy. Disable the safe route for this call.
      const opts2 = opts;
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      const self = this as any;
      const prevFlag = self.__forceLegacyOnce;
      self.__forceLegacyOnce = true;
      try { return await this.executeReport(report, opts2); }
      finally { self.__forceLegacyOnce = prevFlag; }
    }
    const user = UserContext.optional?.() ?? null;

    const filters: any[] = (report.filters ?? []).map((f: any) => ({
      field: f.columnName ?? f.field,
      op: f.operator ?? f.op ?? '=',
      value: f.value,
      values: f.values,
    }));
    const cols: string[] = (report.columns ?? []).map((c: any) => c.columnName ?? c).filter(Boolean);

    const composed = composeReportSql(
      { def: m.def, filters, columns: cols, page: opts.page, limit: opts.limit },
      { tenantId: tenant.id, agencyIds: user?.agencyIds, platformAdmin: !!user?.platformAdmin },
    );

    // The SQL was composed by the safe runtime under
    // backend/src/saas/reports/runtime/. Identifiers come from the
    // validated SourceDef; values are positional parameters; the
    // tenant filter is the FIRST AND-term.
    const rows = await this.prisma.$queryRawUnsafe<any[]>(composed.sql, ...composed.params); // @tenant-reviewed: tenant-safe-report-runtime
    const totalRows = await this.prisma.$queryRawUnsafe<{ n: number }[]>(composed.countSql, ...composed.params); // @tenant-reviewed: tenant-safe-report-runtime
    const total = totalRows[0]?.n ?? 0;

    return {
      columns: composed.columns,
      rows,
      total,
      page: composed.page,
      limit: composed.limit,
    };
  }

  private async executeReport(
    report: any,
    opts: RunReportDto,
  ): Promise<{ columns: any[]; rows: any[]; total: number; page: number; limit: number }> {
    // Phase 2.1: when the tenant-safe flag is on AND the source is
    // mapped READY, route through the new runtime. Any failure here
    // throws — we deliberately do NOT fall back silently to the
    // legacy engine, because that would mask tenant-safety bugs.
    if (this.isTenantSafeRoute(report.dataSource)) {
      return this.executeReportTenantSafe(report, opts);
    }

    const { page = 1 } = opts;
    // Phase 3 Reports Hardening — defence in depth. Any caller path
    // that reaches the legacy engine still gets bounded rows even if
    // it somehow bypassed the `run()` / `previewInline()` clamps.
    const limit = this.clampRunLimit(opts.limit);
    const source = report.dataSource as string;
    const def = SOURCE_DEFS[source];
    if (!def) throw new BadRequestException(`Unknown data source: ${source}`);

    const { primaryTable, primaryAlias, softDelete, joins, fields } = def;

    // ── Column selection ─────────────────────────────────────────────────
    const cols: any[] = report.columns.length
      ? report.columns
      : Object.entries(fields).map(([k, v]) => ({
          columnName: k, displayName: v.label,
          isAggregated: false, aggregationType: null, isGrouped: false,
        }));

    const selectParts: string[] = [];
    for (const col of cols) {
      const f = fields[col.columnName];
      if (!f) continue;
      const colRef = `${f.alias}."${f.dbCol}"`;
      if (col.isAggregated && col.aggregationType) {
        selectParts.push(`${col.aggregationType}(${colRef}) AS "${col.columnName}"`);
      } else {
        selectParts.push(`${colRef} AS "${col.columnName}"`);
      }
    }
    if (selectParts.length === 0) selectParts.push(`${primaryAlias}.*`);

    // ── FROM + JOIN ───────────────────────────────────────────────────────
    const joinFragments = joins.map(j =>
      `${j.joinType} JOIN "${j.table}" AS ${j.alias} ON ${j.on}`,
    );
    const fromFragment = `"${primaryTable}" AS ${primaryAlias}${joinFragments.length ? ' ' + joinFragments.join(' ') : ''}`;

    // ── WHERE clause ─────────────────────────────────────────────────────
    const conditions: Prisma.Sql[] = softDelete
      ? [Prisma.sql`${Prisma.raw(`${primaryAlias}."deletedAt"`)} IS NULL`]
      : [];

    for (const filter of (report.filters as any[])) {
      const f = fields[filter.fieldName];
      if (!f) continue; // whitelist: skip unknown fields

      const col    = Prisma.raw(`${f.alias}."${f.dbCol}"`);
      const casted = this.castValue(filter.value, filter.valueType);

      switch (filter.operator) {
        case 'eq':          conditions.push(Prisma.sql`${col} = ${casted}`); break;
        case 'ne':          conditions.push(Prisma.sql`${col} != ${casted}`); break;
        case 'gt':          conditions.push(Prisma.sql`${col} > ${casted}`); break;
        case 'gte':         conditions.push(Prisma.sql`${col} >= ${casted}`); break;
        case 'lt':          conditions.push(Prisma.sql`${col} < ${casted}`); break;
        case 'lte':         conditions.push(Prisma.sql`${col} <= ${casted}`); break;
        case 'like':        conditions.push(Prisma.sql`${col} ILIKE ${'%' + filter.value + '%'}`); break;
        case 'between': {
          const c2 = filter.value2 ? this.castValue(filter.value2, filter.valueType) : null;
          if (c2 !== null) conditions.push(Prisma.sql`${col} BETWEEN ${casted} AND ${c2}`);
          break;
        }
        case 'in': {
          const vals = (filter.value || '').split(',').map((v: string) => this.castValue(v.trim(), filter.valueType));
          if (vals.length) conditions.push(Prisma.sql`${col} = ANY(${vals})`);
          break;
        }
        case 'is_null':     conditions.push(Prisma.sql`${col} IS NULL`);     break;
        case 'is_not_null': conditions.push(Prisma.sql`${col} IS NOT NULL`); break;
      }
    }

    const whereClause = conditions.length ? Prisma.join(conditions, ' AND ') : Prisma.sql`TRUE`;

    // ── GROUP BY ──────────────────────────────────────────────────────────
    const groupedCols = cols.filter((c: any) => c.isGrouped && fields[c.columnName]);
    const groupByClause = groupedCols.length
      ? Prisma.sql`GROUP BY ${Prisma.join(
          groupedCols.map((c: any) => Prisma.raw(`${fields[c.columnName].alias}."${fields[c.columnName].dbCol}"`)),
          ', ',
        )}`
      : Prisma.empty;

    // ── ORDER BY ──────────────────────────────────────────────────────────
    const sortParts = (report.sorting as any[])
      .filter((s: any) => fields[s.columnName])
      .map((s: any) => Prisma.raw(
        `${fields[s.columnName].alias}."${fields[s.columnName].dbCol}" ${s.direction === 'DESC' ? 'DESC' : 'ASC'}`,
      ));
    const fallbackOrder = `${primaryAlias}."createdAt" DESC`;
    const orderByClause = sortParts.length
      ? Prisma.sql`ORDER BY ${Prisma.join(sortParts, ', ')}`
      : Prisma.sql`ORDER BY ${Prisma.raw(fallbackOrder)}`;

    // ── Count ─────────────────────────────────────────────────────────────
    const offset = (Number(page) - 1) * Number(limit);
    // For joined sources use COUNT(DISTINCT primary key) to avoid inflated counts from 1-to-many joins
    const countExpr = joins.length
      ? `COUNT(DISTINCT ${primaryAlias}."id")`
      : 'COUNT(*)';
    const countSql = Prisma.sql`
      SELECT ${Prisma.raw(countExpr)} AS total
      FROM ${Prisma.raw(fromFragment)}
      WHERE ${whereClause}
    `;
    const countResult: any[] = await this.prisma.$queryRaw(countSql);
    const total = groupedCols.length ? 0 : Number(countResult[0]?.total ?? 0);

    // ── Data ──────────────────────────────────────────────────────────────
    const dataSql = Prisma.sql`
      SELECT ${Prisma.raw(selectParts.join(', '))}
      FROM ${Prisma.raw(fromFragment)}
      WHERE ${whereClause}
      ${groupByClause}
      ${orderByClause}
      LIMIT ${Number(limit)} OFFSET ${offset}
    `;
    const rows: any[] = await this.prisma.$queryRaw(dataSql);
    const safeRows = rows.map(r => {
      const out: Record<string, any> = {};
      for (const [k, v] of Object.entries(r)) {
        out[k] = typeof v === 'bigint' ? Number(v) : v;
      }
      return out;
    });

    return {
      columns: cols
        .filter((c: any) => fields[c.columnName])
        .map((c: any) => ({ key: c.columnName, label: c.displayName, type: fields[c.columnName]?.type ?? 'string' })),
      rows: safeRows,
      total: groupedCols.length ? safeRows.length : total,
      page:  Number(page),
      limit: Number(limit),
    };
  }

  // ── Export ────────────────────────────────────────────────────────────────

  async export(
    id: string,
    format: ExportFormat,
    locale: ServerLocale = 'en',
    caller?: { id?: string; agencyId?: string; tenantId?: string | null },
  ): Promise<{ buffer: Buffer; mimeType: string; filename: string }> {
    const report = await this.loadReportRaw(id);
    if (caller) await this.assertReportAccessOrThrow(report, caller, 'RUN');
    const { columns, rows } = await this.executeReport(report, { page: 1, limit: 50000 });
    switch (format) {
      case ExportFormat.EXCEL: return this.toExcel(report, columns, rows, locale);
      case ExportFormat.PDF:   return this.toPdf(report, columns, rows, locale);
      case ExportFormat.WORD:  return this.toWord(report, columns, rows, locale);
      default: throw new BadRequestException(`Unsupported format: ${format}`);
    }
  }

  // ── Dashboard ─────────────────────────────────────────────────────────────

  async getDashboard(actor?: { role?: string; agencyId?: string; agencyIsSystem?: boolean; tenantId?: string | null }) {
    const now              = new Date();
    const startOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const fwd60            = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000);

    // External tenants (anyone whose agency is not the Tempworks
    // root) are scoped to their own agency's candidates, regardless
    // of role name. Agency-side roles further restrict to CANDIDATE
    // tier so Lead counts never surface in their dashboard.
    const isExternalActor = !!actor?.agencyId && (actor as any)?.agencyIsSystem !== true;
    // Phase 2 (#5 #8) — every aggregation also follows the caller's
    // currently-selected tenant, so the dashboard cards never count
    // records from a tenant the user isn't switched into.
    //
    // Use the same SUPER tenant predicate the list pages use
    // (Employees/Applicants/...) so a SUPER-selected tenant catches
    // records whose own tenantId is null/mis-stamped but whose
    // agency belongs to the selected tenant. Without this the
    // dashboard tile is strictly smaller than the list total.
    const superTenantPredicate = buildSuperUserTenantWhere(actor as any, actor?.tenantId ?? null);
    const tenantFilter: any = superTenantPredicate
      ? { AND: [superTenantPredicate] }
      : (actor?.tenantId ? { tenantId: actor.tenantId } : {});
    // The Applicants page lists LEAD-tier rows (Candidates and
    // Employees live on their own pages). Match that scope here so
    // the "View All Applicants" deep link lands on the same total.
    const applicantScope: any = { deletedAt: null, tier: 'LEAD' as any, ...tenantFilter };
    if (isExternalActor) {
      applicantScope.agencyId = actor!.agencyId;
    }

    // Document tenant predicate must match what the Documents &
    // Compliance list page uses, otherwise the dashboard tiles
    // disagree with the list (and with its own KPI tiles). We need
    // the entity-based fallback: a doc whose own tenantId is null /
    // mis-stamped still belongs to the tenant when its owning
    // employee/applicant/agency does. Without this fallback the
    // dashboard counter is strictly smaller than the list count.
    let docTenantWhere: any = {};
    if (actor?.tenantId) {
      const targetTenantId = actor.tenantId;
      const [empIdsRow, appIdsRow, agencyIdsRow] = await Promise.all([
        this.prisma.employee.findMany({ where: { tenantId: targetTenantId }, select: { id: true } }),
        this.prisma.applicant.findMany({ where: { tenantId: targetTenantId }, select: { id: true } }),
        this.prisma.agency.findMany({ where: { tenantId: targetTenantId }, select: { id: true } }),
      ]);
      const entityOr: any[] = [{ tenantId: targetTenantId }];
      if (empIdsRow.length)     entityOr.push({ entityType: 'EMPLOYEE',  entityId: { in: empIdsRow.map(e => e.id) } });
      if (appIdsRow.length)     entityOr.push({ entityType: 'APPLICANT', entityId: { in: appIdsRow.map(a => a.id) } });
      if (agencyIdsRow.length)  entityOr.push({ entityType: 'AGENCY',    entityId: { in: agencyIdsRow.map(a => a.id) } });
      docTenantWhere = { OR: entityOr };
    }

    // Employee counts in the dashboard cards must honour the same
    // rules the employees list does: every external tenant — any role
    // inside a non-system agency — sees only the subset of employees
    // explicitly granted via EmployeeAgencyAccess. Tempworks-root
    // users keep the global view.
    const employeeScope: any = { deletedAt: null, ...tenantFilter };
    if (isExternalActor) {
      const grants = await this.prisma.employeeAgencyAccess.findMany({
        where: { agencyId: actor!.agencyId!, canView: true },
        select: { employeeId: true },
      });
      const allowedIds = grants.map((g: { employeeId: string }) => g.employeeId);
      employeeScope.id = { in: allowedIds.length ? allowedIds : [''] };
    }

    const [
      totalEmp, activeEmp, empThisMonth,
      pendingApps, totalApp, appByStatus,
      expiringSoonCount, expiredUnrenewedCount,
      stageTemplates,
      avgDaysResult,
      approvedCount, decidedCount,
      recentEmployees,
      expiredDocsList,
      recentActivity,
    ] = await Promise.all([
      // ── Employees ──
      this.prisma.employee.count({ where: employeeScope }),
      this.prisma.employee.count({ where: { ...employeeScope, status: 'ACTIVE' } }),
      this.prisma.employee.count({ where: { ...employeeScope, createdAt: { gte: startOfThisMonth } } }),

      // ── Applicants ──
      // "Pending" = status NEW (submitted but no action taken yet)
      this.prisma.applicant.count({ where: { ...applicantScope, status: 'NEW' } }),
      this.prisma.applicant.count({ where: applicantScope }),
      this.prisma.applicant.groupBy({ by: ['status'], where: applicantScope, _count: { id: true } }),

      // ── Documents ──
      // Aligned with /documents/kpis so dashboard tiles always match
      // the Documents & Compliance page counters and list.
      // Expiring soon: expiryDate in (now, +60 days] (excludes already expired)
      this.prisma.document.count({ where: { deletedAt: null, expiryDate: { not: null, gt: now, lte: fwd60 }, ...docTenantWhere } }),
      // Expired: live expiryDate < now OR stored EXPIRED status. We
      // intentionally do NOT exclude renewed docs — the documents list
      // shows them and the count must match. AND the two OR groups
      // (tenant fallback OR + expired-status OR) so neither dissolves.
      this.prisma.document.count({ where: { deletedAt: null, AND: [...(docTenantWhere?.OR ? [{ OR: docTenantWhere.OR }] : []), { OR: [{ status: 'EXPIRED' as any }, { expiryDate: { lt: now } }] }] } }),

      // ── Pipeline (StageTemplates with active EmployeeStage counts) ──
      // Phase 3 (#1 R-1b) — scope the nested employeeStages count through
      // the parent Employee's tenant. EmployeeStage has no flat tenantId;
      // the relation predicate is the only safe filter.
      this.prisma.stageTemplate.findMany({
        where: { isActive: true },
        orderBy: { order: 'asc' },
        include: {
          _count: {
            select: {
              employeeStages: {
                where: {
                  status: 'IN_PROGRESS',
                  ...(actor?.tenantId ? { employee: { tenantId: actor.tenantId } } : {}),
                },
              },
            },
          },
        },
      }),

      // ── Avg processing days: average (completedAt - startedAt) across completed stages ──
      // Uses raw SQL because Prisma doesn't aggregate date diffs natively
      this.prisma.$queryRaw`
        SELECT COALESCE(
          AVG(EXTRACT(EPOCH FROM ("completedAt" - "startedAt")) / 86400.0), 0
        )::float AS avg_days
        FROM employee_stages
        WHERE status = 'COMPLETED'
          AND "completedAt" IS NOT NULL
          AND "startedAt"   IS NOT NULL
      ` as Promise<{ avg_days: number }[]>,

      // ── Approval rate: approved / (approved + rejected) ──
      // Phase 3 (#1 R-1c) — scope through the relation chain
      // approval → progress → assignment → candidate.tenantId.
      // CandidateStageApproval has no flat tenantId; the candidate at
      // the end of the chain is the tenant authority.
      this.prisma.candidateStageApproval.count({
        where: {
          decision: 'APPROVED',
          ...(actor?.tenantId
            ? { progress: { assignment: { candidate: { tenantId: actor.tenantId } } } }
            : {}),
        },
      }),
      this.prisma.candidateStageApproval.count({
        where: {
          decision: { in: ['APPROVED', 'REJECTED'] },
          ...(actor?.tenantId
            ? { progress: { assignment: { candidate: { tenantId: actor.tenantId } } } }
            : {}),
        },
      }),

      // ── Recent employees: last 5 registrations ──
      this.prisma.employee.findMany({
        where: employeeScope,
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: {
          id: true, firstName: true, lastName: true,
          employeeNumber: true, status: true, createdAt: true, photoUrl: true,
        },
      }),

      // ── Expired documents (not yet renewed), latest 5 ──
      // Phase 3 (#1 R-1a) — scope to caller's tenant so the dashboard
      // detail list matches the counter four lines above. Without the
      // predicate SUPER + pilot-off would see expired documents from
      // every tenant while the count it sits under is correctly scoped.
      this.prisma.document.findMany({
        where: { deletedAt: null, expiryDate: { lt: now }, renewals: { none: {} }, ...(actor?.tenantId ? { tenantId: actor.tenantId } : {}) },
        orderBy: { expiryDate: 'asc' },
        take: 5,
        include: { documentType: { select: { name: true, code: true } } },
      }),

      // ── Recent activity from audit log, last 10 entries ──
      this.prisma.auditLog.findMany({
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { id: true, action: true, entity: true, entityId: true, userEmail: true, createdAt: true },
      }),
    ]);

    // Batch-resolve owner names for expired documents
    const eIds = expiredDocsList.filter(d => d.entityType === 'EMPLOYEE').map(d => d.entityId);
    const aIds = expiredDocsList.filter(d => d.entityType === 'APPLICANT').map(d => d.entityId);
    const [docEmps, docApps] = await Promise.all([
      eIds.length ? this.prisma.employee.findMany({ where: { id: { in: eIds } }, select: { id: true, firstName: true, lastName: true } }) : [],
      aIds.length ? this.prisma.applicant.findMany({ where: { id: { in: aIds } }, select: { id: true, firstName: true, lastName: true } }) : [],
    ]);
    const empNameMap = Object.fromEntries(docEmps.map(e => [e.id, `${e.firstName} ${e.lastName}`]));
    const appNameMap = Object.fromEntries(docApps.map(a => [a.id, `${a.firstName} ${a.lastName}`]));

    const avgDays = avgDaysResult[0]?.avg_days
      ? parseFloat((avgDaysResult[0].avg_days as any).toFixed(1))
      : null;
    const approvalRate = decidedCount > 0
      ? parseFloat(((approvedCount / decidedCount) * 100).toFixed(1))
      : null;

    return {
      // Widget 1: Total Employees
      // Widget 2: Active Employees
      employees: {
        total:        totalEmp,
        active:       activeEmp,
        newThisMonth: empThisMonth,  // delta = employees added this calendar month
      },

      // Widget 3: Pending Applications
      // "Pending" defined as: applicant.status = 'NEW' (submitted, no action taken yet)
      applicants: {
        total:   totalApp,
        pending: pendingApps,
        byStatus: appByStatus.map(a => ({ status: a.status, count: (a._count as any).id })),
      },

      // Widget 4: Expiring Documents
      // Widget 8: Expired Documents (not yet renewed)
      documents: {
        // expiringSoon: expiryDate in (now, now+60d]; already-expired excluded
        expiringSoon:          expiringSoonCount,
        // expiredUnrenewed: expiryDate < now AND no renewal document exists
        expiredUnrenewedCount: expiredUnrenewedCount,
      },

      // Widget 5: Recruitment Pipeline
      // stages: StageTemplate list with IN_PROGRESS employee count
      // avgProcessingDays: mean calendar days across all COMPLETED employee stages
      // approvalRate: approved / (approved+rejected) × 100 across all candidate stage approvals
      pipeline: {
        stages: stageTemplates.map(st => ({
          id:       st.id,
          name:     st.name,
          order:    st.order,
          category: st.category,
          color:    st.color,
          count:    (st._count as any).employeeStages,
        })),
        avgProcessingDays: avgDays,
        approvalRate:      approvalRate,
      },

      // Widget 7: Recent Employees
      recentEmployees,

      // Widget 8: Expired Documents List
      expiredDocuments: expiredDocsList.map(doc => ({
        id:           doc.id,
        docId:        doc.docId,
        name:         doc.name,
        entityType:   doc.entityType,
        entityId:     doc.entityId,
        expiryDate:   doc.expiryDate,
        status:       doc.status,
        documentType: doc.documentType,
        ownerName:    doc.entityType === 'EMPLOYEE'
          ? (empNameMap[doc.entityId] ?? null)
          : (appNameMap[doc.entityId] ?? null),
      })),

      // Widget 6: Recent Activity Feed
      // Source: AuditLog — covers all UPLOAD/VERIFY/REJECT/CREATE/UPDATE/DELETE events
      recentActivity,
    };
  }

  // ── Excel ─────────────────────────────────────────────────────────────────

  private async toExcel(report: any, columns: any[], rows: any[], locale: ServerLocale = 'en'): Promise<{ buffer: Buffer; mimeType: string; filename: string }> {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'TempWorks';
    wb.created = new Date();
    // Use the user-authored report name verbatim — that's user-authored
    // content, not a translatable label. Fall back to a localized
    // placeholder only when the report has no name.
    const sheetName = (report.name || tServer('reports.fallbackTitle', {}, locale, 'exports')).substring(0, 31);
    const ws = wb.addWorksheet(sheetName);

    // Title (columns.length data cols + 1 serial col)
    const lastCol = String.fromCharCode(64 + Math.max(columns.length + 1, 2));
    ws.mergeCells(`A1:${lastCol}1`);
    const titleCell = ws.getCell('A1');
    titleCell.value = report.name;
    titleCell.font  = { bold: true, size: 14, color: { argb: 'FF0F172A' } };
    titleCell.alignment = { horizontal: 'center' };

    ws.getCell('A2').value = `${tServer('common.exportedAt', {}, locale, 'exports')}: ${formatDisplayDateTime(new Date())}`;
    ws.getCell('A2').font  = { italic: true, size: 9, color: { argb: 'FF64748B' } };
    if (report.description) {
      ws.getCell('A3').value = report.description;
      ws.getCell('A3').font  = { size: 9, color: { argb: 'FF94A3B8' } };
    }

    // Header — first column is serial number
    const headerRow = ws.getRow(5);
    headerRow.height = 22;
    const noCell = headerRow.getCell(1);
    noCell.value = tServer('reports.rowNumber', {}, locale, 'exports');
    noCell.font  = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    noCell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };
    noCell.alignment = { horizontal: 'center', vertical: 'middle' };
    columns.forEach((col, i) => {
      const cell = headerRow.getCell(i + 2);
      cell.value = col.label;
      cell.font  = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
      cell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.border = { bottom: { style: 'thin', color: { argb: 'FF1D4ED8' } } };
    });

    // Data
    rows.forEach((row, ri) => {
      const wsRow = ws.getRow(ri + 6);
      // Serial number cell
      const snCell = wsRow.getCell(1);
      snCell.value = ri + 1;
      snCell.alignment = { horizontal: 'center' };
      if (ri % 2 === 1) snCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
      snCell.border = { bottom: { style: 'hair', color: { argb: 'FFE2E8F0' } }, right: { style: 'hair', color: { argb: 'FFE2E8F0' } } };
      // Data cells
      columns.forEach((col, ci) => {
        const cell = wsRow.getCell(ci + 2);
        cell.value = this.formatValue(row[col.key]);
        if (ri % 2 === 1) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
        cell.border = { bottom: { style: 'hair', color: { argb: 'FFE2E8F0' } }, right: { style: 'hair', color: { argb: 'FFE2E8F0' } } };
      });
    });

    ws.getColumn(1).width = 6; // # column
    columns.forEach((col, i) => {
      ws.getColumn(i + 2).width = Math.max(col.label.length + 4, 12);
    });

    const raw = await wb.xlsx.writeBuffer();
    const buffer = Buffer.from(raw as ArrayBuffer);
    return { buffer, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename: `${this.safeFilename(report.name)}.xlsx` };
  }

  // ── PDF ───────────────────────────────────────────────────────────────────

  private toPdf(report: any, columns: any[], rows: any[], locale: ServerLocale = 'en'): Promise<{ buffer: Buffer; mimeType: string; filename: string }> {
    return new Promise((resolve, reject) => {
      const doc    = new PDFDocument({ margin: 36, size: 'A4', layout: 'landscape' } as any);
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve({ buffer: Buffer.concat(chunks), mimeType: 'application/pdf', filename: `${this.safeFilename(report.name)}.pdf` }));
      doc.on('error', reject);

      // Title is the user-authored report.name — render verbatim.
      // The "Generated: <ts> | N records" subtitle uses localized
      // labels (`common.generatedAt`, `common.recordsSuffix`).
      const generatedLabel = tServer('common.generatedAt', {}, locale, 'exports');
      const recordsLabel   = tServer('common.recordsSuffix', {}, locale, 'exports');
      doc.fontSize(16).font('Helvetica-Bold').fillColor('#0F172A').text(report.name || tServer('reports.fallbackTitle', {}, locale, 'exports'), { align: 'center' });
      doc.fontSize(9).font('Helvetica').fillColor('#64748B').text(`${generatedLabel}: ${formatDisplayDateTime(new Date())}  |  ${rows.length} ${recordsLabel}`, { align: 'center' });
      if (report.description) doc.fontSize(9).fillColor('#94A3B8').text(report.description, { align: 'center' });
      doc.moveDown(0.6);

      const snW    = 24; // serial number column width
      const pageW  = (doc as any).page.width - 72 - snW;
      const colW   = Math.max(Math.floor(pageW / Math.max(columns.length, 1)), 55);
      const tblW   = snW + colW * columns.length;
      const startX = ((doc as any).page.width - tblW) / 2;
      const rowH   = 16;
      const hdrH   = 20;
      let y = (doc as any).y;

      // Header
      doc.rect(startX, y, tblW, hdrH).fill('#2563EB');
      doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(7.5);
      doc.text(tServer('reports.rowNumber', {}, locale, 'exports'), startX + 3, y + 6, { width: snW - 6, ellipsis: true });
      columns.forEach((col, i) => {
        // col.label is user-authored — render as-is.
        doc.text(col.label, startX + snW + i * colW + 3, y + 6, { width: colW - 6, ellipsis: true });
      });
      y += hdrH;

      // Rows
      doc.font('Helvetica').fontSize(7);
      rows.forEach((row, ri) => {
        if (y + rowH > (doc as any).page.height - 36) { doc.addPage(); y = 36; }
        if (ri % 2 === 0) doc.rect(startX, y, tblW, rowH).fill('#F8FAFC');
        doc.fillColor('#0F172A');
        doc.text(String(ri + 1), startX + 3, y + 4, { width: snW - 6, ellipsis: true });
        columns.forEach((col, i) => {
          doc.text(String(this.formatValue(row[col.key]) ?? ''), startX + snW + i * colW + 3, y + 4, { width: colW - 6, ellipsis: true });
        });
        doc.rect(startX, y, tblW, rowH).stroke('#E2E8F0');
        y += rowH;
      });

      // Footer brand prefix is localizable; report.name is user content.
      const brand = tServer('common.footerBrand', {}, locale, 'exports');
      doc.fillColor('#94A3B8').fontSize(8).text(`${brand} — ${report.name || ''}`.trim().replace(/—\s*$/, ''), 36, (doc as any).page.height - 20, { align: 'center' });
      doc.end();
    });
  }

  // ── Word ──────────────────────────────────────────────────────────────────

  private async toWord(report: any, columns: any[], rows: any[], locale: ServerLocale = 'en'): Promise<{ buffer: Buffer; mimeType: string; filename: string }> {
    const rowNumLabel = tServer('reports.rowNumber', {}, locale, 'exports');
    const snHeaderCell = new TableCell({
      children: [new Paragraph({ children: [new TextRun({ text: rowNumLabel, bold: true, color: 'FFFFFF', size: 20 })], spacing: { before: 80, after: 80 } })],
      shading: { fill: '2563EB' },
      margins: { top: 80, bottom: 80, left: 120, right: 120 },
    });

    const headerCells = [
      snHeaderCell,
      ...columns.map(col =>
        new TableCell({
          children: [new Paragraph({ children: [new TextRun({ text: col.label, bold: true, color: 'FFFFFF', size: 20 })], spacing: { before: 80, after: 80 } })],
          shading: { fill: '2563EB' },
          margins: { top: 80, bottom: 80, left: 120, right: 120 },
        }),
      ),
    ];

    const dataRows = rows.map((row, ri) =>
      new TableRow({
        children: [
          new TableCell({
            children: [new Paragraph({ children: [new TextRun({ text: String(ri + 1), size: 18 })], spacing: { before: 60, after: 60 } })],
            shading: ri % 2 === 1 ? { fill: 'F8FAFC' } : undefined,
            margins: { top: 60, bottom: 60, left: 120, right: 120 },
          }),
          ...columns.map(col =>
            new TableCell({
              children: [new Paragraph({ children: [new TextRun({ text: String(this.formatValue(row[col.key]) ?? ''), size: 18 })], spacing: { before: 60, after: 60 } })],
              shading: ri % 2 === 1 ? { fill: 'F8FAFC' } : undefined,
              margins: { top: 60, bottom: 60, left: 120, right: 120 },
            }),
          ),
        ],
      }),
    );

    const generatedLabel = tServer('common.generatedAt', {}, locale, 'exports');
    const recordsLabel   = tServer('common.recordsSuffix', {}, locale, 'exports');
    const heading        = report.name || tServer('reports.fallbackTitle', {}, locale, 'exports');
    const docObj = new Document({
      sections: [{
        children: [
          new Paragraph({ text: heading, heading: HeadingLevel.HEADING_1 }),
          new Paragraph({ children: [new TextRun({ text: `${generatedLabel}: ${formatDisplayDateTime(new Date())}  |  ${rows.length} ${recordsLabel}`, color: '64748B', italics: true, size: 18 })] }),
          ...(report.description ? [new Paragraph({ children: [new TextRun({ text: report.description, color: '94A3B8', size: 18 })] })] : []),
          new Paragraph({ text: '' }),
          new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [new TableRow({ children: headerCells, tableHeader: true }), ...dataRows] }),
        ],
      }],
    });

    const buffer = await Packer.toBuffer(docObj);
    return { buffer, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', filename: `${this.safeFilename(report.name)}.docx` };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private castValue(raw: string, type: string): any {
    if (type === 'number')  return Number(raw);
    if (type === 'boolean') return raw === 'true';
    if (type === 'date')    return new Date(raw);
    return raw;
  }

  private formatValue(val: any): string | number | null {
    if (val === null || val === undefined) return '';
    if (val instanceof Date) {
      return formatDisplayDate(val);
    }
    if (typeof val === 'string' && /^\d{4}-\d{2}-\d{2}(T|$)/.test(val)) {
      const out = formatDisplayDate(val);
      if (out) return out;
    }
    if (typeof val === 'object') return JSON.stringify(val);
    return val;
  }

  private safeFilename(name: string): string {
    return name.replace(/[^a-zA-Z0-9\-_]/g, '_').slice(0, 60) + `_${Date.now()}`;
  }
}
