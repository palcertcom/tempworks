#!/usr/bin/env node
/**
 * Phase 3 Reports Hardening — Phase C (sharing UI) regression.
 *
 * Frontend-only — Phase B backend is unchanged. This check pins:
 *
 *   API client:
 *    1. reportsApi.setVisibility / share / revokeShare exposed.
 *
 *   Share dialog component:
 *    2. ShareReportDialog.tsx exists.
 *    3. Calls reportsApi.setVisibility / share / revokeShare.
 *    4. Renders the three visibility options.
 *    5. Renders the four permission options (VIEW/RUN/EDIT/SHARE).
 *
 *   Saved-list rendering:
 *    6. Imports ShareReportDialog.
 *    7. Visibility badge per row (Private / Shared / Public in tenant).
 *    8. "Created by" + "Shared with N" surfaced from report.createdBy /
 *       report.shares.
 *    9. Why-can-I-see-it badge uses reports.access.* keys.
 *   10. Run/Edit/Export/Share/Delete buttons gated by the derived
 *       client-side access rank (canRun / canEditReport / canShareReport
 *       / canDeleteReport).
 *   11. Phase A invariants preserved: handlePreview still calls
 *       reportsApi.preview (no save), Select/Deselect All present,
 *       previewHint copy present.
 *
 *   i18n:
 *   12. All six real locales carry the new reports.visibility.* /
 *       reports.access.* / reports.sharing.* keys.
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

// ── API client ───────────────────────────────────────────────────────────
const api = read('src/app/services/api.ts');
must(api, /setVisibility:\s*\(id:[\s\S]{0,200}\/reports\/\$\{id\}\/visibility/,
  'api: reportsApi.setVisibility declared');
must(api, /share:\s*\(id:[\s\S]{0,400}\/reports\/\$\{id\}\/share[\s\S]{0,100}method:\s*'POST'/,
  'api: reportsApi.share declared');
must(api, /revokeShare:\s*\(id:[\s\S]{0,300}\/reports\/\$\{id\}\/share\/\$\{userId\}[\s\S]{0,100}method:\s*'DELETE'/,
  'api: reportsApi.revokeShare declared');

// ── Share dialog ─────────────────────────────────────────────────────────
const dialogPath = 'src/app/components/reports/ShareReportDialog.tsx';
if (!existsSync(resolve(ROOT, dialogPath))) {
  fail(`component: ${dialogPath} missing`);
} else {
  const dlg = read(dialogPath);
  must(dlg, /export function ShareReportDialog\(/,
    'component: ShareReportDialog exported');
  must(dlg, /reportsApi\.setVisibility\(/,
    'component: dialog calls reportsApi.setVisibility');
  must(dlg, /reportsApi\.share\(/,
    'component: dialog calls reportsApi.share');
  must(dlg, /reportsApi\.revokeShare\(/,
    'component: dialog calls reportsApi.revokeShare');
  must(dlg, /value="PRIVATE"[\s\S]{0,400}value="SHARED"[\s\S]{0,400}value="PUBLIC_IN_TENANT"/,
    'component: dialog renders all three visibility options');
  must(dlg, /value="VIEW"[\s\S]{0,400}value="RUN"[\s\S]{0,400}value="EDIT"[\s\S]{0,400}value="SHARE"/,
    'component: dialog renders all four share-permission options');
  must(dlg, /reports\.sharing\.toast\.shared/,
    'component: dialog uses i18n for share success toast');
  must(dlg, /reports\.sharing\.toast\.visibility/,
    'component: dialog uses i18n for visibility toast');
}

// ── Saved-list UI ────────────────────────────────────────────────────────
const ui = read('src/app/pages/reports/ReportsDashboard.tsx');
must(ui, /import\s*\{\s*ShareReportDialog\s*\}\s*from\s*'\.\.\/\.\.\/components\/reports\/ShareReportDialog'/,
  'ui: ReportsDashboard imports ShareReportDialog');
must(ui, /reports\.visibility\.(private|shared|publicInTenant)/,
  'ui: visibility-key resolution branches');
must(ui, /reports\.access\.(ownedByMe|sharedWithMe|publicInTenant)/,
  'ui: why-can-I-see-it badge uses reports.access.* keys');
must(ui, /reports\.sharing\.createdBy/,
  'ui: createdBy label rendered from report.createdBy');
must(ui, /reports\.sharing\.sharedWithN/,
  'ui: shared-with-N count rendered from report.shares');
must(ui, /const isOwner\s*=\s*!!currentUserId\s*&&\s*report\.createdById\s*===\s*currentUserId/,
  'ui: derives isOwner from current user vs createdById');
must(ui, /\bcanRun\b\s*=\s*myRank\s*>=\s*2/,
  'ui: derives canRun from share rank (>= RUN)');
must(ui, /\bcanEditReport\b\s*=\s*myRank\s*>=\s*3/,
  'ui: derives canEditReport from share rank (>= EDIT)');
must(ui, /\bcanShareReport\b\s*=\s*isOwner\s*\|\|\s*myRank\s*>=\s*4/,
  'ui: derives canShareReport from share rank (>= SHARE) or owner');
must(ui, /\bcanDeleteReport\b\s*=\s*isOwner/,
  'ui: derives canDeleteReport as owner-only (matches backend)');
must(ui, /setShareReportId\(report\.id\)/,
  'ui: Share button opens the modal for the row');
must(ui, /<ShareReportDialog\b/,
  'ui: ShareReportDialog is mounted');

// ── Phase A invariants preserved ────────────────────────────────────────
must(ui, /reportsApi\.preview\(/,
  'ui: Phase A — Preview still calls reportsApi.preview (no save)');
must(ui, /selectAllColumns\b/,
  'ui: Phase A — Select All handler still present');
must(ui, /deselectAllColumns\b/,
  'ui: Phase A — Deselect All handler still present');
must(ui, /reports\.previewHint/,
  'ui: Phase A — preview-hint copy still present');

// ── i18n ─────────────────────────────────────────────────────────────────
const locales = ['en', 'ar', 'de', 'ru', 'sk', 'tr'];
const required = [
  ['reports', 'visibility', 'private'],
  ['reports', 'visibility', 'shared'],
  ['reports', 'visibility', 'publicInTenant'],
  ['reports', 'access', 'ownedByMe'],
  ['reports', 'access', 'sharedWithMe'],
  ['reports', 'access', 'publicInTenant'],
  ['reports', 'sharing', 'createdBy'],
  ['reports', 'sharing', 'sharedWithN'],
  ['reports', 'sharing', 'manageAccess'],
  ['reports', 'sharing', 'permission', 'view'],
  ['reports', 'sharing', 'permission', 'run'],
  ['reports', 'sharing', 'permission', 'edit'],
  ['reports', 'sharing', 'permission', 'share'],
  ['reports', 'sharing', 'revokeAccess'],
  ['reports', 'sharing', 'noShares'],
];
for (const loc of locales) {
  let d;
  try { d = JSON.parse(read(`src/i18n/locales/${loc}/pages.json`)); }
  catch (e) { fail(`i18n ${loc}: cannot parse pages.json`); continue; }
  for (const path of required) {
    let cur = d;
    let okPath = true;
    for (const seg of path) {
      if (cur && typeof cur === 'object' && seg in cur) cur = cur[seg];
      else { okPath = false; break; }
    }
    if (!okPath || typeof cur !== 'string') {
      fail(`i18n ${loc}: missing ${path.join('.')}`);
    }
  }
  ok(`i18n ${loc}: all ${required.length} sharing keys present`);
}

console.log('');
if (problems > 0) {
  console.log(`${problems} check(s) failed.`);
  process.exit(1);
}
console.log('All reports-phase-c checks passed.');
