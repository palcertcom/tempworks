# SaaS Phase 3.4 — Drop Legacy Global Employee UNIQUEs

## Scope

This is the only **destructive** Phase 3 migration. It drops two
legacy global single-column unique constraints/indexes from
`employees`:

- `employees_email_key` — single-column UNIQUE on `email`
- `employees_employeeNumber_key` — single-column UNIQUE on `employeeNumber`

After this migration, the same email or employee number can be reused
across tenants. Within a single tenant, uniqueness is still enforced
by the Phase 3.3 partial indexes.

## Dropped

| Object | Type | Reason |
|---|---|---|
| `employees_email_key` | single-column UNIQUE constraint/index | blocked cross-tenant Employee identity reuse |
| `employees_employeeNumber_key` | single-column UNIQUE constraint/index | blocked cross-tenant employee numbering |

## Retained

| Object | Reason |
|---|---|
| `employees_tenant_email_unique` (Phase 3.3 partial index) | per-tenant Employee.email uniqueness |
| `employees_tenant_employee_number_unique` (Phase 3.3 partial index) | per-tenant employeeNumber uniqueness |
| `applicants_tenant_email_unique` (Phase 3.3 partial index) | per-tenant Applicant.email uniqueness |
| `users_email_key` (global UNIQUE) | login identity stays global |
| `users_userNumber_key` (global UNIQUE) | internal staff numbering |
| `roles_name_key` (global UNIQUE) | role-template name |
| `tenants_slug_key` / `tenants_customDomain_key` | tenant routing |
| All other indexes | untouched |

## Migration files
- `backend/prisma/migrations/saas_phase34_drop_employee_global_uniques/migration.sql`
- `backend/prisma/migrations/saas_phase34_drop_employee_global_uniques/migration.down.sql`

## Why guarded DO blocks

The migration uses `DO $$ … $$` blocks that:
1. Look up the named UNIQUE constraint in `pg_constraint`. Drop only
   if it exists and is of type `u` (UNIQUE).
2. Look up the named index in `pg_indexes`. Drop only if its
   definition is a single-column UNIQUE index with no `WHERE` clause
   and no `tenantId` reference.

This blocks accidental drops of:
- Partial indexes (any `WHERE` clause).
- Composite indexes.
- Phase 3.3 per-tenant partial indexes (they reference `tenantId`).
- Any future index that happens to share a fragment of the name.

## Migration risks

| Risk | Mitigation |
|---|---|
| Dropping the wrong index | Guarded DO blocks; exact name match + partial-index exclusion |
| Cross-tenant duplicates inserted before bake | Phase 3.3 was a 24h bake; Phase 3.1/3.2 reports re-run pre-migration |
| Phase 3.3 per-tenant index missing (so nothing enforces uniqueness post-drop) | Operator must confirm Phase 3.3 indexes exist (`SELECT … FROM pg_indexes`) before running this migration |
| Application code still relying on the global behaviour | None known — service layer uses Prisma `findFirst({ where: {tenantId, email} })` after Phase 2 pilot |

## Backup requirement

**Mandatory.** Take a full DB backup BEFORE running this migration.
The down migration cannot restore data, and cross-tenant duplicate
inserts that land between Phase 3.4 apply and rollback will block the
down migration entirely.

## Down migration caveat

```sql
CREATE UNIQUE INDEX IF NOT EXISTS "employees_email_key" ON "employees" (email);
CREATE UNIQUE INDEX IF NOT EXISTS "employees_employeeNumber_key" ON "employees" ("employeeNumber");
```
**Will fail** if cross-tenant duplicate emails or employeeNumbers
were inserted after Phase 3.4 went live. Recovery paths:
- Resolve duplicates first (re-run Phase 3.2 cleanup planning with
  the global already dropped; product decides which row keeps the
  identifier).
- Restore from the pre-Phase-3.4 backup.

## Expected behaviour change

| Scenario | Before Phase 3.4 | After Phase 3.4 |
|---|---|---|
| Same-tenant duplicate Employee.email | rejected | rejected (partial index) |
| Cross-tenant duplicate Employee.email | **rejected** (global) | **allowed** |
| Same-tenant duplicate Employee.employeeNumber | rejected | rejected (partial index) |
| Cross-tenant duplicate Employee.employeeNumber | **rejected** (global) | **allowed** |
| User.email duplicate | rejected (global) | rejected (global) — unchanged |
| Applicant same-tenant email | rejected (partial index) | rejected (partial index) |
| Applicant cross-tenant same email | allowed | allowed — unchanged |
| Soft-deleted row blocking active row | not blocked | not blocked — unchanged |
| NULL-tenant rows | blocked by global on Employee | **no longer blocked** (no constraint) |

