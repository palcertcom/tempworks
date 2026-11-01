/**
 * Phase 2.12 — `@tenant-reviewed` annotation policy validator.
 *
 * Walks `src/` and inspects every line that carries a
 * `// @tenant-reviewed:` comment. Each annotation is checked against
 * `KNOWN_REASONS`:
 *
 *   - `UNKNOWN_REASON` — the tag isn't in the policy. Report-only.
 *   - `WRONG_PATH`     — the tag IS known, but the file lives outside
 *                        the policy's allowed paths for that tag.
 *
 * Output: a per-finding list to stdout plus an aggregate count.
 *
 * Exit codes:
 *   0 — no findings (clean)
 *   0 — findings present but `--strict-annotations` not passed
 *   1 — `--strict-annotations` passed AND at least one finding
 *
 * The full policy lives in
 * `SAAS_PHASE2_SCANNER_ANNOTATION_POLICY.md`.
 */
/* eslint-disable no-console */
import { promises as fs } from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..', 'src');

/** Each known tag has the canonical phrase + an array of allowed
 *  path-prefixes (relative to the backend root). */
interface PolicyEntry {
  tag: string;
  allowedPaths: ReadonlyArray<string>;
}

const KNOWN_REASONS: ReadonlyArray<PolicyEntry> = [
  { tag: 'phase26-pilot-accessor', allowedPaths: ['src/roles/'] },
  { tag: 'phase27-pilot-scope',    allowedPaths: ['src/employee-work-history/'] },
  { tag: 'phase27-audit-log',      allowedPaths: ['src/employee-work-history/'] },
  { tag: 'phase28-pilot-scope',    allowedPaths: ['src/compliance/'] },
  { tag: 'phase28-audit-log',      allowedPaths: ['src/compliance/'] },
  { tag: 'phase29-pilot-scope',    allowedPaths: ['src/job-ads/'] },
  { tag: 'phase210-pilot-scope',          allowedPaths: ['src/notifications/'] },
  { tag: 'phase210-excluded-background',  allowedPaths: ['src/notifications/'] },
  { tag: 'phase210-global',               allowedPaths: ['src/notifications/'] },
  { tag: 'phase211-pilot-scope',          allowedPaths: ['src/recycle-bin/'] },
  { tag: 'phase211-global',               allowedPaths: ['src/recycle-bin/'] },
  { tag: 'phase211-excluded-platform',    allowedPaths: ['src/recycle-bin/'] },
  { tag: 'phase214-pilot-scope',          allowedPaths: ['src/notifications/'] },
  { tag: 'phase215-pilot-scope',          allowedPaths: ['src/notifications/'] },
  { tag: 'phase216-pilot-scope',          allowedPaths: ['src/finance/'] },
  { tag: 'phase216-excluded-mutation',    allowedPaths: ['src/finance/'] },
  { tag: 'phase216-helper-read',          allowedPaths: ['src/finance/'] },
  { tag: 'phase216-global',               allowedPaths: ['src/finance/'] },
  { tag: 'phase216-audit-log',            allowedPaths: ['src/finance/'] },
  { tag: 'phase217-pilot-scope',          allowedPaths: ['src/finance/'] },
  { tag: 'phase217-pilot-scope-precheck', allowedPaths: ['src/finance/'] },
  { tag: 'phase2171-helper-narrowed',     allowedPaths: ['src/finance/'] },
  { tag: 'phase220-pilot-scope',          allowedPaths: ['src/documents/'] },
  { tag: 'phase220-global',               allowedPaths: ['src/documents/'] },
  { tag: 'phase220-excluded-mutation',    allowedPaths: ['src/documents/'] },
  { tag: 'phase220-excluded-download',    allowedPaths: ['src/documents/'] },
  { tag: 'phase220-excluded-helper',      allowedPaths: ['src/documents/'] },
  { tag: 'phase220-audit-log',            allowedPaths: ['src/documents/'] },
  { tag: 'phase221-pilot-scope',          allowedPaths: ['src/documents/'] },
  { tag: 'phase221-pilot-scope-precheck', allowedPaths: ['src/documents/'] },
  { tag: 'phase221-storage-guard',        allowedPaths: ['src/documents/'] },
  { tag: 'phase222-download-guard',       allowedPaths: ['src/documents/'] },
  { tag: 'phase223-pilot-scope',          allowedPaths: ['src/vehicles/'] },
  { tag: 'phase223-global',               allowedPaths: ['src/vehicles/'] },
  { tag: 'phase223-excluded-mutation',    allowedPaths: ['src/vehicles/'] },
  { tag: 'phase223-excluded-storage',     allowedPaths: ['src/vehicles/'] },
  { tag: 'phase224-pilot-scope',          allowedPaths: ['src/vehicles/'] },
  { tag: 'phase224-pilot-scope-precheck', allowedPaths: ['src/vehicles/'] },
  { tag: 'phase225-pilot-scope',          allowedPaths: ['src/vehicles/'] },
  { tag: 'phase225-pilot-scope-precheck', allowedPaths: ['src/vehicles/'] },
  { tag: 'phase225-storage-guard',        allowedPaths: ['src/vehicles/'] },
  { tag: 'phase226-pilot-scope',          allowedPaths: ['src/workflow/'] },
  { tag: 'phase226-global',               allowedPaths: ['src/workflow/'] },
  { tag: 'phase226-excluded-mutation',    allowedPaths: ['src/workflow/'] },
  { tag: 'phase226-audit-log',            allowedPaths: ['src/workflow/'] },
  { tag: 'phase227-pilot-scope',          allowedPaths: ['src/workflow/'] },
  { tag: 'phase227-pilot-scope-precheck', allowedPaths: ['src/workflow/'] },
  { tag: 'phase228-pilot-scope',          allowedPaths: ['src/applicants/'] },
  { tag: 'phase228-pilot-scope-precheck', allowedPaths: ['src/applicants/'] },
  { tag: 'phase228-global',               allowedPaths: ['src/applicants/'] },
  { tag: 'phase228-excluded-mutation',    allowedPaths: ['src/applicants/'] },
  { tag: 'phase228-audit-log',            allowedPaths: ['src/applicants/'] },
  { tag: 'phase229-pilot-scope',          allowedPaths: ['src/applicants/'] },
  { tag: 'phase229-pilot-scope-precheck', allowedPaths: ['src/applicants/'] },
  { tag: 'phase229-bulk-filter',          allowedPaths: ['src/applicants/'] },
  { tag: 'phase230-audit-log-pilot',      allowedPaths: ['src/finance/', 'src/documents/', 'src/workflow/', 'src/applicants/', 'src/saas/audit/'] },
  { tag: 'phase231-storage-guard',                allowedPaths: ['src/applicants/'] },
  { tag: 'phase231-public-submit-attribution',    allowedPaths: ['src/applicants/'] },
  { tag: 'phase231-pilot-scope',                  allowedPaths: ['src/applicants/'] },
  { tag: 'phase232-conversion-gate',              allowedPaths: ['src/applicants/'] },
  { tag: 'phase233-pilot-scope',                  allowedPaths: ['src/employees/'] },
  { tag: 'phase233-pilot-scope-precheck',         allowedPaths: ['src/employees/'] },
  { tag: 'phase233-global',                       allowedPaths: ['src/employees/'] },
  { tag: 'phase233-excluded-mutation',            allowedPaths: ['src/employees/'] },
  { tag: 'phase233-excluded-storage',             allowedPaths: ['src/employees/'] },
  { tag: 'phase234-pilot-scope',                  allowedPaths: ['src/employees/'] },
  { tag: 'phase234-pilot-scope-precheck',         allowedPaths: ['src/employees/'] },
  { tag: 'phase234-storage-guard',                allowedPaths: ['src/employees/'] },
  { tag: 'phase234-agency-gate',                  allowedPaths: ['src/employees/'] },
  { tag: 'phase235-pilot-scope',                  allowedPaths: ['src/agencies/'] },
  { tag: 'phase235-pilot-scope-precheck',         allowedPaths: ['src/agencies/'] },
  { tag: 'phase235-global',                       allowedPaths: ['src/agencies/'] },
  { tag: 'phase235-excluded-mutation',            allowedPaths: ['src/agencies/'] },
  { tag: 'phase235-excluded-storage',             allowedPaths: ['src/agencies/'] },
  { tag: 'phase236-pilot-scope',                  allowedPaths: ['src/agencies/'] },
  { tag: 'phase236-pilot-scope-precheck',         allowedPaths: ['src/agencies/'] },
  { tag: 'phase236-storage-guard',                allowedPaths: ['src/agencies/'] },
  { tag: 'phase236-permission-gate',              allowedPaths: ['src/agencies/'] },
  { tag: 'phase236-manager-gate',                 allowedPaths: ['src/agencies/'] },
  { tag: 'phase236-audit-log-pilot',              allowedPaths: ['src/agencies/'] },
  { tag: 'phase238-audit-log-pilot',              allowedPaths: ['src/compliance/'] },
  { tag: 'phase238-scheduler-routing',            allowedPaths: ['src/compliance/'] },
  { tag: 'phase239-tenant-job-dispatch',          allowedPaths: ['src/compliance/'] },
  { tag: 'phase240-compliance-real-scheduler',    allowedPaths: ['src/compliance/'] },
  { tag: 'phase241-compliance-cron-framework',    allowedPaths: ['src/compliance/'] },
  { tag: 'phase242-notifications-pilot-scope',    allowedPaths: ['src/notifications/'] },
  { tag: 'phase242-notifications-fanout-deferred', allowedPaths: ['src/notifications/'] },
  { tag: 'phase242-notifications-audit-log',      allowedPaths: ['src/notifications/'] },
  { tag: 'phase243-compliance-notification-coupling', allowedPaths: ['src/compliance/'] },
  { tag: 'phase243-compliance-notification-fanout',   allowedPaths: ['src/compliance/'] },
  { tag: 'phase243-compliance-notification-deferred-provider', allowedPaths: ['src/compliance/'] },
  { tag: 'phase244-compliance-scheduler-health', allowedPaths: ['src/compliance/'] },
  { tag: 'phase245-notifications-dedup',         allowedPaths: ['src/notifications/', 'src/compliance/'] },
  { tag: 'phase246-notifications-internal-scan-dedup', allowedPaths: ['src/notifications/'] },
  { tag: 'phase247-attendance-pilot-scope',      allowedPaths: ['src/attendance/'] },
  { tag: 'phase247-attendance-mutation-scope',   allowedPaths: ['src/attendance/'] },
  { tag: 'phase247-attendance-audit-log',        allowedPaths: ['src/attendance/'] },
  { tag: 'phase247-attendance-deferred-export',  allowedPaths: ['src/attendance/'] },
  { tag: 'phase248-attendance-mutation-pilot',   allowedPaths: ['src/attendance/'] },
  { tag: 'phase248-attendance-audit-log-pilot',  allowedPaths: ['src/attendance/'] },
  { tag: 'phase248-attendance-export-scope',     allowedPaths: ['src/attendance/'] },
  { tag: 'phase248-attendance-lock-deferred',    allowedPaths: ['src/attendance/'] },
  { tag: 'phase249-attendance-lock-period-tenant-scope', allowedPaths: ['src/attendance/'] },
  { tag: 'phase249-attendance-lock-period-migration',    allowedPaths: ['src/attendance/', 'prisma/'] },
  { tag: 'phase249-attendance-lock-period-backfill',     allowedPaths: ['src/attendance/', 'scripts/'] },
  { tag: 'phase250-attendance-audit-backfill',           allowedPaths: ['scripts/saas/phase2/'] },
  { tag: 'phase251-cross-module-audit-backfill',         allowedPaths: ['scripts/saas/phase2/'] },
  { tag: 'phase252-audit-log-read-pilot',                allowedPaths: ['src/logs/', 'src/saas/audit/'] },
  { tag: 'phase252-audit-log-retention-preview',         allowedPaths: ['src/saas/audit/'] },
  { tag: 'phase252-audit-log-export-deferred',           allowedPaths: ['src/logs/'] },
  { tag: 'phase253-audit-log-retention-enforce',         allowedPaths: ['scripts/saas/phase2/'] },
  { tag: 'phase254-audit-log-hard-delete',               allowedPaths: ['scripts/saas/phase2/'] },
  { tag: 'phase255-audit-retention-runbook',             allowedPaths: ['scripts/saas/phase2/', 'docs/runbooks/'] },
  { tag: 'phase256-audit-log-rbac-tenant-binding',       allowedPaths: ['src/logs/'] },
  { tag: 'phase256-audit-log-global-read-gate',          allowedPaths: ['src/logs/'] },
  { tag: 'phase256-audit-log-actor-scope',               allowedPaths: ['src/logs/'] },
  { tag: 'phase257-audit-log-http-read',                 allowedPaths: ['src/logs/'] },
  { tag: 'phase257-audit-log-http-retention-preview',    allowedPaths: ['src/logs/'] },
  { tag: 'phase257-audit-log-http-no-destructive-routes', allowedPaths: ['src/logs/'] },
  { tag: 'phase258-audit-log-export-csv',                allowedPaths: ['src/logs/'] },
  { tag: 'phase258-audit-log-export-row-cap',            allowedPaths: ['src/logs/'] },
  { tag: 'phase258-audit-log-export-no-destructive',     allowedPaths: ['src/logs/'] },
  { tag: 'phase259-audit-log-http-rate-limit',           allowedPaths: ['src/logs/'] },
  { tag: 'phase259-audit-log-rate-limit-keying',         allowedPaths: ['src/logs/'] },
  { tag: 'phase259-audit-log-rate-limit-disabled-default', allowedPaths: ['src/logs/'] },
  { tag: 'phase260-audit-log-rate-limit-envelope',       allowedPaths: ['src/logs/'] },
  { tag: 'phase260-audit-log-retry-after-header',        allowedPaths: ['src/logs/'] },
  { tag: 'phase261-pipeline-pilot-scope',                allowedPaths: ['src/pipeline/'] },
  { tag: 'phase261-pipeline-mutation-deferred',          allowedPaths: ['src/pipeline/'] },
  { tag: 'phase261-pipeline-audit-log',                  allowedPaths: ['src/pipeline/'] },
  { tag: 'phase261-pipeline-export-deferred',            allowedPaths: ['src/pipeline/'] },
  { tag: 'phase261-pipeline-transition-deferred',        allowedPaths: ['src/pipeline/'] },
  { tag: 'phase262-pipeline-mutation-pilot',             allowedPaths: ['src/pipeline/'] },
  { tag: 'phase262-pipeline-transition-pilot',           allowedPaths: ['src/pipeline/'] },
  { tag: 'phase262-pipeline-audit-log-pilot',            allowedPaths: ['src/pipeline/'] },
  { tag: 'phase262-pipeline-workflow-config-global',     allowedPaths: ['src/pipeline/'] },
  { tag: 'phase262-pipeline-stage-config-global',        allowedPaths: ['src/pipeline/'] },
  { tag: 'phase263-workflow-tenant-scope',               allowedPaths: ['src/pipeline/'] },
  { tag: 'phase263-workflow-schema-migration',           allowedPaths: ['src/pipeline/', 'prisma/'] },
  { tag: 'phase263-workflow-global-template',            allowedPaths: ['src/pipeline/'] },
  { tag: 'phase263-workflow-stage-scope',                allowedPaths: ['src/pipeline/'] },
  { tag: 'phase263-workflow-audit-log',                  allowedPaths: ['src/pipeline/'] },
  { tag: 'phase300-product-migration-readiness',         allowedPaths: ['scripts/saas/phase3/'] },
  { tag: 'phase300-uniqueness-audit',                    allowedPaths: ['scripts/saas/phase3/', 'src/'] },
  { tag: 'phase300-platform-admin-foundation',           allowedPaths: ['scripts/saas/phase3/', 'src/'] },
  { tag: 'phase310-tenant-backfill-completeness',        allowedPaths: ['scripts/saas/phase3/'] },
  { tag: 'phase310-production-duplicate-scan',           allowedPaths: ['scripts/saas/phase3/'] },
  { tag: 'phase310-platform-admin-readiness',            allowedPaths: ['scripts/saas/phase3/'] },
  { tag: 'phase310-readiness-check',                     allowedPaths: ['scripts/saas/phase3/'] },
  { tag: 'phase320-duplicate-cleanup-plan',              allowedPaths: ['scripts/saas/phase3/'] },
  { tag: 'phase320-duplicate-cleanup-apply',             allowedPaths: ['scripts/saas/phase3/'] },
  { tag: 'phase320-duplicate-cleanup-harness',           allowedPaths: ['scripts/saas/phase3/'] },
  { tag: 'phase330-per-tenant-unique-constraints',       allowedPaths: ['scripts/saas/phase3/', 'prisma/'] },
  { tag: 'phase330-additive-unique-indexes',             allowedPaths: ['scripts/saas/phase3/', 'prisma/'] },
  { tag: 'phase330-global-unique-retained',              allowedPaths: ['scripts/saas/phase3/', 'prisma/'] },
  { tag: 'phase340-drop-employee-global-uniques',        allowedPaths: ['scripts/saas/phase3/', 'prisma/'] },
  { tag: 'phase340-global-unique-drop',                  allowedPaths: ['scripts/saas/phase3/', 'prisma/'] },
  { tag: 'phase340-per-tenant-unique-retained',          allowedPaths: ['scripts/saas/phase3/', 'prisma/'] },
  { tag: 'phase350-platform-admin-backfill',             allowedPaths: ['scripts/saas/phase3/', 'src/'] },
  { tag: 'phase350-platform-admin-audit-log',            allowedPaths: ['scripts/saas/phase3/', 'src/'] },
  { tag: 'phase350-agency-is-system-retirement',         allowedPaths: ['scripts/saas/phase3/', 'src/'] },
  { tag: 'phase360-platform-admin-dual-read',            allowedPaths: ['scripts/saas/phase3/', 'src/'] },
  { tag: 'phase360-agency-is-system-inventory',          allowedPaths: ['scripts/saas/phase3/', 'src/'] },
  { tag: 'phase360-platform-audit-log-deferred',         allowedPaths: ['scripts/saas/phase3/', 'src/'] },
  { tag: 'phase370-platform-admin-jwt-dual-read',        allowedPaths: ['scripts/saas/phase3/', 'src/'] },
  { tag: 'phase370-agency-is-system-derived-field',      allowedPaths: ['scripts/saas/phase3/', 'src/'] },
  { tag: 'phase370-platform-audit-log-deferred',         allowedPaths: ['scripts/saas/phase3/', 'src/'] },
  { tag: 'phase37b-platform-admin-signal-agreement',     allowedPaths: ['scripts/saas/phase3/', 'src/'] },
  { tag: 'phase37b-platform-admin-jwt-bake-check',       allowedPaths: ['scripts/saas/phase3/', 'src/'] },
  { tag: 'phase380-platform-admin-runtime-retirement',   allowedPaths: ['scripts/saas/phase3/', 'src/'] },
  { tag: 'phase380-agency-is-system-fallback',           allowedPaths: ['scripts/saas/phase3/', 'src/'] },
  { tag: 'phase380-agency-is-system-inventory',          allowedPaths: ['scripts/saas/phase3/', 'src/'] },
  { tag: 'phase390-drop-agency-is-system',               allowedPaths: ['scripts/saas/phase3/', 'src/', 'prisma/'] },
  { tag: 'phase390-platform-admin-only-authority',       allowedPaths: ['scripts/saas/phase3/', 'src/', 'prisma/'] },
  { tag: 'phase390-agency-is-system-removed',            allowedPaths: ['scripts/saas/phase3/', 'src/', 'prisma/'] },
  { tag: 'phase310-platform-admin-cleanup',              allowedPaths: ['scripts/saas/phase3/', 'src/', 'prisma/'] },
  { tag: 'phase310-platform-audit-log-migration',        allowedPaths: ['scripts/saas/phase3/', 'src/', 'prisma/'] },
  { tag: 'phase310-platform-audit-log-emission-deferred', allowedPaths: ['scripts/saas/phase3/', 'src/', 'prisma/'] },
  { tag: 'phase311-platform-admin-grant-revoke',         allowedPaths: ['scripts/saas/phase3/', 'src/'] },
  { tag: 'phase311-platform-audit-log-emission',         allowedPaths: ['scripts/saas/phase3/', 'src/'] },
  { tag: 'phase311-platform-admin-super-only',           allowedPaths: ['scripts/saas/phase3/', 'src/'] },
  { tag: 'phase312-platform-admin-controller',           allowedPaths: ['scripts/saas/phase3/', 'src/'] },
  { tag: 'phase312-platform-admin-http-gate',            allowedPaths: ['scripts/saas/phase3/', 'src/'] },
  { tag: 'phase313-tenant-aware-login',                  allowedPaths: ['scripts/saas/phase3/', 'src/'] },
  { tag: 'phase314-frontend-tenant-login',               allowedPaths: ['scripts/saas/phase3/', 'src/', '../src/'] },
  { tag: 'phase315-tenant-management-module',            allowedPaths: ['scripts/saas/phase3/', 'src/', '../src/'] },
  { tag: 'phase317-multi-tenant-login',                  allowedPaths: ['scripts/saas/phase3/', 'src/', '../src/'] },
  { tag: 'phase318-tenant-public-jobs',                  allowedPaths: ['scripts/saas/phase3/', 'src/', '../src/'] },
  { tag: 'tenant-safe-report-runtime',    allowedPaths: ['src/reports/', 'src/saas/reports/'] },
  { tag: 'tenant-resolver-bootstrap',     allowedPaths: ['src/saas/tenancy/'] },
];

