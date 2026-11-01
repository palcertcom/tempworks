# Phase 2.20 — Documents Scope Split

> What ships in Phase 2.20 vs. what waits for Phase 2.21+.
> A guard-rail document so no one accidentally rewires the
> upload/download/storage paths in this PR.

---

## 1. Scope summary

| Area | Phase | This PR? |
|------|------|----------|
| Read-path tenant scoping (`findAll`, `findOne`, `findByEntity`, `getExpiringDocuments`, `readDocumentBytes` metadata) | **2.20** | **YES** |
| Owner-name enrichment in `findAll` (`employee.findMany`, `applicant.findMany`) | **2.20** | **YES** (narrowed by `tenantId`) |
| Document type catalog reads (`documentType.*`, `documentTypePermission.*`) | 2.20 | yes — annotated `phase220-global` (no `tenantId` column) |
| Audit-log writes inside read flows | 2.20 | yes — annotated `phase220-audit-log` |
| Document upload mutation (`create`) + storage upload | 2.21+ | NO |
| Metadata edit (`update`) | 2.21+ | NO |
| Verification (`verify`) + ComplianceAlert side effect | 2.21+ | NO |
| Renewal (`renew`) — multi-row transaction | 2.21+ | NO |
| Soft delete (`remove`) | 2.21+ | NO |
| Bulk download archive (`createBulkDownloadArchive`) | 2.22+ | NO |
| Single-doc download bytes (`readDocumentBytes` storage fetch) | 2.22+ | NO (metadata narrowed; storage fetch unchanged) |
| Storage key migration | 3.x | NO |
| Per-tenant DocumentType catalog | 3.x | NO |
| Workflow auto-complete side effect (`checkAndAutoCompleteStage`) | 2.21+ (with create) | NO |
| Notification fanout in verify/renew/remove | covered by Phase 2.15 fanout writers when their flags are on | NO new change |

## 2. Phase 2.20 — Read path refactor (THIS PR)

What lands:

- `DocumentsService` constructor injects `PilotPrismaAccessor`.
- `private get prisma()` returns `pilot.client()`.
- `private scope()` returns `getPilotScope(this.pilot, 'documents')`.
- Read sites spread `scope.tenantWhere()` into the `where` clause.
- `findOne` and `readDocumentBytes` migrate from `findUnique` to
  `findFirst` so the tenant predicate composes with id lookup.
- Owner-name enrichment in `findAll` adds the tenant filter to the
  `id-in` lookups so cross-tenant owner names cannot leak.
- All mutation sites (create / update / verify / renew / remove /
  upsertDocTypePermission / checkAndAutoCompleteStage) and all
  storage fetches (`createBulkDownloadArchive`,
  `readDocumentBytes` storage fetch) routed through
  `this.legacyPrisma` with `phase220-excluded-mutation` /
  `phase220-excluded-download` annotations.

What does NOT land:

- No mutation behaviour change.
- No new feature flag.
- No schema change (`Document.tenantId` already added in 2.3).
- No DocumentType / DocumentTypePermission schema change.
- No storage-key migration.
- No download authz change.

## 2.1 Phase 2.21 update — mutation pilot shipped

Phase 2.21 narrowed the mutation surface. See
`SAAS_PHASE2_DOCUMENTS_MUTATION_AUDIT.md`,
`SAAS_PHASE2_DOCUMENTS_MUTATION_SCOPE_DECISION.md`, and
`SAAS_PHASE2_DOCUMENTS_STORAGE_SIDE_EFFECT_REVIEW.md`.

- `create` adds `assertEntityOwnedByActiveTenant` BEFORE storage
  upload; persists `tenantId` via `scope.tenantData()`. Tag
  `phase221-pilot-scope` + `phase221-storage-guard`.
- `publicCreate` adds the same guard (active only when an ALS
  frame is attached) + `tenantData()` spread.
- `update` / `verify` / `remove` rely on the Phase 2.20
  tenant-scoped `findOne` pre-check. Tag
  `phase221-pilot-scope-precheck`.
- `renew` same `findOne` gate + `tenantData()` on the new row.
- `complianceAlert.create` spreads `tenantData()` (column denormed
  in Phase 2.3).
- `checkAndAutoCompleteStage`, `upsertDocTypePermission`,
  `createBulkDownloadArchive`, `auditLog.create` remain
  `phase220-*` (deferred / global / download).

## 2.2 Phase 2.22 update — download/bulk archive pilot shipped

