# SaaS Phase 3.1 — Tenant Backfill Completeness

## Purpose
Quantify how many `Employee` and `Applicant` rows still carry
`tenantId IS NULL`. These rows block Phase 3.3 unique-constraint
introduction (they would all collide with each other under any
`@@unique([tenantId, ...])` index).

## Environment safety
- Refuses to run unless `classifyRuntimeEnv()` returns `SAFE_CLONE`
  or `SAFE_STAGING`.
- Wraps every query in `BEGIN READ ONLY`.
- Source contains zero `INSERT/UPDATE/DELETE`.
- DATABASE_URL host is reported as `local (host)` / `staging (host)` /
  `remote (host)` — secrets never printed.

## How to run
```
DATABASE_URL=postgres://… \
  npm run saas:phase310-tenant-backfill-completeness-report
```
Outputs:
- `backend/reports/saas/phase3/tenant-backfill-completeness-report.json`
- `backend/reports/saas/phase3/tenant-backfill-completeness-report.md`

## Report shape
- Per-table totals (Employee, Applicant)
- `tenantId IS NULL` vs `IS NOT NULL` counts
- Status breakdown (e.g. `PENDING`, `ACTIVE`, etc.)
- Up to 10 sample NULL-tenant ids (no PII)
- `blocksPhase32Cleanup` / `blocksPhase33Constraints` boolean flags

## Fixture run summary
- Employee: 2 NULL-tenant rows (synthesized templates) — non-blocking
  for production planning since fixture is intentionally heterogeneous.
- Applicant: 0 NULL-tenant rows.

## Go / no-go for Phase 3.2 cleanup
A non-zero `nullTenant` count on either table means Phase 3.2 cannot
safely run cleanup heuristics that assume tenant scope. Backfill
those rows first (per-row tenant resolution via `agencyId` →
`Agency.tenantId` mapping; this scaffold already exists from Phase 1).

## Go / no-go for Phase 3.3 constraints
Same blocker. Add `@@unique([tenantId, …])` only after `nullTenant=0`
and same-tenant duplicate cleanup is complete (see
`SAAS_PHASE3_PRODUCTION_DUPLICATE_SCAN.md`).

## Rollback
No data or schema changes. Revert script + docs only.