interface Finding {
  file: string;
  line: number;
  reason: string;
  kind: 'UNKNOWN_REASON' | 'WRONG_PATH';
  detail: string;
}

async function* walk(dir: string): AsyncGenerator<string> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist') continue;
      yield* walk(full);
    } else if (e.isFile() && /\.(ts|tsx)$/.test(e.name)) {
      yield full;
    }
  }
}

/** Extract the reason after `// @tenant-reviewed:`. The trailing
 *  parenthetical (`(parent FR was tenant-checked)`) is stripped so the
 *  policy lookup matches the canonical tag. */
function extractReason(line: string): string | null {
  // Skip JSDoc / block-comment lines that merely *mention* the marker.
  if (/^\s*\*/.test(line)) return null;
  const m = /\/\/\s*@tenant-reviewed:?\s*([^\n]+)$/.exec(line);
  if (!m) return null;
  // Strip a trailing "(parenthetical)" plus stray punctuation.
  let r = m[1].trim();
  r = r.replace(/[;,.\s]+$/, '');                  // drop trailing ; , . or whitespace
  r = r.replace(/\s*\([^()]*\)\s*$/, '').trim();   // drop "(...)" parenthetical
  r = r.replace(/[;,.\s]+$/, '');                  // drop again in case strip exposed punctuation
  return r;
}

