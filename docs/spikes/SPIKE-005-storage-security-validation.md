# SPIKE-005 — Storage Security Migration Validation

- **Status:** PASS WITH CONSTRAINTS
- **Date:** 2026-05-09
- **Artifact:** `spikes/spike-005-storage/sign-flow.mjs` (offline AWS SigV4 generator)
- **Validates:** ADR-006

## Hypothesis

Migrating object storage from `ACL: public-read` to private + signed-URL access is feasible without breaking existing clients, provided the cutover order is: rekey → frontend cutover → ACL flip, and the signing surface is purely server-mediated with `tenantId` resolved from server-side context.

## Findings

### F-1 — Signing flow is opaque to the client

The probe issues two presigned URLs for the same object id under two tenants. The URLs differ in object key (`tenants/<tenantA>/...` vs `tenants/<tenantB>/...`), proving the client cannot influence which tenant's key is signed — the server reads `tenantId` from `TenantContext.current()` (ALS) at signing time. **Confirms ADR-006 §3 (tenancy resolved server-side, never from client payload).**

### F-2 — TTL is per-issuance

URLs at TTL 60 vs 300 produce different signatures and `X-Amz-Expires` query params. After expiry, the URL returns HTTP 403 from S3/Spaces. Browser caches that retain the URL will re-fetch on 403 → see F-7.

### F-3 — Key layout enforces tenancy at the bucket level

```
tenants/<tenantId>/<resourceClass>/<resourceId>/...
```

A bucket policy `Deny: s3:* if not s3:prefix=tenants/${aws:RequestTag/TenantId}` is the long-term hardening (Phase 4); for Phase 3, the prefix is enforced at the application's signing layer. Any key not beginning with `tenants/<contextTenantId>/` is rejected before signing.

### F-4 — Cutover sequencing (corrected from original plan)

Per architect-review I-14:

1. **Rekey** — server-side S3 copy from current keys to `tenants/<tenantId>/...`. `Document.storageKey` updated. Old keys still readable.
2. **Frontend cutover** — ship `getSignedAssetUrl()` to all clients; remove `resolveAssetUrl()` direct paths. Monitor metric `signed_url_issuance_ratio`.
3. **ACL flip** — when `signed_url_issuance_ratio > 99% for 24 h`, flip bucket policy + batch-set existing objects to private. Original keys (still on the legacy prefix) are also flipped.
4. **Legacy prefix retirement** — after 30 days post-flip, delete original keys.

### F-5 — Frontend cache behavior

- `Map<documentId, { url, expiresAt }>` keyed by document id, evicted on `expiresAt - 30s`.
- On HTTP 403 from S3, treat as expired → re-fetch.
- React Query: don't cache the `getSignedAssetUrl` response in the React Query store globally — keep it in a small in-memory `Map` so tenant-switch-clear doesn't keep stale URLs.
- Service Worker: per-origin scope; don't cache opaque S3 responses (avoid retaining presigned URLs across origin sessions).

### F-6 — CDN implications

- Cloudflare in front of `app.tempworks.com` does **not** proxy S3 reads — the signed URL points to `*.digitaloceanspaces.com` directly. Confirmed by F-1 (URL host is the Spaces host). Bandwidth flows to/from Spaces, not through Cloudflare.
- Future optimization (Phase 4): Cloudflare Worker that re-signs on the edge, allowing CDN cache. Out of scope now.
- DDoS protection on the bucket is the cloud provider's responsibility; per-tenant rate limits remain on the API (`/files/sign`) endpoint.

### F-7 — URL expiration UX

| Scenario | Behavior | Mitigation |
|---|---|---|
| Long-lived `<img>` already rendered, URL expires | Browser shows broken image on next reload | TTL 5 min for thumbnails / avatars; 60 min permitted for static logos |
| Tab open, user idle, doc-list page → URL expires | Click on doc → 403 | Client refetches signed URL on 403 (F-5) |
| Email or PDF includes a signed URL | URL dies after TTL | **Don't link**; embed images (data URI) or attach files |
| User shares signed URL externally | Recipient can fetch within TTL | Documented; for sensitive document classes, add IP-binding query param (`X-Amz-Source-IP`) — Phase 4 hardening |

### F-8 — Large-file download UX

