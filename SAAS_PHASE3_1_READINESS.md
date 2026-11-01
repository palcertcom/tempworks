# SaaS Phase 3.1 — Readiness

Phase 3.1 wraps three read-only reports in a single 16-case harness
(`saas:phase310-readiness-check`) so a single command surfaces the
production-shaped picture without changing any data.

## Reports
- `tenant-backfill-completeness-report` — NULL-tenant inventory on
  Employee + Applicant.
- `production-duplicate-scan` — duplicate detection with PII masking
  in the share-safe MD; full values in JSON for cleanup tooling.
- `platform-admin-readiness-report` — population that would become a
  `PlatformAdmin` row in Phase 3.5; surfaces orphans and conflicts.

## Environment safety
All four scripts:
- Refuse to run on `UNSAFE_PRODUCTION` / `UNKNOWN`.
- Run inside `BEGIN READ ONLY` transactions.
- Contain no `INSERT/UPDATE/DELETE` SQL (source-asserted by the
  readiness harness).
- Report `target` host kind without leaking secrets.

## Validation
| Check                                | Result |
| ------------------------------------ | ------ |
| `nest build` / `npx tsc --noEmit`    | clean |
| `npx prisma validate`                | clean |
| `npm run saas:schema-lint`           | 0 issues |
| `npm run saas:scan:annotations`      | 0 findings |
| `npm run saas:scan:raw-sql`          | baseline unchanged (26) |
| `saas:phase310-tenant-backfill-completeness-report` | runs |
| `saas:phase310-production-duplicate-scan`           | runs |
| `saas:phase310-platform-admin-readiness-report`     | runs |
| `saas:phase310-readiness-check`                     | **16/16 PASS** |
| `saas:phase300-product-migration-readiness`         | 13/13 PASS |
| `saas:phase300-uniqueness-duplicate-report`         | runs |
| `saas:phase263-workflow-config-isolation`           | 19/19 PASS |
| `saas:phase262-pipeline-mutation-isolation`         | 17/17 PASS |
| `saas:phase261-pipeline-isolation`                  | 12/12 PASS |
| `saas:phase261-pipeline-equivalence`                | 12/12 PASS |

Cumulative regression: **853/853 PASS** (837 from Phase 3.0 + 16).

## Go / no-go matrix

| Phase                   | Trigger                                              | Status (fixture) |
| ----------------------- | ---------------------------------------------------- | ---------------- |
| 3.2 (cleanup)           | duplicate-scan reports a non-empty `exact` or `conflicting_active` bucket | not triggered |
| 3.3 (constraints)       | `blockingDuplicateGroups = 0` AND `Employee/Applicant.nullTenant = 0` | blocked (fixture has 2 NULL-tenant Employees by design) |
| 3.5 (PlatformAdmin backfill) | `wouldBackfill > 0` AND `multiAgency = 0` AND `missingUser = 0` | not triggered |

Production decisions require running the same chain against the
production-shaped staging clone.

## Production behaviour
Unchanged. No feature flag, no schema migration, no auth path
touched. Legacy `Agency.isSystem` paths remain authoritative.

## Rollback
No data or schema changes. Revert docs and scripts only.

## Recommended next phase
**Phase 3.2 — Same-tenant duplicate cleanup planning.** Build the
per-bucket remediation runbook (soft-delete the lower-priority row
in each `exact` group, escalate `conflicting_active` to product),
then implement a dry-run-first cleanup script gated by the existing
SAFE classification flag pattern.

---

## Phase 3.2 addendum

Cleanup planner + gated apply added
(`saas:phase320-duplicate-cleanup-{plan,apply,harness}`). Harness
22/22 PASS. Cumulative regression: 875/875. See
SAAS_PHASE3_DUPLICATE_CLEANUP_PLAN.md.
