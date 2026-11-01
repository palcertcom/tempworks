# Phase 2.20 — Documents Module Audit

> Inventory of every Prisma touchpoint in `src/documents` plus the
> read/write split that drives the Phase 2.20 reads-first pilot.

---

## 1. Module surface

| File | Role | Lines |
|------|------|------:|
| `src/documents/documents.service.ts` | business logic, every Prisma site | 757 |
| `src/documents/documents.controller.ts` | HTTP surface (no DB) | 243 |
| `src/documents/document-id.service.ts` | docId generator (`identifierSequence`) | 100 |
| `src/documents/documents.module.ts` | Nest module wiring | 16 |
| `src/documents/dto/*.ts` | request/response shapes | n/a |

Total Prisma sites in `documents.service.ts`: **47**.

## 2. Models touched

| Model | Mode | Count |
|-------|------|------:|
| `Document` | read + write | 14 |
| `DocumentType` | read + write | 5 |
| `DocumentTypePermission` | read + write | 4 |
| `Employee` / `Applicant` / `Agency` / `User` | read (owner-name enrichment) | 8 |
| `EmployeeStage` / `StageTemplate` | read + write (workflow auto-complete) | 6 |
| `ComplianceAlert` | write (verify/renew side effect) | 2 |
| `AuditLog` | write | 6 |
| `IdentifierSequence` (via DocumentIdService) | write | n/a |

## 3. Read paths — INCLUDED in Phase 2.20

| # | Method | Operation | Tenant filter |
|--:|--------|-----------|---------------|
| 1 | `findAll`            | `document.findMany` | `where.tenantId` (pilot) |
| 2 | `findAll`            | `document.count`    | same |
| 3 | `findOne`            | `document.findFirst` (was `findUnique`) | id + tenantId |
| 4 | `readDocumentBytes`  | `document.findFirst` (was `findUnique`) | id + tenantId — but **read-only metadata** (returns bytes via storage; no mutation) |
| 5 | `findByEntity`       | `document.findMany` | `where.tenantId` |
| 6 | `findByEntity`       | `document.count`    | same |
| 7 | `getExpiringDocuments` | `document.findMany` | `where.tenantId` |
| 8 | `findAll` enrichment | `employee.findMany` (id-in) | id-in + tenantId |
| 9 | `findAll` enrichment | `applicant.findMany` (id-in) | id-in + tenantId |

## 4. Catalog/global reads — included as `phase220-global` or `phase220-catalog`

| # | Method | Operation | Decision |
|--:|--------|-----------|----------|
| 10 | `checkDocTypePermission` | `documentTypePermission.findUnique` | **GLOBAL** — DocumentType + permissions are tenant-less catalog (Phase 3 will revisit). Tag `phase220-global`. |
| 11 | `getDocTypePermissions` | `documentTypePermission.findMany` | **GLOBAL** — same. |
| 12 | `getDocTypeByName/findFirst/findMany/findUnique/create` (5 sites) | `documentType.*` | **GLOBAL** — tenant-less catalog. |

`Document.documentType` is a FK to a global catalog row. The catalog
is shared across tenants today; per-tenant catalog overrides are a
Phase 3+ product question, not a Phase 2 isolation concern.

## 5. Write/mutation paths — EXCLUDED from Phase 2.20

| # | Method | Operation | Reason |
|--:|--------|-----------|--------|
| 13 | `create` | `document.$transaction` (insert + sequence + audit) | Upload path: storage upload + transactional insert. Phase 2.21+. |
| 14 | `create` | `documentTypePermission.findUnique` (auth check) | Inside the upload flow. |
| 15 | `create` | side: `applicant.updateMany` for photoUrl on photo upload | Photo-id mutation. |
| 16 | `update` | `document.update` | Metadata edit. |
| 17 | `verify` | `document.update` + `complianceAlert.updateMany` + audit | Compliance side effect. |
| 18 | `renew` | `document.$transaction` (chain: clone + close old + new id) | Multi-row write. |
| 19 | `remove` | `document.update` (soft delete) + audit | Soft delete + audit. |
| 20 | `createBulkDownloadArchive` | `document.findMany` (bytes-fetch list) | Read-only but fetches storage bytes; defer with download. |
| 21 | `upsertDocTypePermission` | `documentTypePermission.upsert` | Catalog mutation. |
| 22 | `checkAndAutoCompleteStage` | workflow stage reads + `applicant.update` + `employeeStage.upsert` + `auditLog.create` | Cross-module workflow side effect. |
| 23 | Owner-name helpers | `employee/applicant/agency/user.findUnique` (lines 69-81) | Inline private helper — defer with write. |
| 24 | All `auditLog.create` | global by design | Tag `phase220-audit-log`. |

## 6. Storage / file-system side effects — EXCLUDED

- `create`: `storage.uploadFile` + `applicant.updateMany` photoUrl
- `verify`: notification fanout
- `renew`: storage upload + reupload
- `remove`: optional storage delete (currently soft-delete only)
- `createBulkDownloadArchive`: `storage.downloadByUrlOrKey` per row
- `readDocumentBytes`: `storage.downloadByUrlOrKey` (READ-only — file proxy; we DO narrow the metadata lookup but the storage byte fetch is unchanged)

The Phase 2.20 narrowing on `readDocumentBytes` only adds a tenant
predicate to the metadata `findFirst`. The storage fetch itself
operates on the URL the metadata returned and is unchanged.

## 7. Notification side effects — EXCLUDED

`verify`, `renew`, `remove` call `notifications.notifyUploaderAndRoles`.
The Phase 2.15 fanout writers handle the tenant fanout when their
flags are on. No change in Phase 2.20.

## 8. Tenant ownership path

`Document.tenantId` was denormed in Phase 2.3 with
`@@index([tenantId])` and `@@index([tenantId, status])`. The
column is nullable; the pilot reads filter by it when active and
ignore it when inactive — preserving legacy behaviour.

## 9. Scope summary

| Class | Methods |
|-------|---------|
| **INCLUDED** | `findAll`, `findOne`, `readDocumentBytes` (metadata only), `findByEntity`, `getExpiringDocuments`, owner-name enrichment in `findAll` |
| **GLOBAL/CATALOG** | `checkDocTypePermission`, `getDocTypePermissions`, internal `documentType.*` lookups |
| **EXCLUDED — Phase 2.21+ writes** | `create`, `update`, `verify`, `renew`, `remove`, `createBulkDownloadArchive`, `upsertDocTypePermission`, `checkAndAutoCompleteStage`, owner-name helpers (private) |
| **EXCLUDED — audit log** | every `auditLog.create` site |

## 10. Risks / out-of-scope concerns

- `readDocumentBytes` returns file bytes. Phase 2.20 narrows the
  metadata lookup; the byte-fetch loops over the URL the metadata
  returns. If the metadata lookup correctly rejects cross-tenant ids
  (it does in pilot mode), the byte fetch can never read a foreign
  file. That property is verified by the isolation harness.
- The bulk-download archive (`createBulkDownloadArchive`) is read-
  shaped (no DB write) but iterates ids — defer with the download
  pilot. It is annotated `phase220-excluded-download` until then.
- The `checkAndAutoCompleteStage` private helper crosses module
  boundaries (`employeeStage`, `stageTemplate`, `applicant`,
  `auditLog`). Out of scope.
- `documentType` and `documentTypePermission` tables have no
  `tenantId` column today. Per-tenant document-type customisation is
  a Phase 3 product change. Treating them as global is the correct
  Phase 2 disposition.