- `<a href="<signedUrl>" download>` works for files up to ~2 GB; browser streams from Spaces directly. No backend bandwidth.
- For files > 2 GB or where progress UX is needed, use `fetch` + `ReadableStream` + `Blob`. Monitor for memory issues on small devices; for very large files prefer multipart streaming with `Range` requests (presigned URL supports it).
- Resumable downloads: clients honor HTTP 206 partial content. The signed URL TTL must cover the expected download time → bump TTL for files larger than `size / 1Mbps + 60s`.

### F-9 — Revocation behavior

- **Cannot revoke a presigned URL before its TTL.** This is a property of S3-style signing.
- Mitigation: short TTL (5 min default).
- For "this user lost access just now" cases: rotating the bucket's signing key invalidates **all** outstanding URLs immediately. Reserved for emergencies.
- Per-tenant key isolation (Phase 4 with KMS-managed keys) gives finer-grained revocation: rotate one tenant's key.

### F-10 — Audit trail correctness

Every successful call to `/api/v1/files/sign` writes one `audit_logs` row. Forge tests:
- Caller without `documents:read` → 403, no signed URL, audit row with `result='denied'`.
- Caller with permission but cross-tenant doc id → 404 (existence-leak prevention), audit row with `result='not_found'`.

### F-11 — Public-apply upload path

`/jobs/:slug/apply/upload` resolves tenant from host first; CAPTCHA + rate limit applied; object key forced to `tenants/<tenantId>/applications/<draftId>/...`; orphan drafts swept by daily job (TTL 7 days). Signed PUT presigned URL returned to the client; finalize endpoint verifies object exists + size + hash. Confirmed shape; no proof-of-concept needed beyond the design.

## Frontend Compatibility Plan

| Component class | Today | After |
|---|---|---|
| `<EmployeePhoto>` | `<img src={resolveAssetUrl(employee.photoUrl)}>` | `<img src={useSignedUrl(employee.photoId)}>` |
| `<DocumentPreview>` | direct `iframe src` | `<iframe src={useSignedUrl(doc.id)}>` |
| Bulk download | server zips and streams | server zips on a worker; signed URL to the zip; TTL 1 h |
| Email attachments | links | embedded / attached (no signed link) |
| PDF generation | downloads images via signed URLs server-side | signed URL is server-side issued during render |
| Service worker | caches assets | does NOT cache opaque presigned responses |

## CDN Implications

- **Today:** none — all Spaces objects are public, browsers can cache them by URL.
- **After:** signed URLs change every TTL → browser-level caching reduced. For low-sensitivity assets (avatars, logos), TTL extended to 1 h; combined with the in-memory `Map` cache, this is acceptable.
- **Cloudflare layer:** stays as edge for the API; not in the Spaces data path until Phase 4.

## Risks Surfaced

| # | Risk | Mitigation |
|---|---|---|
| R-1 | ACL flip before frontend cutover breaks every image/doc | Sequencing in F-4 strictly enforced; metric-gated flip |
| R-2 | Legacy public URLs in user bookmarks / search engines | After flip, configure `X-Robots-Tag: noindex`; submit removal requests; the URLs return 403 anyway |
| R-3 | Long-lived embedded URLs in old emails/PDFs | Don't generate new ones; archive old artifacts; for re-rendering, re-sign at render time |
| R-4 | Browser keeps expired URL in `<img>` cache; user sees broken image until reload | F-5 cache layer evicts on `expiresAt - 30s`; `<img onerror>` triggers re-fetch |
| R-5 | Compromised access key | All URLs invalidated by rotation; runbook documented |
| R-6 | Worker / Cron job that emits a signed URL into a notification email | Rule: emails never contain signed URLs; notifications link to the in-app page that re-signs |

## Verdict: **PASS WITH CONSTRAINTS**

Constraints:

1. Cutover order strictly: rekey → frontend ship → ACL flip; gate by `signed_url_issuance_ratio` metric.
2. TTL: 5 min default; max 1 h for low-sensitivity assets; reduce to 60 s for high-sensitivity (national ID).
3. Server resolves `tenantId` from ALS, **never** from request body.
4. Emails never embed signed URLs — link to in-app re-sign page or attach the file.
5. Frontend `useSignedUrl` hook + in-memory cache + 403-aware refetch is mandatory pattern.
6. Bucket policy denying any non-`tenants/...` prefix becomes the long-term hardening (Phase 4).
7. Revocation runbook (signing-key rotation) tested annually.

## Cleanup

```sh
rm -rf spikes/spike-005-storage
```