Phase 2.22 closes the documents module pilot. See
`SAAS_PHASE2_DOCUMENTS_DOWNLOAD_AUDIT.md` and
`SAAS_PHASE2_DOCUMENTS_DOWNLOAD_SIDE_EFFECT_REVIEW.md`.

- `readDocumentBytes`: re-tagged `phase222-download-guard`
  (Phase 2.20 metadata gate preserved).
- `createBulkDownloadArchive`: switched to `this.prisma` with
  `...t` spread on the where clause. Cross-tenant ids in the
  input list are silently filtered out by the tenant predicate
  before any storage read. Tag `phase222-download-guard`.
- ACL / signed URLs / storage key format / download authz
  beyond tenantId still deferred (Phase 3 product / storage
  refactor).

Zero `phase220-excluded-download` annotations remain in
`src/documents`.

## 3. Phase 3+ — Storage authz refactor (FUTURE)

The `create` path is the most complex:

- Storage upload runs first, then a `$transaction` inserts the
  Document row + claims a sequence id + writes the audit log.
- Cross-entity tenant validation must happen BEFORE storage upload
  to avoid orphan files.
- Photo uploads side-mutate `applicant.photoUrl`.
- `documentTypePermission` is read for authz inside the flow.

Phase 2.21 should:

1. Validate `dto.entityType + dto.entityId` belongs to the active
   tenant via `findFirst({ where: { id, ...tenantWhere() } })`
   BEFORE the storage upload.
2. Spread `scope.tenantData()` into the `document.create.data`.
3. Ensure photo-upload side effect (`applicant.updateMany`) is
   tenant-scoped.

`update`, `verify`, `remove` follow the Phase 2.17 reads-then-writes
pattern: tenant gate via the read pre-check (Phase 2.20's `findOne`
is tenant-scoped) + by-id mutation on legacyPrisma.

`renew` is a multi-row transaction that needs the same guard plus
cross-row tenant validation on the renewedFromId chain.

`createBulkDownloadArchive` is a download — Phase 2.22.

## 4. Phase 2.22+ — Download refactor (FUTURE)

- `createBulkDownloadArchive(ids[])` accepts a list of document
  ids. Phase 2.22 must filter the list by tenant BEFORE issuing
  any `storage.downloadByUrlOrKey` call so that even a subset of
  cross-tenant ids cannot leak file bytes.
- `readDocumentBytes(id)`: Phase 2.20 already narrows the metadata
  lookup; Phase 2.22 will additionally re-verify tenancy on the
  file URL pattern as defence in depth.
- Signed-URL generation (when added) must include a tenant claim.

## 5. Phase 3 — DocumentType per-tenant (PRODUCT)

Today `DocumentType` and `DocumentTypePermission` are global
catalog. Per-tenant overrides would require:

- a `tenantId String?` on `DocumentType` (NULL = global default).
- a resolver `resolveDocTypeForTenant(name, tenantId)` that prefers
  tenant-specific row over global.
- migration tooling to clone defaults per tenant on demand.

Out of scope for Phase 2. This phase treats catalog as global.

## 6. Guard-rails enforced by this PR

- The isolation harness includes a source-level meta-assertion: every
  mutation method (`create`, `update`, `verify`, `renew`, `remove`,
  `upsertDocTypePermission`, `checkAndAutoCompleteStage`) must
  source `this.legacyPrisma` for its mutation site. Moving any to
  `this.prisma` without surrounding pre-check fails the harness.
- Every `legacyPrisma.*` site in mutation paths carries the
  `phase220-excluded-mutation` / `phase220-excluded-download` /
  `phase220-audit-log` annotation.
- The fixture seeds two tenants × two documents each so the read
  paths can be exercised with cross-tenant collision shapes.

## 7. Operator checklist for Phase 2.21

When Phase 2.21 starts, the operator should:

- [ ] Read this scope-split document.
- [ ] Re-run `saas:phase2-documents-equivalence` and
      `saas:phase2-documents-isolation` against the same staging
      DB to prove the read paths still pass after the mutation
      change.
- [ ] Add a new harness `saas:phase2-documents-mutation-equivalence`
      that asserts cross-tenant `update`/`verify`/`remove` raise
      NotFoundException and that `create` persists `tenantId` and
      tenant-validates the entity reference BEFORE storage upload.
- [ ] Update the `phase220-excluded-mutation` annotations to
      `phase221-pilot-scope` once the mutation paths engage the
      pilot.
