#!/usr/bin/env node
/**
 * Phase 3 Reports Hardening — Phase B regression.
 *
 *   Schema:
 *    1. Report model carries `tenantId` (nullable for backfill).
 *    2. Report model carries `visibility ReportVisibility @default(PRIVATE)`.
 *    3. ReportShare model exists with composite PK (reportId, userId).
 *    4. ReportVisibility / ReportSharePermission enums declared.
 *    5. Declarative `name @unique` is GONE — partial index is created by
 *       healAdditiveDrift instead.
 *
 *   healAdditiveDrift:
 *    6. Adds reports.tenantId column + index.
 *    7. Drops the legacy global `name @unique` and creates the partial
 *       unique index `(tenantId, createdById, name) WHERE deletedAt IS NULL`.
 *    8. Creates the `report_shares` table.
 *
 *   Service:
 *    9. resolveReportAccess / assertReportAccessOrThrow / accessibleReportsWhere helpers exist.
 *   10. create() sets tenantId from caller AND defaults visibility=PRIVATE.
 *   11. create() name-uniqueness check is scoped by tenantId + createdById.
 *   12. findAll() routes through accessibleReportsWhere.
 *   13. findOne() asserts VIEW access.
 *   14. update() asserts EDIT access.
 *   15. remove() is owner-only (no SHARE-level delete).
 *   16. run() asserts RUN access.
 *   17. export() asserts RUN access.
 *   18. shareWithUser blocks cross-tenant grants.
 *   19. setVisibility / shareWithUser / revokeShare methods exist.
 *
 *   Controller:
 *   20. PATCH /reports/:id/visibility route present.
 *   21. POST  /reports/:id/share route present.
 *   22. DELETE /reports/:id/share/:userId route present.
 *
 *   Backfill script:
 *   23. backend/scripts/saas/reports-tenant-backfill-audit.ts exists,
 *       gated by REPORTS_TENANT_AUDIT_REMEDIATE/_APPLY/_FORCE.
 *   24. Defensive UPDATE only fires when current "tenantId" IS NULL.
 *   25. Only proposes a tenant when exactly one is inferred from the
 *       creator (single observed tenant).
 *
 * Exit 1 on any failure.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(resolve(ROOT, rel), 'utf8');

let problems = 0;
const fail = (m) => { problems++; console.log(`✗ ${m}`); };
const ok = (m) => console.log(`✓ ${m}`);
const must = (src, re, label) => (re.test(src) ? ok(label) : fail(label));
const mustNot = (src, re, label) => (re.test(src) ? fail(label) : ok(label));

const schema = read('backend/prisma/schema.prisma');
const heal   = read('backend/src/prisma/prisma.service.ts');
const svc    = read('backend/src/reports/reports.service.ts');
const ctrl   = read('backend/src/reports/reports.controller.ts');

// ── Schema ────────────────────────────────────────────────────────────────
must(schema, /model Report \{[\s\S]{0,1500}tenantId\s+String\?/,
  'schema: Report.tenantId String? declared');
must(schema, /model Report \{[\s\S]{0,1500}visibility\s+ReportVisibility\s+@default\(PRIVATE\)/,
  'schema: Report.visibility defaults to PRIVATE');
must(schema, /model ReportShare \{[\s\S]{0,400}@@id\(\[reportId,\s*userId\]\)/,
  'schema: ReportShare composite PK (reportId, userId)');
must(schema, /enum ReportVisibility \{[\s\S]{0,200}PRIVATE[\s\S]{0,40}SHARED[\s\S]{0,40}PUBLIC_IN_TENANT/,
  'schema: ReportVisibility enum has PRIVATE/SHARED/PUBLIC_IN_TENANT');
must(schema, /enum ReportSharePermission \{[\s\S]{0,200}VIEW[\s\S]{0,40}RUN[\s\S]{0,40}EDIT[\s\S]{0,40}SHARE/,
  'schema: ReportSharePermission enum has VIEW/RUN/EDIT/SHARE');
// Scope the "no @unique on name" check to the Report model block only.
const reportBlock = (schema.match(/model Report \{[\s\S]*?\n\}/) ?? [''])[0];
if (/name\s+String\s+@unique/.test(reportBlock)) {
  fail('schema: legacy global Report.name @unique is removed');
} else {
  ok('schema: legacy global Report.name @unique is removed');
}

// ── healAdditiveDrift ─────────────────────────────────────────────────────
must(heal, /reports\.tenantId[\s\S]{0,200}ADD COLUMN IF NOT EXISTS "tenantId"/,
  'heal: reports.tenantId column added if missing');
must(heal, /reports\.tenantId idx[\s\S]{0,200}CREATE INDEX IF NOT EXISTS "reports_tenantId_idx"/,
  'heal: reports.tenantId index added');
must(heal, /ALTER TABLE "reports" DROP CONSTRAINT IF EXISTS "reports_name_key"/,
  'heal: legacy unique constraint dropped if present');
must(heal, /CREATE UNIQUE INDEX IF NOT EXISTS "reports_name_owner_unique"[\s\S]{0,300}WHERE "deletedAt" IS NULL/,
  'heal: partial unique index (tenantId,createdById,name) WHERE deletedAt IS NULL');
must(heal, /CREATE TABLE IF NOT EXISTS "report_shares"/,
  'heal: report_shares table created');
must(heal, /CREATE TYPE "ReportVisibility"/,
  'heal: ReportVisibility enum type created');
must(heal, /CREATE TYPE "ReportSharePermission"/,
  'heal: ReportSharePermission enum type created');

// ── Service helpers ───────────────────────────────────────────────────────
must(svc, /private async resolveReportAccess\(/,
  'service: resolveReportAccess helper present');
must(svc, /private async assertReportAccessOrThrow\(/,
  'service: assertReportAccessOrThrow helper present');
must(svc, /private async accessibleReportsWhere\(/,
  'service: accessibleReportsWhere helper present');

// ── Service: create ──────────────────────────────────────────────────────
must(svc, /async create\(dto:[\s\S]{0,300}caller\?:[\s\S]{0,200}tenantId\?/,
  'service: create() accepts caller.tenantId');
must(svc, /async create\([\s\S]{0,800}tenantId:\s*caller\?\.tenantId/,
  'service: create() writes tenantId from caller');
must(svc, /visibility:\s*'PRIVATE'/,
  'service: create() defaults visibility=PRIVATE');
must(svc, /async create\([\s\S]{0,1200}findFirst\(\{\s*where:\s*\{[\s\S]{0,200}createdById:\s*userId[\s\S]{0,100}tenantId:\s*caller\?\.tenantId/,
  'service: create() name conflict check is scoped by tenantId + createdById');

// ── Service: read / update / delete / run / export ───────────────────────
// SPIKE-010 Phase F2 layered a SUPER `?tenantId=` override on top of the
// access check. findAll now derives `effectiveCaller` (caller with the
// SUPER-supplied tenantId substituted in) and feeds THAT into the
// access helper. We accept either signature for back-compat.
must(svc, /async findAll\([\s\S]{0,800}accessibleReportsWhere\((effectiveCaller|caller)\)/,
  'service: findAll() routes through accessibleReportsWhere');
must(svc, /async findOne\([\s\S]{0,200}assertReportAccessOrThrow\(report,\s*caller,\s*'VIEW'\)/,
  'service: findOne() asserts VIEW access');
must(svc, /async update\([\s\S]{0,300}assertReportAccessOrThrow\(report,\s*caller,\s*'EDIT'\)/,
  'service: update() asserts EDIT access');
must(svc, /async update\([\s\S]{0,1500}findFirst\(\{\s*where:\s*\{[\s\S]{0,300}createdById:\s*report\.createdById[\s\S]{0,100}tenantId:\s*report\.tenantId/,
  'service: update() name conflict check is scoped by report owner + tenant');
must(svc, /async remove\([\s\S]{0,500}resolveReportAccess\(report,\s*caller\)[\s\S]{0,200}level !== 'OWNER'/,
  'service: remove() is owner-only (no SHARE-level delete)');
must(svc, /async run\([\s\S]{0,400}assertReportAccessOrThrow\(report,\s*caller,\s*'RUN'\)/,
  'service: run() asserts RUN access');
must(svc, /async export\([\s\S]{0,500}assertReportAccessOrThrow\(report,\s*caller,\s*'RUN'\)/,
  'service: export() asserts RUN access');

// ── Service: sharing ─────────────────────────────────────────────────────
must(svc, /async setVisibility\(/,
  'service: setVisibility method present');
must(svc, /async shareWithUser\(/,
  'service: shareWithUser method present');
must(svc, /async revokeShare\(/,
  'service: revokeShare method present');
must(svc, /async shareWithUser\([\s\S]{0,2000}REPORT\.SHARE_CROSS_TENANT/,
  'service: shareWithUser rejects cross-tenant grants');
must(svc, /async setVisibility\([\s\S]{0,500}level !== 'OWNER'/,
  'service: setVisibility is owner-only');

// ── Controller routes ─────────────────────────────────────────────────────
must(ctrl, /@Patch\(':id\/visibility'\)/,
  'controller: PATCH /reports/:id/visibility route present');
must(ctrl, /@Post\(':id\/share'\)/,
  'controller: POST /reports/:id/share route present');
must(ctrl, /@Delete\(':id\/share\/:userId'\)/,
  'controller: DELETE /reports/:id/share/:userId route present');

// ── Backfill audit ────────────────────────────────────────────────────────
const auditPath = resolve(ROOT, 'backend/scripts/saas/reports-tenant-backfill-audit.ts');
if (!existsSync(auditPath)) {
  fail('backfill: reports-tenant-backfill-audit.ts missing');
} else {
  const audit = readFileSync(auditPath, 'utf8');
  must(audit, /REPORTS_TENANT_AUDIT_REMEDIATE/, 'backfill: gated by REPORTS_TENANT_AUDIT_REMEDIATE');
  must(audit, /REPORTS_TENANT_AUDIT_APPLY/,     'backfill: dry-run unless REPORTS_TENANT_AUDIT_APPLY=true');
  must(audit, /isStagingClassification\(env\.classification\)/, 'backfill: refuses non-staging without FORCE');
  must(audit, /"tenantId"\s*=\s*\$1[\s\S]{0,80}"tenantId" IS NULL/,
    'backfill: defensive UPDATE only fires when current tenantId IS NULL');
  must(audit, /observed\.length === 1/,
    'backfill: only proposes a tenant when exactly one is inferred');
}

console.log('');
if (problems > 0) {
  console.log(`${problems} check(s) failed.`);
  process.exit(1);
}
console.log('All reports-phase-b checks passed.');
