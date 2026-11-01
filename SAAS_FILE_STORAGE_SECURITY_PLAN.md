# SaaS File Storage Security Plan

**Today's storage:** `backend/src/common/storage/storage.service.ts` — DigitalOcean Spaces (S3-compatible) with a local-FS fallback (`backend/uploads`). Default upload `ACL: 'public-read'`.

**Reference doc:** `backend/UPLOAD_SPACES_MIGRATION.md` (existing).

This is the **single highest leakage surface** alongside the reports engine. Every prior security control is undermined if a sensitive document URL is publicly resolvable.

---

## 1. Current State (as observed)

| # | Observation | File / line | Severity |
|---|---|---|---|
| S1 | `uploadFile()` sets `ACL: 'public-read'` | `storage.service.ts` | **CRITICAL** — passport scans, contracts, ID copies are reachable by URL guess if the key is leaked. |
| S2 | Document keys partly tenant-blind: `documents/<entityType>/<entityId>/<docType>/<uuid>.<ext>` | `storage.service.ts` upload paths | HIGH — no `tenants/<tenantId>/` prefix at the bucket level. |
| S3 | `agencies/{id}/logos/`, `users/{id}/avatars/`, `employees/{id}/photos/` similarly tenant-blind | upload paths | HIGH |
| S4 | Public unauthenticated upload `POST /documents/public/upload` | `documents.controller.ts` (~line 115) | HIGH — no CAPTCHA, weak rate limit, must bind to host's tenant. |
| S5 | `/uploads` static route still served from local FS for legacy rows | `main.ts` / module config | MEDIUM — must be retired post-migration. |
| S6 | `resolveAssetUrl()` on the frontend builds direct Spaces URLs | `src/app/services/api.ts` | HIGH — coupling FE to public-readable scheme. |
| S7 | `getPublicUrl(key)` builds CDN URLs without expiry | `storage.service.ts` | HIGH — promotes long-lived public URLs. |
| S8 | No SSE/KMS encryption set on `PutObject` | `storage.service.ts` | MEDIUM — Spaces does at-rest by default, but customer-managed keys are missing. |
| S9 | No virus scan on uploads | `storage.service.ts` | MEDIUM — sensitive in compliance flows. |
| S10 | Bulk download zips use response stream concatenation | `documents.service.ts` `bulkDownload` | LOW — but tenancy must be re-validated per included file. |

---

## 2. Target Storage Layout

**Single bucket** (per region), strict private ACL, tenant-prefixed keys. Logical separation by tenant + resource type.

```
s3://tw-prod-eu-files/
  tenants/
    <tenantId>/
      agencies/<agencyId>/logos/<sha256>.<ext>
      users/<userId>/avatars/<sha256>.<ext>
      employees/<employeeId>/photos/<sha256>.<ext>
      employees/<employeeId>/work-history/<entryId>/<docId>.<ext>
      applicants/<applicantId>/photos/<sha256>.<ext>
      documents/<entityType>/<entityId>/<docTypeKey>/<docId>.<ext>
      finance/<entityType>/<entityId>/<recordId>/<attachmentId>.<ext>
      vehicles/<vehicleId>/documents/<docId>.<ext>
      job-ads/<jobAdId>/<assetId>.<ext>
      exports/<jobId>.zip       (per-tenant data export)
  platform/
    backups/<backupId>.dump     (platform-admin only)
    audits/<...>
```

Notes:
- Filenames are content-addressed (`sha256`) to avoid filename leakage and to deduplicate.
- Original filename is stored in `Document.fileName`, not in the object key.
- Object key is **derivable** from DB row id, but never returned to clients; clients always receive a signed URL.

---

## 3. Access Control Model

### 3.1 All objects private

- Upload: `ACL` removed; bucket policy denies public read by default.
- Download: API-mediated only.

### 3.2 Signed URLs

- Endpoint: `GET /api/v1/files/sign?d=<documentId>` (not the raw key).
- Server validates:
  1. `TenantContext.current().id` matches `document.tenantId`.
  2. `UserContext.current()` has `documents:read` permission (and agency scope if applicable).
  3. The document is not soft-deleted unless caller has `recycle-bin:read`.
- Server issues a **5-minute** S3 v4 presigned URL.
- Audit row written: `audit_logs(action='document.read', target=docId)`.

### 3.3 Upload flow

Two patterns:

**Direct upload via API (default for sensitive docs):**
```
client → POST /api/v1/documents (multipart) → API streams to Spaces with private ACL → returns docId
```

**Presigned PUT (large files, optional):**
```
client → POST /api/v1/documents/presign { entityType, entityId, sizeBytes, contentType }
       ← { uploadUrl, key, headers }
client → PUT uploadUrl
client → POST /api/v1/documents/finalize { key, ... }   // server verifies object exists, size, hash
```

The server enforces:
- Tenant prefix in the issued key (clients cannot pick a key).
- MIME allow-list (per resource type — see §5).
- Size limit (per plan tier; default 25 MB for documents, 5 MB for avatars).

### 3.4 Public unauthenticated upload

Replace `/documents/public/upload` with `/jobs/:slug/apply/upload`:

- Tenant resolved by host (must succeed).
- CAPTCHA token required (Turnstile / hCaptcha).
- Per-IP rate limit `5/min`, per-tenant burst limit.
- Object key: `tenants/<tenantId>/applications/<draftId>/<fileId>.<ext>`.
- Linked to an `ApplicationDraft` row scoped to the tenant.
- TTL: drafts expire in 7 days; orphaned objects swept by a daily job.

