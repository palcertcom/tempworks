# SaaS Phase 3.0 — Per-Tenant Uniqueness Audit

## Current constraints (schema + DB)

| Model      | Column          | Current uniqueness   | Has `tenantId`? | Notes                                   |
| ---------- | --------------- | -------------------- | --------------- | --------------------------------------- |
| `User`     | `email`         | **GLOBAL @unique**   | no              | Login identity. Likely stays global.    |
| `User`     | `userNumber`    | GLOBAL `@unique`     | no              | Internal staff numbering.               |
| `Employee` | `email`         | **GLOBAL @unique**   | yes (nullable)  | Conflicts with SaaS per-tenant model.   |
| `Employee` | `employeeNumber`| GLOBAL `@unique`     | yes (nullable)  | Tenants reuse number sequences.         |
| `Applicant`| `email`         | NONE                 | yes (nullable)  | Re-applications mean repeats are real.  |
| `Role`     | `name`          | GLOBAL `@unique`     | no              | Tenant-template roles will eventually need per-tenant scope (out of Phase 3.0). |
| `Agency`   | (email/name)    | none                 | n/a (Agency≈Tenant) | `isSystem` flag retired by PlatformAdmin foundation. |
| `Tenant`   | `slug`, `customDomain` | GLOBAL `@unique` | n/a            | Correct as-is.                          |

## Desired future constraints

| Model      | Future constraint                       | Strategy                                    |
| ---------- | --------------------------------------- | ------------------------------------------- |
| `Employee` | `@@unique([tenantId, email])`           | Strategy A (per-tenant). Global `email` UNIQUE retired AFTER backfill + duplicate cleanup. |
| `Employee` | `@@unique([tenantId, employeeNumber])`  | Per-tenant numbering. Global `employeeNumber` UNIQUE retired AFTER backfill. |
| `Applicant`| `@@unique([tenantId, email])`           | Add new (no current constraint). Will likely require **partial index** filtered on `deletedAt IS NULL` to allow reactivation patterns. |
| `User`     | unchanged (`email` global @unique)      | Login identity remains global. Cross-tenant memberships handled by `UserTenant`. |

## Duplicate risk

Run `npm run saas:phase300-uniqueness-duplicate-report` against staging
clones to materialise the live picture. The fixture run currently reports
**0 blocking duplicate groups**, but production data is unverified.

Anticipated risk areas:
- **Employee.email vs. Applicant.email** — applicants are converted into
  employees; some tenants may have duplicate applicant emails today
  (since there is no constraint at all).
- **Employee.employeeNumber** — historically agency-scoped sequences;
  cross-tenant collisions almost certainly exist if multiple tenants
  reused the same number prefix.
- **NULL-tenant rows** — Phase 1/2 left transitional rows nullable.
  Per-tenant uniqueness cannot be enforced until these rows are
  backfilled.

## Migration order

1. **Now (Phase 3.0)** — read-only duplicate detection + docs. No
   schema changes. No data changes.
2. **Phase 3.1** — finish tenant backfill for any remaining
   `tenantId IS NULL` rows on `Employee` / `Applicant`. Re-run report.
3. **Phase 3.2** — operational cleanup of detected same-tenant
   duplicates (merge / archive / append-suffix) under product approval.
   No schema changes yet.
4. **Phase 3.3** — additive constraint introduction. Add
   `@@unique([tenantId, email])` etc. behind an explicit migration,
   `IF NOT EXISTS` guarded, with the global `email` UNIQUE retained in
   parallel (both coexist — the per-tenant one is strictly weaker than
   the global one, so retaining the global is safe).
5. **Phase 3.4** — drop the global `@unique(email)` (destructive
   migration). Only after all per-tenant rows are stamped and all
   tenant onboarding paths write `tenantId`.

## Rollback notes

- Phase 3.0 is non-destructive. Rollback = revert docs/scripts.
- Phase 3.3 additive constraint: rollback via `DROP INDEX`. No data
  loss; the script asserts no existing per-tenant collisions before the
  unique constraint is added (using the duplicate report).
- Phase 3.4 destructive drop of the global UNIQUE is the only step
  with an irreversible feel; mitigation is double-check via duplicate
  report + a 24-hour bake.

## Out of scope (this phase)

- Adding any unique constraint.
- Touching `User.email` / login identity.
- Removing `Agency.isSystem` (replaced incrementally by `PlatformAdmin`
  — see `SAAS_PHASE3_PLATFORM_ADMIN_FOUNDATION.md`).
- UI/API changes to tenant selection.

---

## Phase 3.1 addendum

Production-shaped duplicate scan and tenant-backfill completeness
report landed (read-only). Confirms the stage-2 trigger (NULL-tenant
backfill completion) is the gating step for Phase 3.3 constraint
introduction. See SAAS_PHASE3_PRODUCTION_DUPLICATE_SCAN.md and
SAAS_PHASE3_TENANT_BACKFILL_COMPLETENESS.md.

---

## Phase 3.2 addendum

Same-tenant duplicate cleanup planning landed. Phase 3.3 unique
constraint introduction is now gated on
`duplicate-cleanup-plan.json.counts.conflicting_active === 0` AND
apply completion. See SAAS_PHASE3_DUPLICATE_CLEANUP_PLAN.md.

---

## Phase 3.3 addendum

Three additive partial unique indexes landed:
- `employees_tenant_email_unique` ON (tenantId, lower(email)) WHERE tenantId IS NOT NULL AND email IS NOT NULL AND deletedAt IS NULL
- `employees_tenant_employee_number_unique` ON (tenantId, employeeNumber) WHERE … AND deletedAt IS NULL
- `applicants_tenant_email_unique` ON (tenantId, lower(email)) WHERE … AND deletedAt IS NULL

Existing global Employee.email / Employee.employeeNumber UNIQUEs
retained. Phase 3.4 will drop the globals after bake. See
SAAS_PHASE3_PER_TENANT_UNIQUE_CONSTRAINTS.md.

---

## Phase 3.4 addendum

Legacy global Employee UNIQUEs dropped. Final state:
- Employee.email: per-tenant only (employees_tenant_email_unique)
- Employee.employeeNumber: per-tenant only
- Applicant.email: per-tenant only (no global)
- User.email: GLOBAL UNIQUE (unchanged — login identity)
See SAAS_PHASE3_DROP_EMPLOYEE_GLOBAL_UNIQUES.md.
