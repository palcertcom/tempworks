# Phase 2.35 — Agencies Module Audit

> Inventory and decision matrix for the `src/agencies` reads-first pilot.

---

## 1. Files in module

| File | Lines | Role |
|---|--:|---|
| `src/agencies/agencies.controller.ts` | 141 | HTTP routes |
| `src/agencies/agencies.service.ts` | 369 | All Prisma calls live here |
| `src/agencies/agencies.module.ts` | 10 | Nest module wiring |
| `src/agencies/dto/*.ts` | (4) | Request DTOs |

`AgenciesService` constructs with `PrismaService` + `StorageService`. No
pilot accessor today.

## 2. Models touched

| Model | Where | Has `tenantId`? |
|---|---|---|
| `Agency` | `listPublic`, `findAll`, `findOne`, `create`, `update`, `uploadLogo`, `remove`, `setManager` | **YES** (`Agency.tenantId String?`, indexed) |
| `User` | `getUsers`, `getStats`, `setManager` (verify) | YES |
| `Employee` | `getEmployees`, `getStats` | YES (Phase 2.33) |
| `EmployeeAgencyAccess` | `getEmployees`, `getStats` (external-actor filter) | NO column; rides on `agencyId` |
| `AgencyPermissionOverride` | `listPermissionOverrides`, `setPermissionOverride`, `removePermissionOverride` | NO column; rides on `agencyId` |
| `AuditLog` | `create`/`update`/`uploadLogo`/`remove`/`setPermissionOverride`/`removePermissionOverride`/`setManager` | YES (Phase 2.30) — but writes here go through `legacyPrisma` directly today |

## 3. Per-method classification

| # | Method | Type | Phase 2.35 |
|---|---|---|---|
| 1 | `listPublic()` | READ — public, no auth | **GLOBAL by design** (`phase235-global`) — used by the public application form to list agencies the applicant can submit to. **NOT** narrowed (would break public flow). |
| 2 | `findAll(pagination, actor?)` | READ | **INCLUDED** — `where.tenantId` spread for non-external actors; external-actor `id = actor.agencyId` filter preserved. |
| 3 | `findOne(id, actor?)` | READ + permission check | **INCLUDED** — `findFirst({ id, deletedAt: null, ...tenantWhere() })`. `assertAgencyAccess` unchanged. |
| 4 | `create(dto, actorId?, actorRole?)` | WRITE | **EXCLUDED** — `phase235-excluded-mutation` |
| 5 | `update(...)` | WRITE | **EXCLUDED** — `phase235-excluded-mutation` (`findOne` becomes tenant-scoped this phase, but the `legacyPrisma.update` stays untouched until Phase 2.36) |
| 6 | `uploadLogo(id, file, actorId?)` | WRITE + storage | **EXCLUDED** — `phase235-excluded-storage` (mirror applicants/employees storage-guard pattern; Phase 2.36) |
| 7 | `remove(id, deletedById?)` | WRITE | **EXCLUDED** — `phase235-excluded-mutation` |
| 8 | `getUsers(id, pagination, actor?)` | READ | **INCLUDED** — parent gate via `findOne`; inner `User.findMany({agencyId: id})` runs over the gated parent |
| 9 | `getEmployees(id, pagination, actor?)` | READ | **INCLUDED** — parent gate via `findOne`; inner `Employee.findMany` by `agencyId` plus existing external-actor `EmployeeAgencyAccess` filter |
| 10 | `getStats(id, actor?)` | READ | **INCLUDED** — same parent-gate pattern |
| 11 | `listPermissionOverrides(agencyId)` | READ | **INCLUDED** — parent gate via `findOne` |
| 12 | `setPermissionOverride(...)` | WRITE | **EXCLUDED** — `phase235-excluded-mutation` |
| 13 | `removePermissionOverride(...)` | WRITE | **EXCLUDED** — `phase235-excluded-mutation` |
| 14 | `setManager(agencyId, userId, actorId?)` | WRITE | **EXCLUDED** — `phase235-excluded-mutation` |
| 15 | Audit-log emissions inside mutation paths | WRITE | **EXCLUDED** — kept `legacyPrisma` until agencies opt into the shared `TenantAuditLogService` |

## 4. Tenant ownership path

`Agency.tenantId` is denormalized by Phase 1. For pilot reads, the
filter is `where.tenantId = <ALS tenant>` **OR** `where.isSystem = true`
(see `SAAS_PHASE2_AGENCIES_SYSTEM_AGENCY_DECISION.md` §3 for why).

`User`, `Employee`, `EmployeeAgencyAccess`, and
`AgencyPermissionOverride` all ride on the gated parent `agencyId` —
once the parent is tenant-scoped, the child queries are tenant-safe.

## 5. Uniqueness constraints

`Agency` has no `@unique` columns at the table level (no `name @unique`,
no `email @unique`). `@@unique` constraints exist on
`AgencyPermissionOverride(agencyId, permission)` and
`EmployeeAgencyAccess(employeeId, agencyId)` — both ride on the gated
agency parent.

There is **nothing analogous to** `Employee.email @unique` /
`Applicant.email @unique` on `Agency` — Phase 2.35 has no Phase 3
uniqueness debt to defer.

## 6. Global / system-agency scans

- `listPublic()` — public agency listing for the apply form. Phase
  2.35 keeps it global. Tag: `phase235-global`.
- `Agency.isSystem` rows (Tempworks root) — visible to every tenant
  in pilot mode via the `OR isSystem: true` clause in `where`.

## 7. Current cross-tenant risk (pre-2.35)

- `findAll` returns the union across tenants for any non-external
  actor (System Admin / Tempworks staff). **HIGH** — every system
  admin / Tempworks staff request sees both tenants today.
- `findOne` resolves any tenant's agency id without restriction.
  **HIGH** — same vector.
- `getUsers`, `getEmployees`, `getStats`,
  `listPermissionOverrides` inherit the gap because they call the
  un-narrowed `findOne` first.

Phase 2.35 closes all of these in pilot mode.

## 8. Permissions / agency visibility

- External actor (`agencyIsSystem !== true`) is restricted to their
  own agency by `assertAgencyAccess`. Preserved exactly.
- System Admin / Tempworks-root user (`agencyIsSystem === true`)
  sees the global view in legacy mode; in pilot mode they see
  `tenantId = active OR isSystem = true`.
- `Agency.PROTECTED_FIELDS_FOR_MANAGER` business rule preserved.

## 9. Scope summary

**Included (read-only):** `findAll`, `findOne`, `getUsers`,
`getEmployees`, `getStats`, `listPermissionOverrides`.

**Global-by-design:** `listPublic()` — public agency dropdown for the
apply form.

**Excluded:** `create`, `update`, `uploadLogo`, `remove`,
`setPermissionOverride`, `removePermissionOverride`, `setManager`,
audit-log writes inside mutation paths.

## 10. Notes for Phase 2.36

- Mutation pilot needs a parent gate helper (`findAgencyOrFail`,
  mirror of applicants 2.29 + employees 2.34).
- `uploadLogo` mirrors employees 2.34 / applicants 2.31 storage-guard.
- `Agency.create` could spread `scope.tenantData()` once the
  caller's ALS frame is reliable (currently `create` is a System
  Admin path that may not have an ALS frame).
- Audit emissions could move to `TenantAuditLogService` for tenant
  attribution, mirroring Phase 2.30.
- System-agency mutation semantics are out of scope until product
  decides whether `isSystem` becomes a platform-only field.
