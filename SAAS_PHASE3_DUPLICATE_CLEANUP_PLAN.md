# SaaS Phase 3.2 — Same-Tenant Duplicate Cleanup Plan

Phase 3.2 introduces a dry-run-first planner and an opt-in, gated
apply step for **safe** same-tenant duplicate cleanup. No production
behaviour change. No schema migration. Apply is OFF by default.

## Definitions

### exact
Same-tenant duplicate group where the lower-priority active row is
clearly redundant:
- **at most one active row** in the group (others already soft-deleted), OR
- multiple active rows where **none** carry dependent records
  (`attendance_records` / `employee_stages` for Employee;
  `candidate_workflow_assignments` for Applicant).

These groups are eligible for auto soft-delete.

### conflicting_active
Same-tenant duplicate group with **two or more active rows** where
**at least one** active row carries dependent records. The keep
decision is ambiguous; manual product review is required. Apply
**never** mutates these rows.

### null_tenant_assignment_required
Duplicate group with `tenantId IS NULL`. Gated behind Phase 3.1
backfill completion. Apply never mutates these rows.

### cross_tenant_observation
Same key under two or more tenants. Informational — allowed under
per-tenant uniqueness. Apply never mutates these rows.

## Target keys
- `Employee.email`
- `Employee.employeeNumber`
- `Applicant.email`

## Priority rules (keep decision)

For each `exact` group, the kept row is selected by:
1. row with the **most dependent records** (Employee:
   `attendance_records` + `employee_stages`; Applicant:
   `candidate_workflow_assignments`)
2. row with the **newest `updatedAt`**
3. **lowest `id`** as deterministic tiebreaker

All other active rows in the group are listed in `softDeleteIds`.

## Dry-run by default

`saas:phase320-duplicate-cleanup-plan` is read-only:
- `BEGIN READ ONLY` wrapper.
- Refuses to run on `UNSAFE_PRODUCTION` / `UNKNOWN`.
- Source contains zero `INSERT/UPDATE/DELETE`.
- MD masks emails (`j***@example.com`); JSON keeps full values for the
  controlled apply step.

Outputs:
- `backend/reports/saas/phase3/duplicate-cleanup-plan.json`
- `backend/reports/saas/phase3/duplicate-cleanup-plan.md`

The JSON includes a `snapshotSql` field that captures the SQL needed
to snapshot the affected rows BEFORE running apply.

## Apply gates

`saas:phase320-duplicate-cleanup-apply` makes **no** writes unless ALL
three gates are set:

1. `PHASE3_DUPLICATE_CLEANUP_ENABLED=true`
2. `PHASE3_DUPLICATE_CLEANUP_APPLY=true`
3. Runtime classification ∈ `{ SAFE_CLONE, SAFE_STAGING }`

If any gate is closed, the script writes a refusal report and exits
without opening a DB connection.

### What apply does
- **Soft-deletes only** the rows listed under each `exact` group's
  `softDeleteIds`. Sets `deletedAt = now()`, `deletedBy = 'phase320'`,
  `deletionReason = 'phase320-duplicate-cleanup'` (each via `COALESCE`,
  so existing values are preserved → idempotent).
- Operates in a single `BEGIN / COMMIT` transaction (rollback on any
  error).

### What apply NEVER does
- Hard-delete (no `DELETE FROM` in source).
- Mutate `conflicting_active` groups.
- Mutate `null_tenant_assignment_required` groups.
- Mutate `cross_tenant_observation` groups.
- Overwrite `tenantId`.

## Snapshot SQL

Before running apply, the operator must capture the affected rows.
The plan's MD includes a ready-to-pipe block, and the JSON exposes
the same statements under `snapshotSql`:
```sql
SELECT * FROM "employees"  WHERE id IN ('…', '…');
SELECT * FROM "applicants" WHERE id IN ('…', '…');
```

## Rollback

The apply is soft-delete only, so undo is a metadata update:
```sql
UPDATE employees  SET "deletedAt"=NULL, "deletedBy"=NULL, "deletionReason"=NULL
 WHERE "deletionReason"='phase320-duplicate-cleanup';
UPDATE applicants SET "deletedAt"=NULL, "deletedBy"=NULL, "deletionReason"=NULL
 WHERE "deletionReason"='phase320-duplicate-cleanup';
```
If apply was run, rollback is data-level, not configuration-only. Do
not apply against production without a fresh DB backup and operator
sign-off.

## PII masking rules

- MD reports mask emails (`j***@example.com`).
- JSON keeps raw values for the apply step (controlled tooling).
- Sample row ids are surfaced; full names and contact details are
  never printed.

## Harness results

`saas:phase320-duplicate-cleanup-harness`: **22/22 PASS**
- read-only invariants on plan
- exact/conflicting/null/cross classification
- gate refusal for all three gates
- soft-delete semantics
- idempotency
- before/after duplicate count
- no hard-delete in source
- Phase 3.0 / Phase 3.1 wiring intact
- regression chain outputs present

## Validation

| Check                                | Result |
| ------------------------------------ | ------ |
| `npx tsc --noEmit`                   | clean |
| `npx prisma validate`                | clean |
| `npm run saas:schema-lint`           | 0 issues |
| `npm run saas:scan:annotations`      | 0 findings |
| `npm run saas:scan:raw-sql`          | baseline unchanged |
| `saas:phase320-duplicate-cleanup-harness` | 22/22 PASS |
| `saas:phase310-readiness-check`      | 16/16 PASS |
| `saas:phase300-product-migration-readiness` | 13/13 PASS |
| `saas:phase263-workflow-config-isolation` | 19/19 PASS |
| `saas:phase262-pipeline-mutation-isolation` | 17/17 PASS |
| `saas:phase261-pipeline-isolation`   | 12/12 PASS |
| `saas:phase261-pipeline-equivalence` | 12/12 PASS |

Cumulative regression: **875/875 PASS** (853 + 22).

## Go / no-go for Phase 3.3 constraints

Triggers (all must be true on the production-shaped clone):
- `tenant-backfill-completeness-report.json` → `blocksPhase33Constraints=false`
- `duplicate-cleanup-plan.json` → all `exact` groups handled by apply
  AND `counts.conflicting_active === 0`
- `production-duplicate-scan.json` → `blockingDuplicateGroups === 0`
  AFTER apply

Phase 3.2 implements the cleanup mechanism; Phase 3.3 will introduce
the additive `@@unique([tenantId, …])` constraint only after these
triggers fire.

## Production behaviour

Unchanged. No feature flag flipped, no schema migration, no auth path
touched. The apply step is opt-in and disabled by default.

---

## Phase 3.3 addendum

Additive per-tenant unique indexes have landed. Phase 3.2 cleanup
remains the prerequisite for any Phase 3.4 global-drop work.
