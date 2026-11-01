# Phase 2.25 — Vehicles Storage Path Audit

> Last vehicles-module deferred path. Three vehicle-document
> methods plus two stubs.

---

## 1. Methods in scope

| Method | Lines | Storage call | DB call |
|--------|------:|--------------|---------|
| `addDocument(vehicleId, dto, userId, file?)` | 303-321 | `storage.uploadFile` (after vehicle gate) | `findVehicleOrFail`, `legacyPrisma.vehicleDocument.create` |
| `updateDocument(vehicleId, docId, dto)` | 323-333 | none | `legacyPrisma.vehicleDocument.findFirst({ id, vehicleId })`, `legacyPrisma.vehicleDocument.update` |
| `deleteDocument(vehicleId, docId, userId?)` | 335-344 | none | `legacyPrisma.vehicleDocument.findFirst({ id, vehicleId })`, `legacyPrisma.vehicleDocument.update` (soft) |
| `addMaintenanceAttachment` (stub) | 732-744 | throws | none |
| `deleteMaintenanceAttachment` (stub) | 746-748 | throws | none |
| `getMaintenanceAttachments` (stub) | 750-752 | – | returns `[]` |

`VehicleDocument.tenantId` was denormed in Phase 2.3.

## 2. Pre-2.25 state per method

### 2.1 `addDocument` — partially safe

`findVehicleOrFail(vehicleId)` is tenant-scoped (Phase 2.23). In
pilot mode a cross-tenant `vehicleId` raises 404 BEFORE the
storage upload runs ⇒ no orphan files for cross-tenant attempts.

What's missing: the new `VehicleDocument` row does NOT carry
`tenantId`. Phase 2.25 spreads `scope.tenantData()` into the
create data so the denormed column is populated.

### 2.2 `updateDocument` — UNSAFE today

```ts
const doc = await this.legacyPrisma.vehicleDocument.findFirst({
  where: { id: docId, vehicleId },
});
```

The `vehicleId` predicate ties the lookup to a parent, but if a
tenant-A caller passes a tenant-B `vehicleId` AND a tenant-B
`docId`, the lookup matches and the by-id update mutates the
foreign document. **Real cross-tenant mutation gap.**

Fix: add `findVehicleOrFail(vehicleId)` first. The parent gate
raises 404 in pilot mode for cross-tenant `vehicleId`; the
subsequent doc lookup is then tenant-by-parent.

### 2.3 `deleteDocument` — same UNSAFE pattern

Same fix.

### 2.4 `addMaintenanceAttachment` / `deleteMaintenanceAttachment` — stubs

Both throw `BadRequestException`. No DB or storage calls today.
Phase 2.25 documents them as **DEFERRED_HIGH_RISK** until the
attachments migration ships and a real implementation replaces
the stub. The implementation will need:

- a `findMaintenanceRecordOrFail(recordId)` helper that
  tenant-scopes via `this.prisma.maintenanceRecord.findFirst({ id, ...t })`,
- a storage upload AFTER the gate,
- a `scope.tenantData()` spread on the new attachment row (when
  the schema lands).

## 3. Tenant ownership path

`Vehicle.tenantId` and `VehicleDocument.tenantId` denormed in
Phase 2.3. The pilot scope helper is shared with the rest of
`src/vehicles` (`getPilotScope(this.pilot, 'vehicles')`).

`VehicleDocument` rows existing today may have `tenantId=NULL`
(Phase 2.3 backfill on staging only). The pilot read filter
`{ tenantId: <ALS> }` excludes NULL rows automatically — same
property as the documents and finance pilots.

## 4. Cross-tenant risk matrix (pre-Phase-2.25)

| Method | Pilot OFF | Pilot ON, single id |
|--------|-----------|----------------------|
| `addDocument` | unchanged | NotFoundException for cross-tenant `vehicleId`, **0 storage uploads** ✓ (Phase 2.23 vehicle gate); but new row's `tenantId=NULL` ✗ |
| `updateDocument` | unchanged | **MUTATES foreign vehicle's document** ✗ (the `findFirst` is by id+vehicleId; both can be foreign) |
| `deleteDocument` | unchanged | **SOFT-DELETES foreign vehicle's document** ✗ (same pattern) |

After Phase 2.25 (post-fix):

| Method | Pilot OFF | Pilot ON, single id |
|--------|-----------|----------------------|
| `addDocument` | unchanged | `findVehicleOrFail` raises 404 BEFORE storage; new row carries `tenantId=A` ✓ |
| `updateDocument` | unchanged | `findVehicleOrFail` raises 404 BEFORE doc lookup; safe ✓ |
| `deleteDocument` | unchanged | `findVehicleOrFail` raises 404 BEFORE doc lookup; safe ✓ |

## 5. Storage-write timing

Only `addDocument` issues `storage.uploadFile`. Order remains:

```
1. findVehicleOrFail(vehicleId)    # Phase 2.23 tenant gate
2. (if file) storage.uploadFile    # ← only reached if gate passes
3. legacyPrisma.vehicleDocument.create({ ..., ...tdata })
```

`updateDocument` and `deleteDocument` issue NO storage calls
today — they are pure metadata mutations. The "storage" tag in
2.25 covers them because they are write paths on a
storage-backed entity (`VehicleDocument`).

If a future phase adds `updateDocument` file replacement (delete
old + upload new), the same `findVehicleOrFail` gate already
sits at the top. No further work.

## 6. Rollback behavior

Pure configuration. `TENANT_PRISMA_PILOT_ENABLED=false` ⇒
`tenantWhere()` and `tenantData()` collapse to `{}` ⇒ all three
methods reduce to legacy behavior. No migration. No DB state
introduced.

## 7. Included / Deferred summary

| Path | Disposition |
|------|-------------|
| `addDocument` Prisma `vehicleDocument.create` | **INCLUDED — `phase225-pilot-scope`** (writes tenantId via tenantData) |
| `addDocument` `storage.uploadFile` | **GATED by Phase 2.23 vehicle pre-check** (no annotation needed on storage call itself) |
| `updateDocument` Prisma sites | **INCLUDED — `phase225-pilot-scope-precheck`** after adding `findVehicleOrFail` |
| `deleteDocument` Prisma sites | **INCLUDED — `phase225-pilot-scope-precheck`** after adding `findVehicleOrFail` |
| `addMaintenanceAttachment` (stub) | **DEFERRED_HIGH_RISK** — stub today; activate when migration lands |
| `deleteMaintenanceAttachment` (stub) | **DEFERRED_HIGH_RISK** — same |
| `getMaintenanceAttachments` (stub) | **LEGACY_ONLY** — returns `[]` |
| ACL / signed URLs | **DEFERRED — out of scope per Phase 2.25 strict rules** |
| Storage key format | **DEFERRED — unchanged** |
