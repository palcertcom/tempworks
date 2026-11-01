# Phase 2.33 — Employees Uniqueness Review

> Why Phase 2.33 must NOT change employee uniqueness, and what
> Phase 3 will do.

---

## 1. Current uniqueness constraints

| Field | Constraint | Scope |
|---|---|---|
| `Employee.email` | `@unique` | **global** — two tenants cannot share an email |
| `Employee.employeeNumber` | `@unique` | **global** — `E{YYYY}{MM}{NNNNN}` serial |
| `Employee.id` | `@id` | global UUID, no collision risk |
| `Employee.licenseNumber` | (no unique constraint) | n/a |
| `Employee.passport*` / nationalId-like | (no unique constraint) | n/a |

There is no `(tenantId, field)` composite unique constraint on any
employee field today.

## 2. Why uniqueness is global today

`Employee.email` and `Employee.employeeNumber` were declared globally
unique long before SaaS multi-tenancy. The `generateEmployeeNumber`
raw SQL relies on `MAX(SUBSTRING(employeeNumber FROM 8))` over the
entire table — switching to per-tenant requires either a per-tenant
sequence table (preferred) or a window function over the per-tenant
subset.

`Employee.email` global uniqueness is symmetric with
`Applicant.email @unique` (deferred to Phase 3 in
`SAAS_PHASE2_APPLICANTS_PILOT_RESULTS.md`).

## 3. Collision risk during SaaS migration

| Field | Risk in pilot mode | Risk in legacy mode |
|---|---|---|
| `Employee.email` | Tenant B cannot create an employee with an email already used by tenant A. **Real risk** when two SaaS tenants legitimately share a contractor. | Same. |
| `Employee.employeeNumber` | Sequence is global; tenant A's serial increments past tenant B's, which leaks employee count between tenants when an operator can read both serials side-by-side. | Same. |

The risks exist today and are not introduced by Phase 2.33.

## 4. Why Phase 2.33 must not change uniqueness

- Strict rule of Phase 2.33: "Do not change employee-code or email
  uniqueness behavior."
- Changing `@unique` to `@@unique([tenantId, email])` is a schema
  migration that conflicts with existing data: Postgres will reject
  the migration if any duplicate `(tenantId=NULL, email)` rows
  exist or if NULL tenants collide with set tenants.
- A safe migration requires a backfill of every NULL-tenant row
  (legacy data) plus a coordinated rename of the unique constraint.
  That is a Phase 3 product question.

## 5. Phase 3 transition plan (sketch)

1. Backfill every `Employee.tenantId` (and every related
   `Document`/`FinancialRecord` linked by `entityId`).
2. Add `@@unique([tenantId, email])` and
   `@@unique([tenantId, employeeNumber])` while keeping the existing
   `@unique` columns.
3. Migrate `generateEmployeeNumber` raw SQL to a per-tenant variant
   (or a dedicated `employee_number_sequences(tenantId, year, month, serial)` table).
4. Deploy with both unique constraints active for one release; once
   no row violates the new shape, drop the global `@unique`.

This is a multi-step migration and is explicitly out of scope for
Phase 2.33.

## 6. Production-safety summary

Phase 2.33 does not touch uniqueness. The duplicate-email check
inside `create` continues to be global and is tagged `phase233-global`.
`generateEmployeeNumber` continues to be the global raw SQL helper
and is tagged `phase233-global`.