---

## 4. Migration of Existing Files

**Step 1 — Inventory.** For every `Document`, `User.photoUrl`, `Employee.photoUrl`, `Applicant.photoUrl`, `Vehicle*` files, and `FinancialRecord` attachments:

```
SELECT id, tenantId(via parent), storageUrl|storageKey FROM <table>;
```

Result: `existing_objects(table_name, row_id, tenant_id, current_key, target_key, mime, sha256)`.

**Step 2 — Copy with tenant prefix.** Background job iterates `existing_objects`:

```
COPY current_key → target_key   (server-side copy; preserves bytes)
HEAD target_key                 (verify size + ETag)
UPDATE row.storageKey = target_key, row.storageUrl = NULL
```

Use Spaces server-side copy (`x-amz-copy-source`); no re-upload.

**Step 3 — Flip ACL.** When all rows for a tenant are migrated:

```
PUT-OBJECT-ACL target_key → private
```

(Prefer batch: change bucket policy + remove `public-read` after all keys are migrated.)

**Step 4 — Frontend cutover.** When `resolveAssetUrl()` → `getSignedAssetUrl()` is shipped, retire the legacy code path.

**Step 5 — Retire `/uploads` static route.** After all local-FS rows have been moved to Spaces (existing `UPLOAD_SPACES_MIGRATION.md` describes this).

**Step 6 — Verify.** Sample 100 random objects per tenant; assert `ACL = private`, key starts with `tenants/<tenantId>/`, and only signed URLs work.

---

## 5. MIME / Size Policies (per resource)

| Resource | Allowed MIME | Max size | Notes |
|---|---|---|---|
| Avatar (user/employee/applicant) | image/png, image/jpeg, image/webp | 5 MB | Re-encode server-side; strip EXIF |
| Logo (tenant/agency) | image/png, image/jpeg, image/webp, image/svg+xml *(scrubbed)* | 2 MB | SVG sanitized via `dompurify`/`svg-sanitizer`; reject script tags |
| Document (compliance) | application/pdf, image/png, image/jpeg, application/msword, application/vnd.openxmlformats-officedocument.* | 25 MB | AV scan recommended |
| Vehicle docs | application/pdf, image/* | 25 MB | |
| Finance attachments | application/pdf, image/* | 25 MB | |
| Public application uploads | application/pdf, image/* | 10 MB | CAPTCHA required |

Server validates MIME by sniffing magic bytes, not by trusting `Content-Type`.

---

## 6. Encryption

- **At rest:** Bucket-level SSE-KMS (DigitalOcean offers SSE; for stricter customer-managed keys plan migration to AWS S3 with SSE-C/SSE-KMS in a later phase).
- **In transit:** TLS 1.3.
- **Per-tenant DEK (Phase 4):** sensitive columns (national ID, bank account) encrypted with envelope encryption using a tenant-specific DEK; cryptographic erasure on tenant offboarding.

---

## 7. Anti-virus / Malware

- Asynchronous scan via ClamAV worker on every uploaded object.
- Scanner result: `documents.scanStatus = PENDING | CLEAN | INFECTED`.
- `INFECTED` ⇒ object moved to `tenants/<tenantId>/quarantine/`, not signable, audit row written.
- Phase 3 add-on; not blocking SaaS launch.

---

## 8. Audit & Forensics

Every signed-URL issuance and every upload is logged in `audit_logs`:

```
{ action: 'document.signed_url.issued', target: docId, meta: { ttl: 300, ip, ua } }
{ action: 'document.uploaded',          target: docId, meta: { sha256, size } }
{ action: 'document.deleted',           target: docId, meta: { hardDelete: false } }
```

Platform-admin signed-URL issuance writes an additional `platform_audit_log` row.

---

## 9. Frontend Implications (cross-ref to Frontend Plan)

- `resolveAssetUrl()` → `getSignedAssetUrl(documentId)` (TTL-aware caching).
- `<img src="/uploads/...">` direct references must be hunted down and replaced.
- For pre-rendered emails / PDFs that include images, prefer **embedding** (data URI or attachment) rather than long-lived links.

---

## 10. Anti-Patterns to Forbid

- ❌ Hard-coding storage keys client-side.
- ❌ Returning raw S3 URLs in API responses (always the document id; the client signs).
- ❌ `ACL: 'public-read'` anywhere (CI grep).
- ❌ Filenames in object keys.
- ❌ Generating presigned URLs without checking tenancy.
- ❌ Long TTL signed URLs (> 15 min).
- ❌ Storing original uploaded filename without sanitization (path traversal, control chars).
- ❌ Allowing the client to choose the object key.
- ❌ Reusing one bucket across regions when data residency is promised.

---

## 11. Test Plan

- **Isolation tests**: a Tenant-A user cannot retrieve a Tenant-B document id (404 not 403; do not leak existence).
- **Signed URL TTL**: URLs older than 5 min return 403.
- **MIME spoof**: upload `.exe` renamed `.pdf` → reject after magic-byte sniff.
- **SVG XSS**: upload SVG with `<script>` → sanitized; rendering does not execute.
- **Public apply rate-limit**: hammering exceeds quota → 429.
- **Migration verification**: post-migration, every `Document.tenantId == derive_from_key(storageKey)`.
- **Recycle restore**: restoring a deleted document re-resolves the signed URL with current tenant context.
