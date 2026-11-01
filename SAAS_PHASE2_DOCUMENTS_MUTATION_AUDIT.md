# Phase 2.21 — Documents Mutation Audit

> Every documents mutation method, mapped to Prisma writes, storage
> calls, ownership path, side effects, and Phase 2.21 disposition.

---

## 1. Method-by-method inventory

### 1.1 `create(dto, file, uploadedById)`

- Prisma: `documentType.findUnique`, `legacyPrisma.$transaction`
  (sequence + `document.create`), `legacyPrisma.auditLog.create`,
  optional `legacyPrisma.complianceAlert.create`.
- Storage: `storage.uploadFile` runs **BEFORE** the DB transaction.
- Models: `Document`, `AuditLog`, `ComplianceAlert`, `IdentifierSequence`.
- Action: CREATE (file + row).
- Tenant ownership path: caller-supplied `dto.entityId`. The entity
  (Employee / Applicant / Agency) carries `tenantId`. Today the new
  `Document.tenantId` is left NULL.
- Required `tenantId`: write `tenantId = ALS.tenantId` via
  `scope.tenantData()`.
- Cross-tenant risk: HIGH today. A tenant-A caller could pass a
  tenant-B `entityId`; the file would be uploaded to storage AND
  the row inserted with `tenantId=NULL` → orphan file + visible to
  tenant A's own pilot reads (via `tenantId` denorm).
- Storage risk: orphan file persists if DB tx fails or if
  cross-tenant validation fails AFTER upload.
- Side effects: ComplianceAlert (expiring docs), notification fanout.
- Rollback: storage file is NOT deleted on DB failure today.
- Phase 2.21: **INCLUDED_NOW** — entity tenant-validation BEFORE
  storage upload + `tenantData()` spread on `document.create.data`
  + `tenantData()` spread on `complianceAlert.create.data`.

### 1.2 `publicCreate(file, entityId, name, documentTypeName, sectionKey)`

- Prisma: `documentType.findFirst` (multiple), optional
  `documentType.create`, `user.findFirst` ×2,
  `legacyPrisma.$transaction` (sequence + `document.create`).
- Storage: `storage.uploadFile` BEFORE DB.
- Action: CREATE (file + row) — public form (`/apply`); APPLICANT
  entity only.
- Tenant ownership path: caller-supplied `entityId`. Public form
  typically runs WITHOUT an ALS tenant frame; pilot scope therefore
  collapses to `{}` and behaviour is unchanged.
- Photo-only short-circuit: writes `applicant.photoUrl` via
  `legacyPrisma.applicant.updateMany` — no Document row.
- Required `tenantId`: when an ALS tenant is present (rare in
  public flow), spread `tenantData()`. When absent, behave as
  legacy.
- Cross-tenant risk: LOW for public flow (no ALS frame); same risk
  shape as `create` if a future caller attaches one.
- Phase 2.21: **INCLUDED_NOW** for the `tenantData()` spread
  pattern (with `applicant` lookup tenant-narrowed when scope
  active); behaviour unchanged in current public flow.

### 1.3 `update(id, updateData, updatedById)`

- Prisma: `findOne(id)` (tenant-scoped Phase 2.20),
  `legacyPrisma.document.update({ where: { id } })`,
  `legacyPrisma.auditLog.create`.
- Action: UPDATE metadata.
- Tenant gate: `findOne` raises 404 in pilot mode for cross-tenant
  ids ⇒ by-id update never executes.
- Phase 2.21: **INCLUDED_WITH_GUARD** — annotate by-id update site
  as `phase221-pilot-scope-precheck`.

### 1.4 `verify(id, dto, verifiedById)`

- Prisma: `findOne(id)`, `legacyPrisma.document.update`,
  `legacyPrisma.complianceAlert.updateMany` (resolve open alerts),
  `legacyPrisma.auditLog.create`. Side effect:
  `checkAndAutoCompleteStage` (cross-module).
- Action: UPDATE status + RESOLVE alerts.
- Tenant gate: `findOne` is tenant-scoped (Phase 2.20).
  `complianceAlert.updateMany({ documentId, status: 'OPEN' })` is
  by-document — same parent gate.
- Phase 2.21: **INCLUDED_WITH_GUARD** for the document update +
  alert resolve. `checkAndAutoCompleteStage` stays
  `phase220-excluded-mutation` (cross-module workflow).

### 1.5 `renew(originalId, dto, file, renewedById)`

- Prisma: `findOne(originalId)`,
  `legacyPrisma.$transaction(sequence + document.create)`,
  `legacyPrisma.auditLog.create`.
- Storage: `storage.uploadFile` AFTER `findOne` (good — already
  gated by tenant pre-check).
- Action: CREATE renewal row (preserves history).
- Tenant gate: `findOne(originalId)` raises 404 for cross-tenant
  ids in pilot mode → storage upload AND DB write skipped.
