# Phase 2.36 — Agencies Mutation / Storage / Permission / Manager Audit

> Per-call audit of every agencies write site after Phase 2.35
> reads-first refactor.

---

## 1. Per-method audit

### 1.1 `create(dto, createdById?, actorRole?)` — `agencies.service.ts:141`

| Aspect | State |
|---|---|
| Prisma calls | `legacyPrisma.agency.create({ data })`, `legacyPrisma.auditLog.create` |
| Storage calls | none |
| Tenant ownership | `Agency.tenantId` exists today; not yet written by this method |
| Required guard | Spread `scope.tenantData()` on `Agency.create.data` (mirror applicants 2.29 / employees 2.34). If pilot is active but no ALS frame is in scope (System Admin path), `tenantData()` returns `{}` and the row is created NULL-tenant — same as legacy. Documented in scope decision §3. |
| Side effects | audit-log emission |
| Rollback risk | NONE — additive `tenantId` write only when ALS frame present |
| Decision | **INCLUDED_NOW** as `phase236-pilot-scope`; audit retagged `phase236-audit-log-pilot` |

### 1.2 `update(id, dto, updatedById?, actor?)` — L178

| Aspect | State |
|---|---|
| Prisma calls | `findOne(id)` (already tenant-scoped from Phase 2.35), `legacyPrisma.agency.update`, `legacyPrisma.auditLog.create` |
| Storage calls | none |
| Required guard | `findOne` already gates by tenant in pilot mode. The `legacyPrisma.update` then runs by-id over the gated row. |
| Decision | **INCLUDED_WITH_GUARD** as `phase236-pilot-scope-precheck`; audit `phase236-audit-log-pilot` |

### 1.3 `remove(id, deletedById?)` — L247

| Aspect | State |
|---|---|
| Prisma calls | `findOne(id)`, `legacyPrisma.agency.update({ data: { deletedAt } })`, `legacyPrisma.auditLog.create` |
| Required guard | parent-gated by `findOne` |
| Decision | **INCLUDED_WITH_GUARD** as `phase236-pilot-scope-precheck`; audit `phase236-audit-log-pilot` |

### 1.4 `uploadLogo(id, file, actorId?)` — L218

| Aspect | State |
|---|---|
| Prisma calls | `findOne(id)` (tenant-scoped from Phase 2.35!), `legacyPrisma.agency.update({ data: { logoUrl } })`, `legacyPrisma.auditLog.create` |
| Storage calls | `storage.uploadFile(file.buffer, …)` runs **AFTER** `findOne` |
| Required guard | The Phase 2.35 tenant-scoped `findOne` already gates the storage path — cross-tenant id raises 404 BEFORE `storage.uploadFile`. Phase 2.36 retags the existing flow as `phase236-storage-guard` to mark it as audited. |
| Side effects | optional orphan cleanup via `deleteFileByUrlOrKey` (preserved) |
| Rollback risk | NONE |
| Decision | **INCLUDED_WITH_STORAGE_GUARD** — `phase236-storage-guard` (no behaviour change; the existing `findOne` already provides the guard) |

### 1.5 `setPermissionOverride(agencyId, permission, allow, actorId?)` — L355

| Aspect | State |
|---|---|
| Prisma calls | `findOne(agencyId)` (tenant-scoped), `legacyPrisma.agencyPermissionOverride.upsert`, `legacyPrisma.auditLog.create` |
| Required guard | `findOne` already gates; `AgencyPermissionOverride` rides on the gated parent `agencyId` |
| Decision | **INCLUDED_WITH_PERMISSION_GATE** as `phase236-permission-gate`; audit `phase236-audit-log-pilot` |

### 1.6 `removePermissionOverride(agencyId, permission, actorId?)` — L376

Same as 1.5. **INCLUDED_WITH_PERMISSION_GATE**.

### 1.7 `setManager(agencyId, userId, actorId?)` — L394

| Aspect | State |
|---|---|
| Prisma calls | `legacyPrisma.user.findFirst({ id: userId, agencyId })` (no tenant predicate today!), `legacyPrisma.agency.update`, `legacyPrisma.auditLog.create` |
| Required guard | NEW — verify the target user belongs to the active tenant. Currently the user lookup only matches `agencyId == agencyId`, which is correct for "user belongs to this agency" but does NOT prevent a tenant A System Admin from setting a user as manager of a tenant B agency the user already belongs to. Adding a parent gate via `findOne(agencyId)` BEFORE the user lookup fixes the cross-tenant case. |
| Decision | **INCLUDED_WITH_MANAGER_GATE** as `phase236-manager-gate`; audit `phase236-audit-log-pilot` |

