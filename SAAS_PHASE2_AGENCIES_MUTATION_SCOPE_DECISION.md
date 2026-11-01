# Phase 2.36 — Agencies Mutation Scope Decision

> Classification of every agencies write path.

---

| Path | Classification | Rationale |
|---|---|---|
| `create` | **INCLUDED_NOW** | Spread `scope.tenantData()` on `Agency.create.data`. NULL-tenant fallback when ALS frame is absent (System Admin path) — same as legacy. |
| `update` | **INCLUDED_WITH_GUARD** | Already gated by Phase 2.35 tenant-scoped `findOne(id)`. By-id `legacyPrisma.update` runs over the gated row; tag `phase236-pilot-scope-precheck`. |
| `remove` | **INCLUDED_WITH_GUARD** | Same gate as `update`. Soft-delete only. |
| `uploadLogo` | **INCLUDED_WITH_STORAGE_GUARD** | Phase 2.35 already runs `findOne(id)` BEFORE `storage.uploadFile`; Phase 2.36 retags the storage-write site `phase236-storage-guard` to mark it as audited. |
| `setPermissionOverride` | **INCLUDED_WITH_PERMISSION_GATE** | `findOne` parent gate already in place. The override row rides on the gated `agencyId`. |
| `removePermissionOverride` | **INCLUDED_WITH_PERMISSION_GATE** | Same. |
| `setManager` | **INCLUDED_WITH_MANAGER_GATE** | NEW `findOne(agencyId)` parent gate added BEFORE the existing user lookup. The user-belongs-to-agency check (`agencyId == agencyId`) is preserved. Cross-tenant agencyId raises 404 before any update. |
| Audit emissions inside the above | **INCLUDED_NOW** (audit routing) | Routed through `TenantAuditLogService` (Phase 2.30). Writes `tenantId` only when audit pilot flag is on. |
| `Agency.create` from a System Admin context with no ALS frame | **LEGACY_ONLY** (NULL-tenant fallback) | Without an ALS frame, `scope.tenantData()` returns `{}` and the row is created NULL-tenant. Same as legacy. Documented; not a regression. |
| `isSystem` mutation semantics | **DEFERRED_SYSTEM_AGENCY_SEMANTICS** | Phase 3 product question. Phase 2.36 strict rule: do not change system-agency semantics. |
| `Agency.parentId` mutation | **DEFERRED_HIGH_RISK** | No method exposes parent-agency mutation today. Phase 3 schema work. |
| `Agency.isDefault` per-tenant primary semantics | **DEFERRED_HIGH_RISK** | Phase 3 product. |

## Justifications for deferred

- **System-agency semantics**: changing how `isSystem=true` rows
  behave is a product decision (move to `PlatformAdmin`?) tracked in
  the Phase 2.35 system-agency decision doc.
- **Parent/child agency**: no current code path mutates `parentId`,
  so there is nothing to gate this phase. Schema work is reserved for
  Phase 3.
- **`isDefault`**: same — no current mutation surface.

## Production safety

Every classification keeps the production legacy code path
byte-identical with the flag off. `Agency.create` adds an additive
`tenantId` write only when both `TENANT_PRISMA_PILOT_ENABLED=true`
AND an ALS frame is in scope. Audit emission shape is unchanged when
`TENANT_AUDIT_LOG_PILOT_ENABLED=false`.