function findPolicyEntry(reason: string): PolicyEntry | null {
  return KNOWN_REASONS.find((p) => p.tag === reason) ?? null;
}

function isPathAllowedFor(rel: string, policy: PolicyEntry): boolean {
  const slash = rel.replace(/\\/g, '/');
  return policy.allowedPaths.some((p) => slash.startsWith(p));
}

async function main(): Promise<void> {
  const strict = process.argv.includes('--strict-annotations');
  const findings: Finding[] = [];

  for await (const file of walk(ROOT)) {
    const rel = path.relative(path.resolve(__dirname, '..'), file);
    const content = await fs.readFile(file, 'utf8');
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const reason = extractReason(line);
      if (!reason) continue;
      const policy = findPolicyEntry(reason);
      if (!policy) {
        findings.push({
          file: rel, line: i + 1, reason,
          kind: 'UNKNOWN_REASON',
          detail: `reason "${reason}" not in policy`,
        });
        continue;
      }
      if (!isPathAllowedFor(rel, policy)) {
        findings.push({
          file: rel, line: i + 1, reason,
          kind: 'WRONG_PATH',
          detail: `tag "${reason}" only allowed in ${policy.allowedPaths.join(', ')}`,
        });
      }
    }
  }

  if (findings.length === 0) {
    console.log('scan-annotations: 0 findings — every @tenant-reviewed annotation is policy-compliant.');
    return;
  }

  console.log(`scan-annotations: ${findings.length} finding(s).`);
  const byKind: Record<string, number> = {};
  for (const f of findings) {
    byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
    console.log(`  ${f.kind.padEnd(15)} ${f.file}:${f.line}  ${f.reason} — ${f.detail}`);
  }
  console.log(`\nBy kind: ${Object.entries(byKind).map(([k, n]) => `${k}=${n}`).join(' ')}`);
  console.log(
    'Policy: SAAS_PHASE2_SCANNER_ANNOTATION_POLICY.md.\n' +
    'Add a new reason to KNOWN_REASONS in scripts/scan-annotations.ts together with the policy doc.',
  );

  if (strict) {
    console.error('\nFAIL (--strict-annotations).');
    process.exit(1);
  }
  console.log('WARN-ONLY mode. Pass --strict-annotations to fail the build on findings.');
}

main().catch((e) => { console.error(e); process.exit(2); });
