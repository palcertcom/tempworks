#!/usr/bin/env node
/**
 * Phase 3 Reports Hardening — Phase A regression.
 *
 * Locks in the schema-free hardening shipped in the Phase A PR:
 *
 *   1. Per-source permission map exported from reports.service.ts.
 *   2. previewInline method exists, gates by source permission, and
 *      caps at REPORTS_PREVIEW_LIMIT.
 *   3. run() gates by source permission and clamps the limit.
 *   4. create()/update()/previewInline reject zero columns.
 *   5. executeReport() clamps the limit defensively (defence in depth).
 *   6. POST /reports/preview controller route exists, gated by
 *      `reports:read`.
 *   7. POST /reports/:id/run uses `reports:read`, not `reports:create`.
 *   8. PUT /reports/:id carries an explicit @RequirePermission.
 *   9. getDataSources accepts a caller and filters by permission.
 *  10. Frontend Preview calls reportsApi.preview, NOT create/update +
 *      run (the old "preview saves" bug).
 *  11. Frontend Save/Preview buttons disabled when zero columns.
 *  12. Frontend Column card exposes Select All / Deselect All buttons.
 *  13. Frontend api client declares reportsApi.preview.
 *
 * Exit 1 on any failure.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(resolve(ROOT, rel), 'utf8');

let problems = 0;
const fail = (m) => { problems++; console.log(`✗ ${m}`); };
const ok = (m) => console.log(`✓ ${m}`);
const must = (src, re, label) => (re.test(src) ? ok(label) : fail(label));
const mustNot = (src, re, label) => (re.test(src) ? fail(label) : ok(label));

const svc  = read('backend/src/reports/reports.service.ts');
const ctrl = read('backend/src/reports/reports.controller.ts');
const dto  = read('backend/src/reports/dto/report.dto.ts');
const api  = read('src/app/services/api.ts');
const ui   = read('src/app/pages/reports/ReportsDashboard.tsx');

// ── Backend service ──────────────────────────────────────────────────────
must(svc, /export const REPORT_SOURCE_PERMISSION:\s*Record<string,\s*string>/,
  'backend: REPORT_SOURCE_PERMISSION map exported');
must(svc, /export const REPORTS_RUN_MAX_LIMIT\b/,
  'backend: REPORTS_RUN_MAX_LIMIT exported');
must(svc, /export const REPORTS_PREVIEW_LIMIT\b/,
  'backend: REPORTS_PREVIEW_LIMIT exported');
must(svc, /private async assertSourcePermitted\(/,
  'backend: assertSourcePermitted helper present');
must(svc, /private assertColumnsNotEmpty\(/,
  'backend: assertColumnsNotEmpty helper present');
must(svc, /private clampRunLimit\(/,
  'backend: clampRunLimit helper present');
must(svc, /async previewInline\(/,
  'backend: previewInline method present');
must(svc, /async previewInline[\s\S]{0,1500}assertSourcePermitted\(dto\.dataSource/,
  'backend: previewInline gates by source permission');
must(svc, /async previewInline[\s\S]{0,1500}REPORTS_PREVIEW_LIMIT/,
  'backend: previewInline uses REPORTS_PREVIEW_LIMIT');
must(svc, /async run\([\s\S]{0,800}assertSourcePermitted\(report\.dataSource/,
  'backend: run() gates by source permission');
must(svc, /async run\([\s\S]{0,800}clampRunLimit\(opts\.limit\)/,
  'backend: run() clamps the page limit');
must(svc, /async create\([\s\S]{0,400}assertColumnsNotEmpty\(dto\.columns\)/,
  'backend: create() rejects zero columns');
must(svc, /async update\([\s\S]{0,400}assertColumnsNotEmpty\(dto\.columns\)/,
  'backend: update() rejects zero columns');
must(svc, /const limit\s*=\s*this\.clampRunLimit\(opts\.limit\)/,
  'backend: executeReport() clamps the limit defensively');
must(svc, /async getDataSources\(caller\?:[\s\S]{0,400}REPORT_SOURCE_PERMISSION\[key\]/,
  'backend: getDataSources filters by caller permissions');

// ── Backend controller ──────────────────────────────────────────────────
must(ctrl, /@Post\('preview'\)[\s\S]{0,400}@RequirePermission\('reports:read'\)/,
  'backend: POST /reports/preview route gated by reports:read');
must(ctrl, /@Post\(':id\/run'\)[\s\S]{0,200}@RequirePermission\('reports:read'\)/,
  'backend: POST /reports/:id/run uses reports:read, not reports:create');
must(ctrl, /@Put\(':id'\)[\s\S]{0,200}@RequirePermission\('reports:create'\)/,
  'backend: PUT /reports/:id carries an explicit @RequirePermission');
mustNot(ctrl, /@Post\(':id\/run'\)[\s\S]{0,200}@RequirePermission\('reports:create'\)/,
  'backend: stale reports:create gate on run is removed');

// ── DTO ────────────────────────────────────────────────────────────────
must(dto, /export class PreviewReportDto\b/,
  'backend: PreviewReportDto class exported');

// ── Frontend api client ────────────────────────────────────────────────
must(api, /preview:\s*\(data:\s*any\)\s*=>\s*apiFetch[\s\S]{0,200}\/reports\/preview/,
  'frontend: reportsApi.preview() declared');

// ── Frontend dashboard ─────────────────────────────────────────────────
must(ui, /reportsApi\.preview\(/,
  'frontend: ReportsDashboard calls reportsApi.preview');
mustNot(ui, /const saved:\s*any\s*=\s*editingId\s*\?\s*await reportsApi\.update[\s\S]{0,200}await reportsApi\.run\(saved\.id/,
  'frontend: old "preview saves then runs" path is gone');
must(ui, /selectAllColumns\b/,
  'frontend: Select All handler present');
must(ui, /deselectAllColumns\b/,
  'frontend: Deselect All handler present');
must(ui, /actions\.selectAll/,
  'frontend: Select All button uses i18n key');
must(ui, /actions\.deselectAll/,
  'frontend: Deselect All button uses i18n key');
must(ui, /reports\.previewHint/,
  'frontend: preview hint copy uses i18n key');
must(ui, /handleSave[\s\S]{0,400}builder\.columns\.length === 0/,
  'frontend: handleSave guards against zero columns');
must(ui, /handlePreview[\s\S]{0,400}builder\.columns\.length === 0/,
  'frontend: handlePreview guards against zero columns');

console.log('');
if (problems > 0) {
  console.log(`${problems} check(s) failed.`);
  process.exit(1);
}
console.log('All reports-phase-a checks passed.');
