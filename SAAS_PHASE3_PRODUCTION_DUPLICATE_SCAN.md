# SaaS Phase 3.1 — Production-shaped Duplicate Scan

## Purpose
Materialise the duplicate set on a **production-shaped** SAFE clone
before any cleanup or constraint migration is planned.

Phase 3.0's `uniqueness-duplicate-report` covered the same logical
checks against the fixture; this Phase 3.1 script extends it with:

- Strict environment refusal on `UNSAFE_PRODUCTION` / `UNKNOWN`.
- Email **masking** in the MD report (e.g. `j***@example.com`) so
  the markdown can be circulated without leaking PII.
- Cleanup-bucket classification per duplicate group:
  - `exact` — only one row in the group is non-deleted (safe to soft-delete the duplicates)
  - `conflicting_active` — multiple non-deleted rows (manual triage)
  - `null_tenant_assignment_required` — group has `tenantId = NULL`
  - `manual_review` — anything that does not fit the above
    (covers the cross-tenant observation set)

## Environment safety
- `classifyRuntimeEnv()` → SAFE_CLONE / SAFE_STAGING only.
- `BEGIN READ ONLY` wrapper.
- Source contains zero `INSERT/UPDATE/DELETE`.
- DATABASE_URL host is reported as kind, not secret.

## How to run
```
DATABASE_URL=postgres://… \
  npm run saas:phase310-production-duplicate-scan
```
Outputs:
- `backend/reports/saas/phase3/production-duplicate-scan.json` (full values for cleanup tooling)
- `backend/reports/saas/phase3/production-duplicate-scan.md` (masked, share-safe)

## Sections
1. Employee.email — same-tenant
2. Employee.email — NULL-tenant
3. Applicant.email — same-tenant
4. Applicant.email — NULL-tenant
5. Employee.employeeNumber — same-tenant
6. Employee.employeeNumber — NULL-tenant
7. Cross-tenant same-email observations (NOT blocking)
8. Blocking duplicate group total (sections 1-6 only)
9. Cleanup buckets (counts per bucket)

## Fixture run summary
- Blocking duplicates: 0
- Cross-tenant observations: 0
- All buckets empty.

## Go / no-go for Phase 3.2 cleanup
Phase 3.2 cleanup runs on a per-bucket basis. Buckets `exact` and
`conflicting_active` are non-empty triggers; `null_tenant_assignment_required`
is gated behind Phase 3.1 backfill completion.

## Go / no-go for Phase 3.3 constraints
Constraints can only be introduced once `blockingDuplicateGroups=0`.

## Rollback
No data or schema changes. Revert script + docs only.

---

## Phase 3.2 addendum

Cleanup planning + gated apply layer landed (dry-run-first).
`exact` groups are auto-cleanable via soft-delete;
`conflicting_active` are never auto-mutated;
NULL-tenant and cross-tenant groups remain untouched.
See SAAS_PHASE3_DUPLICATE_CLEANUP_PLAN.md.
