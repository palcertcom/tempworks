# ADR-006 — Private File Storage with Signed URL Access

- **Status:** Accepted
- **Date:** 2026-05-09
- **Related:** ADR-001 (tenant isolation), `SAAS_FILE_STORAGE_SECURITY_PLAN.md`

## Context

Today's file-storage layer (`backend/src/common/storage/storage.service.ts`) writes objects to DigitalOcean Spaces with `ACL: 'public-read'` and stores keys under entity-typed paths (e.g. `documents/<entityType>/<entityId>/...`). Sensitive PII documents (passports, contracts, ID copies) are therefore reachable by URL guess if any path leaks into a log, screenshot, or browser history.

Additional issues:
- Storage keys are not strictly tenant-prefixed.
- A public unauthenticated upload endpoint (`POST /documents/public/upload`) lacks tenant binding, CAPTCHA, and rate limiting.
- The frontend resolves asset URLs directly via `resolveAssetUrl()`, coupling it to public-readable Spaces URLs.

## Decision

All file objects become **private**; access is mediated by short-lived signed URLs issued by the API after authorization. Object keys are tenant-prefixed.

### 1. Object key layout

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
      applications/<draftId>/<fileId>.<ext>     (public apply uploads)
      exports/<jobId>.zip
  platform/
    backups/<backupId>.dump
```

Keys are content-addressed by `sha256` for assets without an opaque DB id; original filenames are stored in DB only.

### 2. Access contract

- All objects uploaded with private ACL (no `public-read`).
- The API exposes:
  - `GET /api/v1/files/sign?d=<documentId>` → `{ url, expiresAt }` (5-minute v4 presigned URL).
  - `POST /api/v1/documents` (multipart upload, server-mediated).
  - `POST /api/v1/documents/presign` (presigned PUT for large uploads) → `{ uploadUrl, key, headers }` followed by `POST /api/v1/documents/finalize`.
- The server validates on every signed-URL issuance:
  1. `TenantContext.current().id === document.tenantId`.
  2. Caller has `documents:read` (and agency scope where applicable).
  3. Document is not soft-deleted unless caller has `recycle-bin:read`.
- Every signed-URL issuance writes an `audit_logs` row with `{ action: 'document.signed_url.issued', target: docId, ttl: 300, ip, ua }`.

### 3. Public upload endpoint

`/documents/public/upload` is replaced by `/jobs/:slug/apply/upload`:

- Tenant resolved from host (must succeed).
- CAPTCHA token required (Turnstile / hCaptcha).
- Per-IP rate limit (default 5/min) and per-tenant burst cap.
- Object key: `tenants/<tenantId>/applications/<draftId>/<fileId>.<ext>`.
- Bound to an `ApplicationDraft` row scoped to the tenant; orphan drafts swept by a daily job (TTL 7 days).

### 4. MIME and size policies

| Resource | Allowed MIME | Max size |
|---|---|---|
| Avatar | image/png, image/jpeg, image/webp | 5 MB |
| Logo | image/png, image/jpeg, image/webp, image/svg+xml *(sanitized)* | 2 MB |
| Document (compliance) | application/pdf, image/png, image/jpeg, application/msword, application/vnd.openxmlformats-officedocument.* | 25 MB |
| Vehicle docs / Finance attachments | application/pdf, image/* | 25 MB |
| Public application uploads | application/pdf, image/* | 10 MB |

Server validates MIME by magic-byte sniffing, not by trusting `Content-Type`. SVG is sanitized via a server-side scrubber (rejecting `<script>`, event handlers, external references).

### 5. Cutover ordering (corrected after architect review)

The order in `SAAS_FILE_STORAGE_SECURITY_PLAN.md` originally placed ACL flip before frontend cutover. **The corrected order is:**

1. **Object rekeying** — server-side S3 copy from current keys to tenant-prefixed keys; `Document.storageKey` updated. Original keys remain reachable.
2. **Frontend cutover** — `getSignedAssetUrl(documentId)` shipped to all clients; legacy `resolveAssetUrl()` removed. A metric (`signed_url_issuance_ratio`) is monitored.
3. **ACL flip** — when `signed_url_issuance_ratio` > 99% for 24 hours and no client errors are reported, the bucket policy is flipped to deny public reads and existing objects' ACLs are set to `private` via batch operation.
4. **Legacy `/uploads` retirement** — the local-FS static route is removed once all rows reference Spaces keys.

### 6. Encryption

- At rest: bucket-level server-side encryption (Spaces default).
- In transit: TLS 1.3.
- Per-tenant DEK envelope encryption for sensitive columns (national ID, bank account) is a Phase 4 follow-up; cryptographic erasure on tenant offboarding requires it.

### 7. AV scanning

- Asynchronous ClamAV scan after upload. `Document.scanStatus = PENDING | CLEAN | INFECTED`.
- `INFECTED` objects are moved to a `quarantine/` prefix and become un-signable.
- This is a Phase 3 add-on; not blocking SaaS launch.

## Consequences

**Positive**
- Sensitive documents are not URL-guessable; access requires authentication and authorization.
- Per-tenant access control is enforceable on the file plane, not just the DB plane.
- Audit trail of every read.
- Migration to encrypted-at-rest with customer-managed keys is feasible later without changing the access surface.

**Negative**
- Every download incurs an extra API roundtrip to fetch a signed URL.
- Caching strategy on the client must respect URL expiry.
- Email/PDF artifacts that include image links must embed (data URI) or attach instead of linking.

## Alternatives Considered

- **Keep public ACL for low-sensitivity assets (avatars, logos).** Rejected: simplest invariant is "all private"; mistakes cluster around exceptions. Avatars can be served via signed URL with longer TTL if needed.
- **API proxies file bytes** (no presigned URL). Rejected for now: bandwidth cost. Will revisit if signed-URL leakage proves problematic.
- **CDN-signed URLs (Cloudflare Worker).** Considered for Phase 4 to reduce origin bandwidth; not blocking.

## Implementation Notes

- The signed-URL endpoint accepts an opaque `documentId` (or storage-resource-key derived from a DB row), never a raw S3 key.
- TTL = 300 s; tunable per resource type if required (logos may use 3600 s).
- Frontend caches signed URLs in a `Map` keyed by resource id, with TTL-aware eviction.
- For `<img>` tags, the cached URL is reused until expiry; on 403 from Spaces, force re-fetch.
- 404 vs 403: when a caller has no access to a tenant's document, return 404 (avoid existence leak). When the caller has access but the doc is deleted, 410.

## Risks

- **Signed-URL leakage** via screenshot, browser history, or analytics. Mitigation: short TTL; audit; consider IP binding for sensitive document classes.
- **Frontend caching bug** retains expired URLs. Mitigation: cache invalidates on 403; smoke test in CI.
- **Search engine indexing of legacy public URLs.** Mitigation: post-flip, return 403 with `X-Robots-Tag: noindex` on the bucket; submit removal requests if applicable.
- **Email-embedded image fallback.** Mitigation: emails embed images directly or drop them in favor of links to authenticated views.

## Rollback Considerations

- The cutover is staged: rekeying is reversible (keys remain in both locations during transition), frontend cutover is feature-flagged (`STORAGE_PRIVATE_ACL` controls upload-time ACL only; reads check both old and new keys during transition), and ACL flip is the last, hard-to-reverse step.
- If issues arise post-flip, set bucket policy back to allow `public-read` on the legacy prefix only while the issue is investigated.
- Do not delete original keys until ≥ 30 days post-flip and a verification job confirms no client requests reference them.
