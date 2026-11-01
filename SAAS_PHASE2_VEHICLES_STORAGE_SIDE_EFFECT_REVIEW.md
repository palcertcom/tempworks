# Phase 2.25 — Vehicles Storage Side-Effect Review

> Vehicle document writes touch the storage tier. The tenant
> check must come first.

---

## 1. Why vehicle-document mutations are storage side effects

`addDocument` calls `storage.uploadFile`. Once bytes are in the
bucket, they are not transactionally bound to the DB row — a DB
failure after upload leaves an orphan file (same as the
documents-2.21 storage guard discussion).

`updateDocument` and `deleteDocument` do not currently touch
storage, but they mutate rows representing storage-backed files.
The Phase 2.25 guard treats them as part of the same boundary so
that a future implementation that DOES touch storage (e.g.
file-replacement on update, real delete from bucket) inherits
the gate without further work.

## 2. Tenant check ordering

```
1. findVehicleOrFail(vehicleId)             # Phase 2.23 tenant gate
2. (addDocument only) storage.uploadFile    # only reached if gate passes
3. legacyPrisma.vehicleDocument.{create|update|update-soft-delete}
   { ...tdata on create }                   # tenantId persisted on insert
```

In legacy mode `findVehicleOrFail`'s tenant predicate is `{}` so
it reduces to the existing by-id lookup — same as today.

In pilot mode cross-tenant `vehicleId` raises 404 BEFORE step 2
or 3.

## 3. Vehicle parent ownership validation

`findVehicleOrFail(vehicleId)` was tenant-scoped in Phase 2.23:

```ts
private async findVehicleOrFail(id: string) {
  const t = this.scope().tenantWhere();
  const v = await this.prisma.vehicle.findFirst({ where: { id, deletedAt: null, ...t } });
  if (!v) throw new NotFoundException('Vehicle not found');
  return v;
}
```

Phase 2.25 reuses this gate for all three vehicle-document
methods. The `addDocument` method already calls it; Phase 2.25
adds it to `updateDocument` and `deleteDocument`.

## 4. Vehicle document ownership validation

After the parent gate passes, the by-id document lookup uses
`{ id: docId, vehicleId }` — both predicates are tied to the
already-validated vehicle. A document id that belongs to a
different vehicle (cross-tenant or otherwise) returns null;
`NotFoundException` is raised before any mutation.

## 5. After DB failure

Unchanged. Storage files are still NOT deleted on DB failure.
Phase 2.25 only REDUCES the surface area for orphans by
narrowing the parent-vehicle gate. Same trade-off as the
documents-2.21 storage guard.

## 6. Orphan file scenarios after Phase 2.25

| Scenario | Pre-2.25 | Post-2.25 |
|----------|----------|-----------|
| Cross-tenant `vehicleId` (pilot ON) | gated by Phase 2.23; **0 uploads** | unchanged ✓ |
| Same-tenant `vehicleId`, DB tx fails | orphan file (existing behaviour) | orphan file (unchanged) |
| Cross-tenant `vehicleId` + cross-tenant `docId` on update | **mutates foreign row** ✗ | **gated; no mutation** ✓ |
| Storage upload itself fails | no DB row (existing) | no DB row (unchanged) |

## 7. ACL / signed URL — UNCHANGED

This phase does NOT:

- introduce signed URLs,
- change object ACL,
- change storage key format (keys still
  `vehicles/${vehicleId}/documents/...`),
- change bucket configuration,
- change download authentication.

## 8. Future signed-URL migration relationship

Same as documents 2.22 storage authz: when signed URLs land,
the metadata gate stays in place; the signed URL would be
issued only for active-tenant document ids.

## 9. Production safety

`TENANT_PRISMA_PILOT_ENABLED=false` (default) ⇒
`scope.tenantWhere()` returns `{}` ⇒ both helpers reduce to
plain by-id lookups ⇒ legacy semantics. No bucket configuration
change. No URL format change. No new flag.

## 10. Storage stub for tests

The harness substitutes `StorageService` with a stub whose
`uploadFile` increments an `uploads` counter. The harness
asserts:

- Cross-tenant `addDocument` triggers **0** storage uploads
  (the `findVehicleOrFail` gate raises before storage).
- Same-tenant `addDocument` triggers **1** storage upload AND
  the new row carries `tenantId=A`.
- Cross-tenant `updateDocument` raises before any DB mutation.
- Cross-tenant `deleteDocument` raises before any DB
  soft-delete.

Same stub shape used by documents 2.21/2.22 and finance 2.17.
