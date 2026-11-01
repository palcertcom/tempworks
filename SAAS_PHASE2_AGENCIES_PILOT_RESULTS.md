# Phase 2.35 — Agencies Reads-First Pilot Results

> Reads-first agencies pilot. Companion to
> `SAAS_PHASE2_AGENCIES_AUDIT.md`,
> `SAAS_PHASE2_AGENCIES_SCOPE_SPLIT.md`,
> `SAAS_PHASE2_AGENCIES_SYSTEM_AGENCY_DECISION.md`.

---

## 1. What changed

| Surface | Change |
|---|---|
| `src/agencies/agencies.service.ts` | Constructor injects `PilotPrismaAccessor`; `prisma`→`legacyPrisma` rename; pilot-aware `prisma` getter + `scope()` + `tenantWhereOrSystem()` helper |
| `findAll` | `where` spread with `AND { OR: [{ tenantId: <active> }, { isSystem: true }] }` |
| `findOne` | `findUnique`→`findFirst` to compose tenant predicate |
| `getUsers` / `getEmployees` / `getStats` / `listPermissionOverrides` | parent-gated by tenant-scoped `findOne`; child queries use pilot client |
| `listPublic` | stays globally visible (apply-form contract); tag `phase235-global` |
| All mutation / permission / storage / manager-set sites | rerouted to `legacyPrisma` and tagged `phase235-excluded-mutation` or `phase235-excluded-storage` |
| `src/agencies/agencies.module.ts` | adds `FeatureFlagsModule`, `TenantPrismaService`, `PilotPrismaAccessor` |
| `scripts/scan-annotations.ts` | 5 new tags scoped to `src/agencies/` |
| `scripts/saas/phase2/agencies-equivalence.ts` | new equivalence harness (12 cases) |
| `scripts/saas/phase2/agencies-isolation.ts` | new isolation harness (11 cases incl. system-agency visibility + source-level meta-assertion) |
| `package.json` | new scripts `saas:phase2-agencies-equivalence` / `…-isolation` |

## 2. What did not change

- No mutation / permission-override / manager-set / storage / `listPublic` behaviour change.
- No system-agency semantics change (visibility decision documented).
- No parent/child agency restructuring.
- No new feature flag.
- No schema change.
- No RLS, no global enforcement.

## 3. Pilot activation

```
TENANT_PRISMA_PILOT_ENABLED=true
TENANT_PRISMA_PILOT_MODULES=agencies
NODE_ENV=staging
TenantContext.attach({ id: ... })
```

## 4. Equivalence harness — 12/12 PASS

Pilot routing flag, legacy union, pilot total reduction, findOne
resolution, NotFound for missing id, search filter narrowed,
getUsers/getEmployees/getStats/listPermissionOverrides parent gates,
listPublic stays global, response shape preserved (`data`+`meta`).

## 5. Isolation harness — 11/11 PASS

Tenant A-only on findAll, cross-tenant findOne 404, search "Agency B"
doesn't leak, child reads (getUsers / getEmployees / getStats /
listPermissionOverrides) all blocked at parent gate, **system agency
visible under both A and B** (decision §6), concurrent ALS frames
isolated, legacy mode union preserved, source-level meta-assertion
of phase235 tags + mutation routing.

## 6. Lessons learned

- **System agencies stay visible across tenants.** Documented as an
  explicit deviation in
  `SAAS_PHASE2_AGENCIES_SYSTEM_AGENCY_DECISION.md`. The pilot
  predicate composes as
  `AND { OR: [{ tenantId: <active> }, { isSystem: true }] }` so a
  caller's `where.OR` (e.g. search filter) does not collide.
- **`listPublic` stays global by design.** It serves the public apply
  form; narrowing it would break submission flows. Tag `phase235-global`.
- **External-actor agency-scope filter preserved exactly.** The pilot
  predicate is additive: `(tenantId OR isSystem) AND id = actor.agencyId`.
- **No uniqueness debt.** `Agency` has no `@unique` columns — Phase 2.35
  does not introduce a Phase 3 product question on agency naming/email.

