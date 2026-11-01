# Phase 2.11 — Recycle Bin Multi-Model Scope Map

> Per-entity tenant-scope decisions for the recycle-bin pilot.
> Authoritative source: `backend/src/recycle-bin/tenant-scope-map.ts`.

---

## 1. Tenant-scoped entities (pilot applies tenant filter)

| Model | DB column | Phase added | Restore safety | Hard-delete safety | Pilot? |
|------|------|------|------|------|------|
| `Applicant` | `tenantId` | 1 | findFirst pre-check rejects cross-tenant id ⇒ 404 | same | ✓ |
| `Employee` | `tenantId` | 1 | same | same | ✓ |
| `Agency` | `tenantId` | 1 | same; agency owns the tenant — special semantics noted in policies | same | ✓ |
| `Document` | `tenantId` | 2.3 | same | same | ✓ |
| `FinancialRecord` | `tenantId` | 2.3 | same; restore-with-related cascades to attachments (no tenantId; parent-checked) | same | ✓ |
| `JobAd` | `tenantId` | 2.9 | same | same | ✓ |
| `Notification` | `tenantId` | 2.3 | same | same | ✓ |
| `Vehicle` | `tenantId` | 2.3 | same; restore-with-related cascades to vehicle docs + maintenance | same | ✓ |
| `VehicleDocument` | `tenantId` | 2.3 | leaf | leaf | ✓ |
| `MaintenanceRecord` | `tenantId` | 2.3 | leaf | leaf | ✓ |

## 2. Global / catalog entities (pilot does NOT filter)

| Model | DB column | Why excluded | Restore safety | Pilot? |
|------|------|------|------|------|
| `User` | none | Platform-global identity | id-by-id only; any caller restores by id | ✗ |
| `Role` | none | Global RBAC catalog | id-by-id; uniqueness on name | ✗ |
| `DocumentType` | none | Global catalog (Phase 2.4 catalog allow-list) | id-by-id; uniqueness on name | ✗ |
| `MaintenanceType` | none | Global maintenance catalog | id-by-id; uniqueness on name | ✗ |
| `Workshop` | none | Shared service-provider table | id-by-id | ✗ |
| `Report` | none | Reports today have no tenantId | id-by-id | ✗ |

These six entity types remain visible across tenants in the recycle
bin in BOTH pilot and legacy mode — the existing role guards
(System Admin / Compliance Officer) are the only access control.

## 3. Excluded operations

- `DatabaseCleanupService.preview()` and `.execute()` — System Admin
  global wipe. Annotated `phase211-excluded-platform`. Not exposed via
  the per-tenant pilot. A future Phase 3 may add a per-tenant
  reset endpoint with explicit tenant ownership; out of scope today.

## 4. Restore / hard-delete safety rules under pilot

Both `RestoreService` and `HardDeleteService` enter every operation
through a single `assertTenantOwnership(entityType, id)` pre-check
(both services share the same shape). The pre-check:

1. Asks `getPilotScope(this.pilot, 'recycle-bin')` whether the pilot
   is active for this module + env + ALS context.
2. Returns immediately if scope inactive OR if `entityType` is in the
   global set above.
3. Otherwise issues `findFirst({ where: { id, tenantId } })` against
   the corresponding model. Missing → `NotFoundException`.

After the pre-check, the per-entity branch runs unchanged on
`legacyPrisma`. Cross-tenant ids cannot reach the mutation step.

## 5. Operator-visible behaviour summary

| Action | Pilot OFF | Pilot ON, tenant A |
|---|---|---|
| List all entity types (no filter) | union of all tenants for tenant-scoped + globals | tenant-A tenant-scoped + globals |
| List by entityType=APPLICANT | union | tenant-A only |
| List by entityType=USER | union | union (global) |
| Counts | totals across tenants | per-tenant for tenant-scoped; global totals for globals |
| Restore tenant B's APPLICANT | succeeds (was a bug) | 404 |
| Hard-delete tenant B's APPLICANT | succeeds (was a bug) | 404 |
| Restore a USER | succeeds | succeeds (global) |
| Database cleanup | System Admin only; cross-tenant; unchanged | identical (Phase 2.11 does not touch this) |

## 6. Adding a new entity type later

To extend the pilot to additional entity types:

1. Confirm the underlying model has `tenantId` populated by an earlier
   backfill phase.
2. Add the entity-type string to `TENANT_SCOPED_ENTITIES` in
   `backend/src/recycle-bin/tenant-scope-map.ts`.
3. Update this scope map document.
4. Re-run `saas:phase2-recycle-bin-equivalence` and
   `saas:phase2-recycle-bin-isolation` to confirm cross-tenant
   restore/hard-delete is still rejected.
5. (Optional) extend `RestoreService.modelOf` and
   `HardDeleteService` map to include the new model name if it
   doesn't follow the camelCase default.
