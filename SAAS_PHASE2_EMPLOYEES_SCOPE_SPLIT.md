# Phase 2.33 — Employees Scope Split

> What ships in Phase 2.33 vs. what waits for Phase 2.34+.

---

## 1. Scope summary

| Area | Phase | This PR? |
|------|------|----------|
| `findAll` / `findOne` | **2.33** | YES — `tenantWhere()` spread; preserves agency-grant filter additively |
| `listAgencyAccess` | **2.33** | YES — parent-gated by tenant-scoped `findOne`-like read |
| `getFinancialProfile` / `getDocuments` / `getWorkflow` / `getCompliance` / `getCertifications` / `getTraining` / `getPerformance` | **2.33** | YES — parent-gated reads |
| `exportExcel` (by-id + default branches) | **2.33** | YES |
| Employee CRUD (`create`, `update`, `remove`, `updateStatus`) | 2.34+ | NO |
| `uploadPhoto` (storage) | 2.34+ | NO (mirror applicants 2.31 storage-guard) |
| Agency-access mutations (`grantAgencyAccess`, `updateAgencyAccess`, `revokeAgencyAccess`) | 2.34+ | NO |
| `generateEmployeeNumber` (raw SQL identifier sequence) | global | NO change |
| `Employee.email` / `Employee.employeeNumber` per-tenant uniqueness | Phase 3 product | NO |

## 2. Phase 2.33 — Read path refactor (this PR)

What lands:
- `EmployeesService` constructor injects `PilotPrismaAccessor`.
- `private get prisma()` returns `pilot.client()` (pilot-aware).
- `private scope()` returns `getPilotScope(this.pilot, 'employees')`.
- `findAll` `where` spread with `scope.tenantWhere()`; the existing
  agency-grant predicate (`where.id = { in: grantedIds }`) is preserved.
- `findOne` migrates `findFirst({ id, deletedAt: null })` → spreads
  `scope.tenantWhere()`. Permission check (`EmployeeAgencyAccess`)
  unchanged.
- `listAgencyAccess` parent-gated by tenant-scoped employee read.
- `getFinancialProfile` / `getDocuments` / `getWorkflow` /
  `getCompliance` / `getCertifications` / `getTraining` /
  `getPerformance` — all already gated by `findOne` which is now
  tenant-scoped. Inner queries by `employeeId` are tenant-safe.
- `exportExcel` by-id branch adds `tenantWhere()`; default branch
  unchanged (delegates to narrowed `findAll`).
- All non-piloted call sites tagged `phase233-excluded-mutation`,
  `phase233-excluded-storage`, or `phase233-global`.

What does NOT land:
- No mutation behaviour change.
- No new feature flag.
- No schema change.
- No `Employee.email` / `Employee.employeeNumber` uniqueness change.
- No external-actor agency-grant filter behaviour change.
- No agency-access mutation change.
- No storage-key / signed-URL change.

## 3. Phase 2.34+ — Mutation refactor (FUTURE)

The mutation pilot will need:
- `findEmployeeOrFail(id)` — pilot-aware tenant pre-check (mirror of
  applicants `findApplicantOrFail`).
- `scope.tenantData()` spread on `Employee.create`.
- Pre-check switches on `update` / `updateStatus` / `remove` (currently
  use `findOne` which already becomes tenant-scoped in Phase 2.33).
- `uploadPhoto` storage-guard (mirror applicants Phase 2.31).
- Agency-access write paths: target-employee parent gate + agency
  resolver gate (mirror applicants `findAgencyOrFail`).

## 4. Phase 3 — Uniqueness migration (FUTURE)

`Employee.email` and `Employee.employeeNumber` stay globally unique
in Phase 2.33. Per-tenant uniqueness needs Phase 3 schema migration.
Phase 2.33 does NOT change this. See
`SAAS_PHASE2_EMPLOYEES_UNIQUENESS_REVIEW.md`.

## 5. Agency-scope behaviour — UNCHANGED

External actors (non-system agency) see only employees granted via
`EmployeeAgencyAccess.canView`. Phase 2.33 keeps this exactly. The
pilot tenant predicate is additive: `tenantId AND id IN (granted)`.

## 6. Guard-rails enforced by this PR

- Source-level meta-assertion in the isolation harness: every
  excluded mutation site sources `legacyPrisma`.
- All `legacyPrisma.*` mutation sites carry
  `phase233-excluded-mutation` (or `…-storage` / `…-global`).
- The fixture seeds two tenants × multiple employees so reads can be
  exercised with cross-tenant collision shapes.

## 7. Phase 2.34 update — mutations + storage + agency gates shipped

| Phase 2.33 status | Phase 2.34 result |
|---|---|
| `create` (excluded) | **shipped** — `phase234-pilot-scope`; spreads `scope.tenantData()` on `Employee.create` |
| `update` / `remove` / `updateStatus` (excluded) | **shipped** — `phase234-pilot-scope-precheck` (gated by Phase 2.33 `findOne`) |
| `uploadPhoto` (excluded-storage) | **shipped** — `phase234-storage-guard`; tenant gate runs BEFORE `storage.uploadFile` |
| `grantAgencyAccess` / `updateAgencyAccess` / `revokeAgencyAccess` (excluded) | **shipped** — `phase234-agency-gate`; NEW `findEmployeeOrFail` + `findAgencyOrFail` gates |
| `generateEmployeeNumber` raw SQL | **unchanged** — `phase233-global` |
| Email duplicate-check | **unchanged** — `phase233-global` |
| `StageTemplate.findMany` catalog | **unchanged** — `phase233-global` |

No remaining employees paths are deferred. Per-tenant uniqueness
(`Employee.email`, `Employee.employeeNumber`) remains a Phase 3
schema migration.
