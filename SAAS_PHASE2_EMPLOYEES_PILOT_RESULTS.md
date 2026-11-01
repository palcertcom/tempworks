# Phase 2.33 — Employees Reads-First Pilot Results

> Reads-first employees pilot. Companion to
> `SAAS_PHASE2_EMPLOYEES_AUDIT.md`,
> `SAAS_PHASE2_EMPLOYEES_SCOPE_SPLIT.md`, and
> `SAAS_PHASE2_EMPLOYEES_UNIQUENESS_REVIEW.md`.

---

## 1. What changed

| Surface | Change |
|---|---|
| `src/employees/employees.service.ts` | Constructor injects `PilotPrismaAccessor`; `prisma`→`legacyPrisma` rename; pilot-aware `prisma` getter + `scope()` helper |
| `findAll` | `where.tenantId` spread; agency-grant filter additive |
| `findOne` | `findFirst({ id, deletedAt: null, ...tenantWhere() })` |
| `listAgencyAccess` | parent-gated by tenant-scoped employee read |
| `getFinancialProfile` / `getDocuments` / `getWorkflow` / `getCompliance` / `getCertifications` / `getTraining` / `getPerformance` | parent-gated reads; child queries use pilot client (Document / EmployeeStage / ComplianceAlert / ApplicantFinancialProfile) |
| `exportExcel` | by-id branch spreads `tenantWhere()`; default branch delegates to narrowed `findAll` |
| All mutation / lifecycle / agency-access write / storage / global-uniqueness / sequence sites | rerouted to `legacyPrisma` and tagged `phase233-excluded-mutation` / `phase233-excluded-storage` / `phase233-global` |
| `src/employees/employees.module.ts` | adds `FeatureFlagsModule`, `TenantPrismaService`, `PilotPrismaAccessor` |
| `scripts/scan-annotations.ts` | 5 new tags scoped to `src/employees/` |
| `scripts/saas/phase2/employees-equivalence.ts` | new equivalence harness (12 cases) |
| `scripts/saas/phase2/employees-isolation.ts` | new isolation harness (11 cases incl. source-level meta-assertion) |
| `package.json` | new scripts `saas:phase2-employees-equivalence` / `…-isolation` |

## 2. What did not change

- No mutation / lifecycle / status / agency-access write / storage
  behaviour change.
- No `Employee.email` / `Employee.employeeNumber` uniqueness change.
- No `generateEmployeeNumber` raw SQL change.
- No external-actor agency-grant filter behaviour change.
- No new feature flag.
- No schema change.
- No RLS, no global enforcement.
- No notification side effect change.

## 3. Pilot activation

```
TENANT_PRISMA_PILOT_ENABLED=true
TENANT_PRISMA_PILOT_MODULES=employees
NODE_ENV=staging
TenantContext.attach({ id: ... })
```

## 4. Equivalence harness — 12/12 PASS

Covers: pilot routing flag, legacy union, pilot total reduction,
findOne resolution, NotFound for missing id, status filter, search
filter, agency filter, getDocuments shape, getCompliance shape,
listAgencyAccess parent gate, response shape preserved (`data`+`meta`).

## 5. Isolation harness — 11/11 PASS

Covers: tenant A only on findAll, cross-tenant findOne 404,
cross-agency filter returns 0, search "Bob" doesn't leak B,
getDocuments/getCompliance/listAgencyAccess all blocked at parent
gate, exportExcel by-id [A,B] under A includes only A rows,
concurrent ALS frames isolated, legacy mode union preserved,
source-level meta-assertion of phase233 tags + mutation routing
through legacyPrisma.

## 6. Lessons learned

- **External-actor agency filter is preserved.** The pilot tenant
  predicate is additive: `where.tenantId AND where.id IN (granted)`.
- **`EmployeeAgencyAccess` has no `tenantId` column** — narrowed via
  the parent `Employee` gate (same pattern as `EmployeeStage` in
  workflow Phase 2.27 and `CandidateDeleteRequest` in applicants
  Phase 2.28).
- **`Employee.email` / `Employee.employeeNumber` stay globally
  unique** — same shape as `Applicant.email`, `Vehicle.registrationNumber`.
  Per-tenant uniqueness is a Phase 3 schema change. See
  `SAAS_PHASE2_EMPLOYEES_UNIQUENESS_REVIEW.md`.
- **`uploadPhoto` mirrors applicants Phase 2.31 risk** — storage upload
  precedes any tenant gate; deferred to Phase 2.34 (storage-guard).

## 7. Read/write split warning