## 7. Read/write split warning

These paths stay unchanged in Phase 2.35:
- `create`, `update`, `remove`
- `uploadLogo`
- `setPermissionOverride`, `removePermissionOverride`
- `setManager`
- audit-log emissions inside mutation paths

Phase 2.36+ will land the mutation pilot following the
documents 2.21 / vehicles 2.24 / workflow 2.27 / applicants 2.29 /
employees 2.34 pattern.

## 8. Pattern reusability

The pattern now applies to **seven end-to-end-or-reads-first
modules**: finance, documents, vehicles, workflow, applicants,
employees, agencies. The agencies module added one wrinkle (`OR
isSystem: true` for platform-fixture rows) — handled cleanly via a
small `tenantWhereOrSystem()` helper. The existing pattern composes.

## 9. Rollback runbook

```sh
export TENANT_PRISMA_PILOT_MODULES=  # remove 'agencies'
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
| Applicants | 74 |
| Audit-log tenancy | 8 |
| Employees | 45 |
| **Agencies (NEW)** | **23** |
| **Total** | **352/352** |

## 11. Next recommended module

Recommended: **Phase 2.36 — agencies mutation pilot** —
`findAgencyOrFail` parent gate + `Agency.create` `tenantData`
spread + `uploadLogo` storage-guard + permission-override /
manager-set parent gates. Mirrors employees Phase 2.34 roadmap.

Alternative: a non-agency module pilot (compliance, attendance,
pipeline) — pick by risk profile.

## 12. Blockers before agencies mutation refactor

- System-agency mutation semantics — Phase 3 product question.
- `Agency.create` typically runs from a System Admin context that may
  not have an ALS tenant frame — needs explicit handling (similar to
  the applicants `publicSubmit` decision).
- Audit-log emissions for agencies are not yet routed through
  `TenantAuditLogService` — could be wired in Phase 2.36.

## 13. Phase 2.36 — mutation pilot delta

Phase 2.36 extends the agencies pilot to mutations + storage +
permission gates + manager gate + audit-log routing. The agencies
module now joins finance, documents, vehicles, workflow, applicants,
and employees as the **seventh** end-to-end module proven on real DB
across reads + writes.

Per-method changes:
- `create` — spreads `scope.tenantData()` (NULL-tenant fallback when
  no ALS frame). Tag `phase236-pilot-scope`.
- `update` / `remove` — gated by Phase 2.35 tenant-scoped `findOne`;
  retagged `phase236-pilot-scope-precheck`.
- `uploadLogo` — Phase 2.35 `findOne` already runs BEFORE
  `storage.uploadFile`; site retagged `phase236-storage-guard`.
- `setPermissionOverride` / `removePermissionOverride` — gated by
  parent `findOne`; tag `phase236-permission-gate`.
- `setManager` — NEW parent `findOne(agencyId)` gate added BEFORE
  the user-belongs-to-agency check; tag `phase236-manager-gate`.
- All agency audit emissions routed through
  `TenantAuditLogService` (Phase 2.30); tag
  `phase236-audit-log-pilot`.

System-agency mutation semantics, parent/child agency restructuring,
storage keys, ACLs, signed URLs, and `Agency.isDefault` semantics
are all unchanged.

New harnesses (real Postgres SAFE_CLONE):
- `agencies-mutation-equivalence` (10 cases): create shape +
  tenantId NULL/set, update / remove / uploadLogo parity, permission
  override set/remove, setManager, NULL-tenant System Admin fallback.
- `agencies-mutation-isolation` (9 cases): cross-tenant rejections
  for update / remove / uploadLogo (NO storage write) /
  setPermissionOverride / removePermissionOverride / setManager;
  legacy unchanged; concurrent ALS create attribution; source-level
  meta-assertion of phase236 tags + audit routing.

Real-DB results: 19/19 mutation cases PASS + 23/23 read cases PASS =
**42/42 agencies** total. Cumulative finance + documents + vehicles
+ workflow + applicants + audit-log + employees + agencies:
**371/371** on real Postgres 16.
