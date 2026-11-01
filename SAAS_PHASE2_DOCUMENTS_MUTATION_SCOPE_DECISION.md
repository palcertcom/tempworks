# Phase 2.21 — Documents Mutation Scope Decision

> Per-method classification for the Phase 2.21 mutation pilot.

---

## Classification

| Method | Class | Reason |
|--------|-------|--------|
| `create` | **INCLUDED_NOW** | Validate `dto.entityId` belongs to ALS tenant via `findFirst({ id, ...t })` BEFORE storage upload; spread `scope.tenantData()` into `document.create.data`; spread `tenantData()` into `complianceAlert.create.data` (no-op until model gets `tenantId` column). |
| `publicCreate` | **INCLUDED_NOW** | Same pattern; safe in current public flow because no ALS tenant ⇒ pre-check returns legacy result. Defends against future callers attaching an ALS frame. |
| `update` | **INCLUDED_WITH_GUARD** | `findOne(id)` pre-check (Phase 2.20) is tenant-scoped; the by-id update never executes for cross-tenant ids. |
| `verify` | **INCLUDED_WITH_GUARD** | Same `findOne` gate; `complianceAlert.updateMany({ documentId, status: 'OPEN' })` is gated by the parent. |
| `renew` | **INCLUDED_WITH_GUARD + tenantData** | `findOne` gate; spread `tenantData()` into the new renewal row. |
| `remove` | **INCLUDED_WITH_GUARD** | Same `findOne` gate; soft-delete update is by-id. |
| `upsertDocTypePermission` | **LEGACY_ONLY** | Catalog mutation; `DocumentTypePermission` has no `tenantId` (Phase 3 product). |
| `checkAndAutoCompleteStage` | **DEFERRED_HIGH_RISK** | Cross-module workflow side effect; tenant-scoping requires the workflow pilot. Already gated by `verify`'s tenant-scoped `findOne`. |
| `createBulkDownloadArchive` | **DEFERRED_STORAGE_RISK** | Download path; Phase 2.22 will add tenant pre-filter on the id list. |
| `auditLog.create` (helper) | **LEGACY_ONLY** | Global by design; cross-module audit phase. |
| `resolveEntityName` (private helper) | **LEGACY_ONLY** | Called only from `create`/`createBulkDownloadArchive` flows; entity ids in those flows already validated. |

## Rationale — INCLUDED_NOW (`create`, `publicCreate`)

Both upload paths run `storage.uploadFile` BEFORE any DB write.
Phase 2.21 reorders: tenant validation FIRST, storage upload SECOND.

```ts
// Inside create():
const t = this.scope().tenantWhere();
const ownerOk = await this.entityOwnedByTenant(dto.entityType, dto.entityId, t);
if (!ownerOk) throw new NotFoundException(`Entity ${dto.entityId} not found`);

// Only now is storage touched:
const upload = await this.storage.uploadFile(...);

// And the DB row carries tenantId:
const tdata = this.scope().tenantData();
const doc = await this.legacyPrisma.$transaction(async (tx) => {
  return tx.document.create({ data: { ..., ...tdata } });
});
```

In legacy mode (`tenantWhere()` returns `{}`), the lookup matches
by id alone — same behaviour as today. In pilot mode, cross-tenant
`entityId` raises `NotFoundException` BEFORE storage is touched ⇒
no orphan file.

## Rationale — INCLUDED_WITH_GUARD

`update` / `verify` / `renew` / `remove` already call `findOne(id)`
which is tenant-scoped after Phase 2.20. The by-id `update` /
`soft-delete` / `$transaction` therefore cannot reach a foreign
tenant's row in pilot mode. Phase 2.21 re-tags the by-id mutation
sites as `phase221-pilot-scope-precheck`.

`renew` additionally spreads `tenantData()` into the new renewal
row's `data` so the renewal carries the active tenant's id.

## Rationale — DEFERRED

`checkAndAutoCompleteStage` crosses into a different module that
has not yet been piloted. Its only entry point is `verify` whose
`findOne` is tenant-scoped, so the entity it operates on is
guaranteed to belong to the active tenant. Tightening it requires
the workflow module pilot, which is out of scope for documents.

`createBulkDownloadArchive` is the download path; Phase 2.22.

## Out-of-scope safeguards

- No storage key format change.
- No ACL change.
- No signed URL change.
- No download authz change.
- No new feature flag.
- No schema change.
- No DTO change.
- No catalog (DocumentType / DocumentTypePermission) tenancy.