## 2. Models touched

| Model | Tenancy column | Notes |
|---|---|---|
| `Agency` | `tenantId String?` | Phase 2.36 writes it on `create` |
| `AgencyPermissionOverride` | none | Rides on parent `agencyId` (gated by `findOne`) |
| `User` | `tenantId String?` | Used in `setManager`; tenant safety enforced via parent-agency gate (the user MUST also belong to the gated agency) |
| `AuditLog` | `tenantId String?` (Phase 2.30) | Audit emissions now route through `TenantAuditLogService` |
| `Agency.parentId` | n/a | Not exercised by any current method; parent/child mutation is **DEFERRED_HIGH_RISK** (Phase 3) |

## 3. System-agency mutation decision

`Agency.isSystem` flips the row into the platform-fixture set
(visible across tenants). Mutation paths in this phase do NOT
treat `isSystem=true` rows specially:

- The `findOne` parent gate uses the Phase 2.35
  `tenantWhereOrSystem()` predicate, which means a tenant A user CAN
  load a system agency. They could in theory then `update` it.
- This pre-existed Phase 2.36 (System Admin already could mutate any
  agency); the strict rule of this phase is "Do not change
  system-agency semantics", so we do not add a new restriction.
- `update` already strips `isSystem` from the DTO unless the actor
  is `System Admin` (preserved exactly).
- System-agency lifecycle mutation is **DEFERRED_SYSTEM_AGENCY_SEMANTICS**
  (covered by Phase 3 product work to deprecate `isSystem`).

## 4. Audit-log routing

Phase 2.30 introduced `TenantAuditLogService`. Phase 2.36 routes the
agencies-service mutation audit emissions through it:

- `create` (`'CREATE'`)
- `update` (`'UPDATE'`)
- `uploadLogo` (`'UPDATE_LOGO'`)
- `remove` (`'DELETE'`)
- `setPermissionOverride` (`'AGENCY_PERMISSION_GRANT'` / `…_REVOKE`)
- `removePermissionOverride` (`'AGENCY_PERMISSION_OVERRIDE_REMOVED'`)
- `setManager` (`'SET_AGENCY_MANAGER'`)

`TenantAuditLogService.write({ ... })` writes `tenantId` only when
`TENANT_AUDIT_LOG_PILOT_ENABLED=true` AND ALS tenant present. Default
production behaviour is unchanged (NULL-tenant audit row, fire-and-
forget, never throws).

## 5. Tenant ownership path (post-2.36, pilot mode)

```
Active ALS tenantId
  → findAgencyOrFail(id) / findOne(id) → Agency row in {active, system} (or 404)
  → Agency.create        → tenantId = active (when ALS present)
  → Agency.update        → only the gated row mutates
  → uploadLogo           → storage.uploadFile runs only after gate succeeds
  → AgencyPermissionOverride.upsert/delete → parent-gated
  → User-as-manager check → parent-gated by findOne(agencyId);
                            existing user.agencyId match still required
  → AuditLog             → TenantAuditLogService writes tenantId when audit pilot is on
```

## 6. Production safety with flags OFF

`scope.active === false` ⇒ `tenantWhereOrSystem()` returns `{}` ⇒
all gates collapse to today's where-clauses. `scope.tenantData()`
returns `{}` ⇒ `Agency.create` writes no `tenantId`. Audit-log
emission falls back to NULL-tenant row. **Byte-identical to pre-2.36.**

## 7. Rollback risk

All changes are gated by `scope.active`. Toggling
`TENANT_PRISMA_PILOT_ENABLED=false` (or removing `agencies` from
`TENANT_PRISMA_PILOT_MODULES`) returns to byte-identical legacy
behaviour. No data, no schema migration.

## 8. Included vs. deferred summary

**Included (Phase 2.36):** `create`, `update`, `remove`,
`uploadLogo`, `setPermissionOverride`, `removePermissionOverride`,
`setManager`. Audit emissions on all of the above route through
`TenantAuditLogService`.

**Deferred:**
- System-agency mutation semantics (`isSystem` flip semantics) —
  Phase 3 product question.
- Parent/child agency restructuring (`Agency.parentId` mutation) —
  Phase 3 schema work.
- `Agency.isDefault` per-tenant primary semantics — Phase 3 product.
