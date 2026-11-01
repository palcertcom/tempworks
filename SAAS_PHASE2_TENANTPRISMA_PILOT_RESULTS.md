# Phase 2.6 — TenantPrisma Pilot Results

> First pilot module: `src/roles`. Goal: prove the access pattern
> end-to-end before applying it to higher-risk modules.

---

## 1. Headline

```
build:                                          ✅
prisma validate:                                ✅
saas:validate (6 suites, 17 reports tests):     ✅
saas:schema-lint:                                ✅
saas:phase2-tenantprisma-pilot-equivalence:     13/13 cases PASS
saas:phase2-tenantprisma-pilot-isolation:        9/9  cases PASS
saas:scan / saas:scan:raw-sql:                  baseline unchanged
production defaults:                            all OFF
```

## 2. What was tested

The pilot covers the full `RolesService` API:

- `findAll(callerRole)` for three caller roles.
- `findOne(id)` for each role.
- `getPermissions()` — full ordering and id list.
- `getPermissionsMatrix()` — role count, grant count.
- Error path: `findOne(missing-id)` raises `NotFoundException` in both
  paths.
- ALS isolation: two concurrent tenant contexts both read the same
  global rows (Role is GLOBAL).
- Pilot accessor refuses to engage outside SAFE_CLONE / SAFE_STAGING.
- Rollback rehearsal: flag flipped off → `tenantPrismaPilotEnabled()`
  returns false.

## 3. Equivalence detail

13 cases compared back-to-back. Same DB, same constructor inputs apart
from the flag value. Outputs identical:

- `findAll` ordering (alphabetical by name) preserved.
- Response shape: arrays returned in both modes.
- `findOne` returns the same role.
- `getPermissions` returns the same length and same first-10 ids.
- `getPermissionsMatrix` returns the same role count and same grant
  count.
- Missing-id triggers `NotFoundException` from both paths.
- Pilot ON reports `pilotActive=true` only inside a safe env.

Full report: `backend/reports/saas/phase2/tenantprisma-pilot-equivalence.{json,md}`.

## 4. Isolation detail

9 cases. Notable:

- `Role` and `Permission` confirmed in `GLOBAL_MODELS`.
  `RolePermission` is `UNKNOWN` in the classifier — accepted because
  the wrapper passes UNKNOWN models through (it never adds a tenant
  filter to a model whose classification is not `TENANT`).
- Two ALS contexts (T1 and T2) both observe identical Role row counts.
- With `TENANT_PRISMA_PILOT_ENABLED=true` AND `NODE_ENV=production`,
  the accessor refuses to engage and falls back to legacy. Logged
  reason: `env=UNSAFE_PRODUCTION is not SAFE_CLONE/SAFE_STAGING`.

Full report: `backend/reports/saas/phase2/tenantprisma-pilot-isolation.{json,md}`.

## 5. Lessons learned

1. **Pass-through is the right contract.** The pilot's main value is
   not "filter Roles by tenant" (Roles is global), but proving that
   the wrapper does NOT filter global models, even with the pilot flag
   on. This is the contract every future module relies on for any of
   its global lookups.
2. **Centralised accessor wins.** Putting the flag check + env classifier
   inside `PilotPrismaAccessor.client()` keeps all call sites unchanged
   (`this.prisma.role.findMany(...)` looks the same in both worlds).
   An earlier sketch sprinkled `flags.tenantPrismaPilotEnabled()` at
   every call site; that was abandoned for review-cost reasons.
3. **Belt-and-braces env classifier matters.** Without the second gate,
   a flag-flip in a misconfigured deploy could route through
   TenantPrisma. With it, the pilot path is impossible to reach in
   production.
4. **Fixture extension is worth automating.** The pilot needed lowercase
   `roles` / `permissions` / `role_permissions` tables (the schema's
   `@@map` rename). Adding `phase26-pilot-extension.sql` made the
   harnesses reproducible without touching the original
   `saas_phase1_fixture/seed.sql` (which other harnesses depend on).
5. **Stub the audit log.** RolesService has cross-module dependencies
   (`AuditLogService`). The harness uses an in-process stub so the
   pilot does not write to `audit_logs`. Future pilots should follow
   the same pattern: keep the rehearsal read-only against shared infra.

## 6. Next module recommendation

Order, easiest → next-easiest:

1. `src/employee-work-history` — small (198-line service, 13 prisma
   calls), tenant-scoped via Phase 2.3 denorm. Will exercise the
   tenant-scoped path of the wrapper for the first time. Needs a
   `tenantId` filter assertion in the equivalence harness.
2. `src/compliance` (read-only views only) — small, tenant-scoped via
   Phase 2.3.
3. `src/vehicles` — larger (51 calls); split into "read paths" first,
   "mutation paths" second.

Avoid for two more phases: `applicants`, `employees`, `reports`,
`finance`, `documents`, `workflow`, `attendance`, `notifications`.

## 7. Blockers before broad rollout

- **TenantPrismaService.client `$extends` implementation.** The current
  shim throws if the registry is non-empty AND the enforcement flag is
  on. Phase 3 must ship the actual extension (model interceptor,
  tenantId injection, transactional `SET LOCAL app.tenant_id`).
- **Per-module equivalence harness convention.** We have one harness
  per pilot today; before broad rollout we want a harness factory so a
  module can declare its API surface and the harness is generated.
- **Audit log isolation.** Every service that uses the audit log will
  hit the same "stub or write" choice. Worth standardising in a
  helper.
- **Test runner integration.** The pilot harnesses are scripts. Phase 3
  should fold the equivalence + isolation harnesses into the unit
  test runner so they run on every PR.

## 8. Production behaviour change status

**Unchanged.** `TENANT_PRISMA_PILOT_ENABLED` defaults to `false`.
`TENANT_PRISMA_ENFORCEMENT` and `RLS_ENFORCEMENT` remain `false`. The
legacy reports engine is untouched. Roles continue to flow through
`PrismaService` directly in production.
