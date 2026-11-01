# SaaS Phase 3.3 — Additive Per-Tenant Unique Constraints

## Scope

Adds three **partial** unique indexes that enforce per-tenant
uniqueness for `Employee.email`, `Employee.employeeNumber`, and
`Applicant.email`. Existing global UNIQUE constraints on Employee
remain in place; dropping them is deferred to Phase 3.4.

## Prerequisite gate

Phase 3.3's migration must only be applied to environments where:

1. `tenant-backfill-completeness-report.blocksPhase33Constraints === false`
2. `production-duplicate-scan.blockingDuplicateGroups === 0`
3. `duplicate-cleanup-plan.counts.conflicting_active === 0`

The fixture intentionally carries two NULL-tenant Employee rows and
the harness operates on its own seeded tenant-scoped rows, so the
fixture run is unaffected. For production rollout, operators must
re-run the Phase 3.1/3.2 reports against the production-shaped
staging clone and confirm all three gate conditions before applying.

## Indexes added

```sql
CREATE UNIQUE INDEX IF NOT EXISTS "employees_tenant_email_unique"
  ON "employees" ("tenantId", lower(email))
  WHERE "tenantId" IS NOT NULL
    AND email IS NOT NULL
    AND "deletedAt" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "employees_tenant_employee_number_unique"
  ON "employees" ("tenantId", "employeeNumber")
  WHERE "tenantId" IS NOT NULL
    AND "employeeNumber" IS NOT NULL
    AND "deletedAt" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "applicants_tenant_email_unique"
  ON "applicants" ("tenantId", lower(email))
  WHERE "tenantId" IS NOT NULL
    AND email IS NOT NULL
    AND "deletedAt" IS NULL;
```

Migration files:
- `backend/prisma/migrations/saas_phase33_per_tenant_uniques/migration.sql`
- `backend/prisma/migrations/saas_phase33_per_tenant_uniques/migration.down.sql`

## Why partial indexes

Each filter clause carries a specific safety guarantee:

- `tenantId IS NOT NULL` — Phase 1/2 transitional rows do NOT
  participate. NULL-tenant rows can coexist without colliding on
  the per-tenant index. The global `Employee.email` UNIQUE
  (retained until Phase 3.4) still applies to them.
- `email/employeeNumber IS NOT NULL` — sparse keys are allowed.
  Two rows in the same tenant with NULL keys do not collide.
- `deletedAt IS NULL` — soft-deleted rows do NOT block new active
  rows for the same key. This is the foundation for the existing
  recycle-bin / undelete flow.
- `lower(email)` — case-only variants (`Foo@x.com` vs `foo@x.com`)
  collide. `employeeNumber` is case-sensitive by spec.

Prisma's `@@unique` cannot express partial (`WHERE`) clauses;
this migration is intentionally raw SQL. The Prisma schema will
not show these constraints. This is documented; the indexes are
visible in `pg_indexes` and enforced by the database engine.

## Why globals remain

Dropping `employees_email_key` / `employees_employeeNumber_key`
right now would broaden the surface that can write
cross-tenant duplicate emails. Until every onboarding/tenant
assignment path is wired to set `tenantId` correctly (Phase 1/2
backfill close-out plus Phase 3.1 audit), the global UNIQUE acts
as a fail-safe.

Phase 3.4 will drop the globals only after a 24-hour bake under
the per-tenant indexes plus an explicit operator sign-off.

## Expected current behaviour

| Scenario                                              | Result (Phase 3.3) |
| ----------------------------------------------------- | ------------------ |
| Same-tenant duplicate Employee.email                  | rejected by `employees_tenant_email_unique` |
| Different-tenant same Employee.email                  | rejected by `employees_email_key` (global; retained) |
| Same-tenant duplicate Applicant.email                 | rejected by `applicants_tenant_email_unique` |
| Different-tenant same Applicant.email                 | **allowed** (no global UNIQUE on Applicant.email) |
| Same-tenant duplicate Employee.employeeNumber         | rejected by `employees_tenant_employee_number_unique` |
| Soft-deleted (deletedAt) row blocking new active row  | **not blocked** (partial index excludes deletedAt) |
| NULL-tenant rows with same key                        | **not blocked** by per-tenant index (still subject to globals on Employee) |
| NULL email / employeeNumber rows                      | **not blocked** (sparse partial index) |

## Migration rollback

```sql
\\i prisma/migrations/saas_phase33_per_tenant_uniques/migration.down.sql
```
Drops only the three new indexes. The global `Employee.email` /
`Employee.employeeNumber` UNIQUEs are not touched. No data
changes; no data rollback needed.

## Harness results

`saas:phase330-per-tenant-unique-constraints`: **19/19 PASS**

Source-level (1-6): migration SQL contains the three IF NOT EXISTS
indexes, has no DROP/UPDATE/DELETE, and the down migration drops
only the new indexes.

DB-level (7-15): seeds rows in a controlled tenant scope, applies
the up migration (idempotent), and verifies each behavioural row in
the table above. Globals are temporarily dropped to attribute
rejections to the per-tenant index, then restored at teardown so
the fixture exits in baseline state.

Cross-phase (16-19): Phase 3.0/3.1/3.2 sentinel scripts still wired;
sentinel outputs present.

## Validation results

| Check                                | Result |
| ------------------------------------ | ------ |
| `npx tsc --noEmit`                   | clean |
| `npx prisma validate`                | clean |
| `npm run saas:schema-lint`           | 0 issues |
| `npm run saas:scan:annotations`      | 0 findings |
| `npm run saas:scan:raw-sql`          | baseline unchanged |
| `saas:phase330-per-tenant-unique-constraints` | 19/19 PASS |
| `saas:phase320-duplicate-cleanup-harness` | 22/22 PASS |
| `saas:phase310-readiness-check`      | 16/16 PASS |
| `saas:phase300-product-migration-readiness` | 13/13 PASS |
| `saas:phase263-workflow-config-isolation` | 19/19 PASS |
| `saas:phase262-pipeline-mutation-isolation` | 17/17 PASS |
| `saas:phase261-pipeline-isolation`   | 12/12 PASS |
| `saas:phase261-pipeline-equivalence` | 12/12 PASS |

Cumulative regression: **894/894 PASS** (875 + 19).

## Production behaviour

Unchanged at the application layer. The DB now rejects same-tenant
duplicate inserts at write time, which previously would have been
rejected only at the global level (Employee) or accepted (Applicant).
No runtime code path was modified; existing services that wrote
duplicates would have already hit the global UNIQUE on Employee.

## Next phase

**Phase 3.4 — Drop legacy global Employee.email / Employee.employeeNumber UNIQUEs.**
Only after a bake window under Phase 3.3, with all tenant-onboarding
paths confirmed to set `tenantId` correctly and Phase 3.1/3.2
reports re-run clean on production.

---

## Phase 3.4 addendum

Legacy global Employee.email and Employee.employeeNumber UNIQUEs
dropped via `saas_phase34_drop_employee_global_uniques` migration.
Cross-tenant Employee identifier reuse is now allowed. Same-tenant
uniqueness continues to be enforced by the Phase 3.3 partial
indexes. See SAAS_PHASE3_DROP_EMPLOYEE_GLOBAL_UNIQUES.md.