## Prerequisite gate (production)

Operators must confirm BEFORE running this migration in production:
1. Phase 3.1 reports re-run against the production-shaped clone:
   - `tenant-backfill-completeness-report.blocksPhase33Constraints === false`
   - `production-duplicate-scan.blockingDuplicateGroups === 0`
2. Phase 3.2 cleanup plan against the production-shaped clone:
   - `duplicate-cleanup-plan.counts.conflicting_active === 0`
3. Phase 3.3 migration applied to production at least 24h prior.
4. App-layer Employee create/update paths confirmed to stamp
   `tenantId` on every write.
5. Full DB backup taken.

## Harness results

`saas:phase340-drop-employee-global-uniques`: **20/20 PASS**

Source-level (1-6): asserts migration does not touch User, Applicant,
or Phase 3.3 per-tenant indexes; verifies WHERE-clause guard against
dropping partial indexes; no UPDATE/DELETE in up SQL.

DB-level (7-13): seeds rows in two tenants, applies the migration,
verifies cross-tenant Employee identifier reuse is now allowed,
same-tenant uniqueness is still enforced, User.email is still
globally unique, Applicant behaviour is unchanged.

Down-migration (14-16): cleans cross-tenant duplicates, runs down
migration, verifies both globals restored, asserts the caveat text
is present in the down SQL.

Cross-phase (17-20): Phase 3.0-3.3 sentinel wiring intact + outputs
present. The harness restores globals + Phase 3.3 partial indexes at
exit so the shared fixture remains usable for downstream harnesses.

## Validation

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npx prisma validate` | clean |
| `npm run saas:schema-lint` | 0 issues |
| `npm run saas:scan:annotations` | 0 findings |
| `npm run saas:scan:raw-sql` | baseline unchanged |
| `saas:phase340-drop-employee-global-uniques` | 20/20 PASS |
| `saas:phase330-per-tenant-unique-constraints` | 19/19 PASS |
| `saas:phase320-duplicate-cleanup-harness` | 22/22 PASS |
| `saas:phase310-readiness-check` | 16/16 PASS |
| `saas:phase300-product-migration-readiness` | 13/13 PASS |
| `saas:phase263-workflow-config-isolation` | 19/19 PASS |
| `saas:phase262-pipeline-mutation-isolation` | 17/17 PASS |
| `saas:phase261-pipeline-isolation` | 12/12 PASS |
| `saas:phase261-pipeline-equivalence` | 12/12 PASS |

Cumulative regression: **914/914 PASS** (894 + 20).

## Production rollout checklist

1. Schedule a maintenance window (read traffic OK; writes to
   Employee should be paused or low).
2. Confirm prerequisite gate above.
3. Take DB backup.
4. Apply Phase 3.4 migration in production.
5. Confirm `employees_tenant_email_unique` and
   `employees_tenant_employee_number_unique` are still in
   `pg_indexes`.
6. Confirm `users_email_key` is still in `pg_constraint`.
7. Run smoke test: insert two Employees with same email in different
   tenants (then roll back the insert).
8. Bake for 24-48h before considering Phase 3.4 stable.

## Rollback instructions

If still within the same maintenance window AND no cross-tenant
duplicates have been written:
```sql
\i prisma/migrations/saas_phase34_drop_employee_global_uniques/migration.down.sql
```
If cross-tenant duplicates exist, either resolve them via Phase 3.2
cleanup planning or restore the pre-migration backup.

## Production behaviour change status

DB-level enforcement weakens cross-tenant uniqueness on Employee.
Same-tenant uniqueness is unchanged (now enforced exclusively by the
Phase 3.3 partial indexes). User.email, Role.name, and Tenant
identifiers are unchanged.

## Recommended next phase

**Phase 3.5 — PlatformAdmin backfill.** The platform admin foundation
is documented (`SAAS_PHASE3_PLATFORM_ADMIN_FOUNDATION.md`) and the
readiness report scaffold is in place. Phase 3.5 implements the
two-flag gated backfill (`PLATFORM_ADMIN_BACKFILL_APPLY=true` plus
SAFE classification) that promotes every user attached to an
`isSystem=true` agency to a `PlatformAdmin{level: SUPER}` row,
starting the retirement path for `Agency.isSystem`.