- Required `tenantId`: spread `scope.tenantData()` into the new
  document's `data`.
- Phase 2.21: **INCLUDED_WITH_GUARD** + write `tenantId` on the new
  renewal row.

### 1.6 `remove(id, deletedById)`

- Prisma: `findOne(id)`, `legacyPrisma.document.update` (soft
  delete), `legacyPrisma.auditLog.create`.
- Tenant gate: `findOne(id)` is tenant-scoped.
- Phase 2.21: **INCLUDED_WITH_GUARD**.

### 1.7 `upsertDocTypePermission(...)`

- Prisma: `legacyPrisma.documentTypePermission.upsert`.
- Catalog mutation. No `tenantId` column on the model.
- Phase 2.21: **LEGACY_ONLY** — global catalog (Phase 3 product
  decision). Stays `phase220-excluded-mutation`.

### 1.8 `checkAndAutoCompleteStage(entityType, entityId, actorId)` (private)

- Prisma: `employeeStage.findFirst`, `applicant.findUnique`,
  `stageTemplate.findUnique`, `legacyPrisma.document.findMany`,
  `stageTemplate.findFirst`, `employeeStage.updateMany`,
  `employeeStage.upsert`, `applicant.update`, `auditLog.create`.
- Cross-module workflow side effect.
- Phase 2.21: **DEFERRED_HIGH_RISK** — needs the workflow module
  pilot first. Stays `phase220-excluded-mutation`.

### 1.9 `createBulkDownloadArchive(ids[])`

- Prisma: `legacyPrisma.document.findMany({ id: { in } })`.
- Storage: per-row `fetchDocumentBuffer`.
- Phase 2.21: **DEFERRED_STORAGE_RISK** — download narrowing is
  Phase 2.22. Stays `phase220-excluded-download`.

## 2. Storage side effects

The two upload paths (`create`, `publicCreate`) run
`storage.uploadFile` BEFORE any tenant validation. Phase 2.21
inverts this for `create` (authenticated; ALS frame present): the
entity tenant check runs FIRST, and the upload is skipped if the
check fails.

`publicCreate` keeps storage-first today because the public form
typically runs without an ALS tenant; the pilot scope is inactive
and the pre-check returns the legacy result. Phase 2.21 still
adds the tenant-narrowed entity lookup so a future caller that
DOES attach an ALS frame is covered.

`renew` already runs `findOne(originalId)` BEFORE storage; safe.

## 3. Workflow side effect — DEFERRED

`checkAndAutoCompleteStage` is invoked from `verify` on success.
It crosses into the workflow module (`employeeStage`,
`stageTemplate`, `applicant`). Tenant scoping it requires the
workflow pilot. For Phase 2.21 it stays on `legacyPrisma`. The
risk: a verify on tenant A's document could trigger
`employeeStage.upsert` on a tenant-B employee if (and only if) a
cross-tenant entityId already exists in the verified document
row. Since `verify`'s `findOne` is tenant-scoped, this cannot
happen in pilot mode — a cross-tenant document id raises 404
before the workflow side effect.

## 4. Compliance alert side effect

`create` writes a `ComplianceAlert` row when the new document is
expiring. The model has no `tenantId` column today — same shape
as audit log. Phase 2.21 spread of `tenantData()` is a no-op
because the column doesn't exist yet. Phase 2.22+ schema work
will denorm `ComplianceAlert.tenantId` and let the spread
populate it.

`verify` resolves open alerts via `updateMany({ documentId,
status: 'OPEN' })` — by-document; the parent `findOne` already
tenant-gated.

## 5. Notification side effect

`create` and `verify` (and the expiry sub-path) call
`notifications.notifyUploaderAndRoles`. Phase 2.15 fanout writers
handle the ALS-tenant fanout when their flags are on. No change
needed in Phase 2.21.

## 6. Rollback risk summary

| Method | Rollback | Notes |
|--------|----------|-------|
| `create` | TENANT_PRISMA_PILOT_ENABLED=false | new tenant pre-check disengages; legacy storage-first behaviour returns. |
| `publicCreate` | same | pre-check disengages; public flow unchanged. |
| `update` / `verify` / `renew` / `remove` | same | findOne pre-check disengages; legacy by-id mutation behaviour returns. |

No DB state introduced. No migration. Pure configuration rollback.

## 7. Production safety

With `TENANT_PRISMA_PILOT_ENABLED=false`:

- `tenantData()` spread returns `{}` ⇒ no `tenantId` column written.
- Entity pre-check `findFirst({ id, ...t })` reduces to legacy
  `findFirst({ id })` semantics.
- Storage call timing is unchanged.
- Audit log writes unchanged.
- Notification fanout unchanged.

Production behaviour byte-identical to pre-2.21.