The reads-first split deliberately leaves these paths unchanged:
- Employee CRUD (`create`, `update`, `remove`, `updateStatus`)
- `uploadPhoto` (storage path)
- Agency-access mutations (`grant/update/revokeAgencyAccess`)
- `generateEmployeeNumber` (raw SQL global sequence)
- Email duplicate-check inside `create` (global by design)

Phase 2.34+ will land the mutation pilot following the documents
2.21 / vehicles 2.24 / workflow 2.27 / applicants 2.29 pattern.

## 8. Pattern reusability

The pattern now applies to **six end-to-end-or-reads-first modules**:
finance, documents, vehicles, workflow, applicants, employees. The
employees module added one wrinkle (preserved external-actor
agency-grant filter alongside pilot scope) — the existing pattern
composes cleanly, identical to the applicants composition.

## 9. Rollback runbook

```sh
export TENANT_PRISMA_PILOT_MODULES=  # remove 'employees'
# OR
export TENANT_PRISMA_PILOT_ENABLED=false
```

No DB state introduced; rollback is configuration only.

## 10. Real-DB execution evidence

Cumulative cases on real Postgres 16:

| Module | Cases |
|---|---:|
| Finance | 41 |
| Documents | 52 |
| Vehicles | 65 |
| Workflow | 44 |
| Applicants | 74 (incl. mutation, deferred paths, conversion gate) |
| Audit-log tenancy | 8 |
| **Employees (NEW)** | **23** |
| **Total** | **307/307** |

## 11. Next recommended module

Recommended: **employees mutation pilot (Phase 2.34)** —
`findEmployeeOrFail` parent gate, `scope.tenantData()` on
`Employee.create`, `uploadPhoto` storage-guard, agency-access
write paths. This mirrors the applicants Phase 2.29 + 2.31 + 2.32
roadmap.

Alternative: a non-employee module pilot (compliance, attendance,
agencies, pipeline) — pick by risk profile.

## 12. Blockers before employees mutation refactor

- `Employee.email` global uniqueness — Phase 3 product question for
  per-tenant.
- `Employee.employeeNumber` global serial — needs per-tenant sequence
  table or window function.
- `uploadPhoto` runs storage `uploadFile` BEFORE the DB gate — needs
  storage-guard mirror of applicants 2.31.
- Agency-access write paths need a target-employee parent gate +
  agency tenant gate (`findAgencyOrFail` mirror).

## 13. Phase 2.34 — mutation pilot delta

Phase 2.34 extends the employees pilot to mutations. The employees
module now joins finance, documents, vehicles, workflow, and
applicants as the **sixth** end-to-end module proven on real DB
across reads + writes.

New helpers:
- `findEmployeeOrFail(id)` — pilot-aware tenant gate.
- `findAgencyOrFail(id)` — agency tenant gate.

Per-method changes:
- `create` — spreads `scope.tenantData()`. Tag `phase234-pilot-scope`.
- `update`, `remove`, `updateStatus` — rely on the Phase 2.33
  tenant-scoped `findOne` pre-check; retagged
  `phase234-pilot-scope-precheck`.
- `uploadPhoto` — pilot-aware `findFirst({ id, deletedAt:null, ...tenantWhere() })`
  runs BEFORE `storage.uploadFile`. Tag `phase234-storage-guard`.
- `grantAgencyAccess`, `updateAgencyAccess`, `revokeAgencyAccess` —
  NEW dual gates (target employee + target agency) before any
  EmployeeAgencyAccess mutation. Tag `phase234-agency-gate`.

Email duplicate-check, `StageTemplate.findMany`, and
`generateEmployeeNumber` raw SQL stay `phase233-global` (Phase 3
product question for per-tenant uniqueness / per-tenant sequence).

New harnesses (real Postgres SAFE_CLONE):
- `employees-mutation-equivalence` (10 cases): create shape +
  tenantId NULL/set, update / updateStatus / remove parity,
  uploadPhoto storage count, agency-access grant/update/revoke parity.
- `employees-mutation-isolation` (12 cases): cross-tenant rejections
  for update / updateStatus / remove / uploadPhoto / grant / update /
  revoke; agency gate rejects cross-tenant target; uploadPhoto NO
  storage write on cross-tenant; legacy mode unchanged; ALS frame
  isolation; source-level meta-assertion.

Real-DB results: 22/22 mutation cases PASS + 23/23 read cases PASS =
**45/45 employees** total. Cumulative finance + documents + vehicles
+ workflow + applicants + audit-log + employees: **329/329** on
real Postgres 16.

Storage keys, ACLs, signed-URL behaviour, email uniqueness, and
employee-number generation are all unchanged.
