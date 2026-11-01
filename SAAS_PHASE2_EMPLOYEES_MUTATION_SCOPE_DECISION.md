# Phase 2.34 — Employees Mutation Scope Decision

> Classification of every employees write path.

---

| Path | Classification | Rationale |
|---|---|---|
| `create` | **INCLUDED_NOW** | Spread `scope.tenantData()` on `Employee.create.data`. Email duplicate-check stays global (`Employee.email @unique`). Sequence stays global. |
| `update` | **INCLUDED_WITH_GUARD** | Already gated by Phase 2.33 tenant-scoped `findOne(id, actor, {require:'edit'})`. By-id `legacyPrisma.update` runs over the gated row; tag `phase234-pilot-scope-precheck`. |
| `remove` | **INCLUDED_WITH_GUARD** | Same gate as `update`. Soft-delete only. |
| `updateStatus` | **INCLUDED_WITH_GUARD** | Same gate as `update`. |
| `uploadPhoto` | **INCLUDED_WITH_STORAGE_GUARD** | Replace `findUnique({id})` with `findFirst({id, deletedAt:null, ...tenantWhere()})` BEFORE `storage.uploadFile`. Storage write is conditional on the gate. Mirrors applicants 2.31. |
| `grantAgencyAccess` | **INCLUDED_WITH_AGENCY_GATE** | NEW `findEmployeeOrFail(employeeId)` + NEW `findAgencyOrFail(agencyId)` BEFORE the `upsert`. Cross-tenant employee or agency raises 404. |
| `updateAgencyAccess` | **INCLUDED_WITH_AGENCY_GATE** | Same dual gates BEFORE the `findUnique({employeeId_agencyId})`. |
| `revokeAgencyAccess` | **INCLUDED_WITH_AGENCY_GATE** | Same dual gates BEFORE the `delete({employeeId_agencyId})`. |
| `generateEmployeeNumber` | **LEGACY_ONLY** | Global serial over global `Employee.employeeNumber @unique`. Per-tenant sequence is Phase 3 work. Tag stays `phase233-global`. |
| Email duplicate-check inside `create` | **LEGACY_ONLY** | `Employee.email @unique` is global today. Tag stays `phase233-global`. |
| `StageTemplate.findMany` inside `create` | **LEGACY_ONLY** | Global catalog (Phase 2.26). Tag stays `phase233-global`. |
| Audit-log emission | **DEFERRED_HIGH_RISK** | Employees service does not emit audit rows today. Adding emission is product-side work, not a tenancy fix. The shared `TenantAuditLogService` is wired for any future emission. |
| Per-tenant uniqueness | **DEFERRED_HIGH_RISK** | Phase 3 schema migration. Out of scope. |

## Justifications for deferred

- **Audit-log emission**: introducing audit rows changes observable
  product behaviour. The Phase 2.34 brief explicitly forbids
  redesigning conversion / mutation flows. Adding new audit rows is
  scoped to a dedicated phase.
- **Per-tenant uniqueness**: requires schema migration + per-tenant
  sequence + production data backfill. Strict rule of Phase 2.34
  ("Do not change Employee.email or Employee.employeeNumber
  uniqueness").

## Production safety

Every classification above keeps the production legacy code path
byte-identical with the flag off, with one documented difference:
`uploadPhoto` adds `deletedAt: null` to the lookup. This aligns
`uploadPhoto` with every other write site in the service that
already requires `deletedAt: null`, and is a defensible legacy
behaviour change.
