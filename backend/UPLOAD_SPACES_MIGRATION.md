# DigitalOcean Spaces Upload Migration

This document tracks the migration of file uploads from local disk
storage (`./uploads`) to DigitalOcean Spaces (S3-compatible). Production
deployments must run with `UPLOAD_STORAGE_DRIVER=spaces`.

## 1. New flow at a glance

1. Multer is configured per-route with `memoryStorage()` — uploads are
   buffered in RAM, never written to disk.
2. Each upload handler calls `StorageService.uploadFile(file.buffer, …)`
   which streams the buffer to Spaces via the AWS SDK v3 S3 client.
3. The returned **public URL** is persisted in the existing
   `photoUrl` / `logoUrl` / `fileUrl` DB fields. Frontend contracts
   are unchanged.
4. When a record is replaced/deleted, the previous Spaces object is
   removed best-effort (warnings are logged; failures do not block the
   request). Legacy `/uploads/...` URLs are tolerated and ignored unless
   a matching local file exists.

Key files added:

- `backend/src/common/storage/storage.service.ts` — S3/Spaces client +
  `uploadFile`, `deleteFileByUrlOrKey`, `deleteByPrefix`,
  `getPublicUrl`, `extractKeyFromUrl`, `isLegacyLocalUrl`.
- `backend/src/common/storage/storage.module.ts` — global Nest module.
- `backend/src/common/storage/multer.config.ts` — `memoryUpload()` +
  shared MIME constants (`IMAGE_MIME`, `LOGO_IMAGE_MIME`,
  `DOCUMENT_MIME`).

## 2. Required environment variables

| Variable | Required when | Default | Notes |
| --- | --- | --- | --- |
| `UPLOAD_STORAGE_DRIVER` | always | `local` | Set to `spaces` in production. |
| `UPLOAD_DEST` | local driver | `./uploads` | Local fallback root. |
| `MAX_FILE_SIZE` | optional | `10485760` (10 MB) | Used by the documents and application-draft endpoints. |
| `DO_SPACES_ENDPOINT` | spaces driver | `https://fra1.digitaloceanspaces.com` | Region-scoped Spaces endpoint. |
| `DO_SPACES_REGION` | spaces driver | `fra1` | Used by the AWS SDK signer. |
| `DO_SPACES_BUCKET` | spaces driver | `tempworks-uploads` | The bucket files are written to. |
| `DO_SPACES_ACCESS_KEY` | spaces driver | — | DigitalOcean access key ID. |
| `DO_SPACES_SECRET_KEY` | spaces driver | — | DigitalOcean secret. **Never commit.** |
| `DO_SPACES_PUBLIC_URL` | spaces driver | `https://tempworks-uploads.fra1.digitaloceanspaces.com` | Public bucket URL prefix used to build object URLs. |

The app validates the Spaces vars at boot. With
`UPLOAD_STORAGE_DRIVER=spaces`, missing values throw a fatal error from
`StorageService.onModuleInit` so misconfigured deploys fail fast instead
of silently writing to disk.

## 3. Migrated endpoints

| Route | Method | Storage key prefix |
| --- | --- | --- |
| `/agencies/:id/logo` | PATCH | `agencies/{id}/logos/` |
| `/users/me/photo` | POST | `users/{userId}/avatars/` |
| `/users/:id/photo` | POST | `users/{userId}/avatars/` |
| `/employees/:id/photo` | PATCH | `employees/{id}/photos/` |
| `/applicants/:id/photo` | PATCH | `applicants/{id}/photos/` |
| `/application-drafts/mine/photo` | POST | `application-drafts/{draftId}/photo/` |
| `/application-drafts/mine/documents` | POST | `application-drafts/{draftId}/docs/` |
| `/application-drafts/mine/documents/:docId` | DELETE | (deletes Spaces object) |
| `/application-drafts/mine` | DELETE | (prefix-deletes `application-drafts/{draftId}/`) |
| `/settings/branding/logo` | POST | `settings/branding/` |
| `/documents/public/upload` | POST | `documents/APPLICANT/{entityId}/{type}/` (no auth — see security notes) |
| `/documents/upload` | POST | `documents/{entityType}/{entityId}/{type}/` |
| `/documents/:id/renew` | POST | `documents/{entityType}/{entityId}/{type}/` |
| `/finance/:id/attachments` | POST | `finance/{recordId}/attachments/` |
| `/vehicles/:vehicleId/documents` | POST | `vehicles/{vehicleId}/documents/` |
| `/vehicles/maintenance/records/:id/attachments` | POST | (controller wired for memoryUpload; service stub still requires the `enhance-maintenance-records` migration before storing rows — see TODO below) |
| `/employees/:employeeId/work-history/:entryId/attachments` | POST | `employees/{employeeId}/work-history/{entryId}/attachments/` |

Object names within each prefix are `{uuid}.{ext}`. The original
filename never appears in the key — it is preserved only as the DB
`name`/`fileName` field.

## 4. Database

No schema changes. Existing string fields (`photoUrl`, `logoUrl`,
`fileUrl`, `documents` JSON) now hold the full Spaces URL, e.g.

```
https://tempworks-uploads.fra1.digitaloceanspaces.com/employees/abc-123/photos/uuid.jpg
```

Legacy rows that still hold `/uploads/...` are returned unchanged and
served by the existing `app.use('/uploads', express.static(...))` route
(kept for backwards compatibility).

## 5. Backwards compatibility

- `app.use('/uploads', express.static(...))` in `main.ts` is preserved.
  Legacy URLs continue to resolve from disk.
- `StorageService.deleteFileByUrlOrKey` is a no-op for `/uploads/...`
  URLs unless the matching local file is present.
- `DocumentsService.fetchDocumentBuffer` (used by bulk download)
  transparently fetches Spaces URLs over HTTP and reads
  `/uploads/...` paths from local disk.
- Frontend response shapes are unchanged — every endpoint still returns
  the same `{ photoUrl, logoUrl, fileUrl, documents[] }` payload, only
  the URL value differs.

When the legacy disk files are migrated (or replaced by re-uploads),
the `/uploads` route can be removed from `main.ts`.

## 6. Security fixes shipped with this migration

1. **SVG logos rejected.** `LOGO_IMAGE_MIME` excludes `image/svg+xml`
   to prevent inline-XSS payloads from rendering. Re-enable only after
   server-side sanitization (DOMPurify or equivalent).
2. **Vehicle maintenance attachments.** Previously had no `fileFilter`
   and no size limit — now use the standard `DOCUMENT_MIME` allow-list
   and a 10 MB cap.
3. **Public document upload** (`/documents/public/upload`) now goes
   through the shared `fileInterceptor`, which enforces the document
   MIME allow-list and `MAX_FILE_SIZE`. A `TODO(security)` comment
   flags the remaining open issues (rate limiting, CAPTCHA, signed
   upload tokens).
4. **Filenames are never reflected into object keys.** The original
   filename is sanitized only enough to derive a safe extension; the
   key uses a fresh UUID. This blocks path traversal and overwrite
   attacks.
5. **Old objects are deleted on replace.** Photo/logo/branding upload
   handlers now call `StorageService.deleteFileByUrlOrKey` for the
   previous URL, eliminating the orphan-file accumulation that
   previously plagued the `/uploads` directory.

## 7. Remaining TODOs / risks

- Spaces objects are uploaded with `ACL: 'public-read'`. **Sensitive
  documents (compliance, finance, IDs, contracts, work-history) should
  move to private objects** with either:
  1. A signed-URL accessor (`@aws-sdk/s3-request-presigner` is already
     in `package.json` for this purpose), or
  2. An authenticated `/api/v1/files/:key` proxy that streams the
     object after re-checking the user's ACL.
  Marked as TODO in `storage.service.ts`.
- Public `/documents/public/upload` remains unauthenticated. Add
  rate-limiting or short-lived upload tokens before going live with
  the public application form.
- The vehicle maintenance attachments table is created by the optional
  `enhance-maintenance-records` migration. Once that runs, complete the
  service implementation in `vehicles.service.ts:addMaintenanceAttachment`
  to call `storage.uploadFile`.
- The `/uploads` static route is still mounted. Plan an offline job
  to migrate existing disk files to Spaces (`s3 cp --recursive`) and
  then remove the route.
- No automated tests cover the StorageService yet. Suggested unit tests:
  - `extractKeyFromUrl` for Spaces URL, legacy `/uploads/...`, bare key,
    and unknown HTTP URL.
  - `isLegacyLocalUrl` for `/uploads/x` vs Spaces URL vs key.
  - `getPublicUrl` against a stubbed `DO_SPACES_PUBLIC_URL`.
  - `uploadFile` integration test against a Spaces compatible mock
    (e.g. `aws-sdk-client-mock` for `S3Client`).

## 8. Manual test checklist

Run with `UPLOAD_STORAGE_DRIVER=spaces` against a real Spaces bucket.

- [ ] Boot the API. The log line `Storage driver: spaces (bucket=…)`
      appears. Removing one of the `DO_SPACES_*` vars makes boot fail
      with a fatal error.
- [ ] PATCH `/agencies/:id/logo` with a JPEG ≤5 MB → response includes
      `logoUrl` starting with `https://tempworks-uploads.fra1.digitaloceanspaces.com/agencies/`.
      Re-upload → previous object is deleted from Spaces.
- [ ] PATCH `/agencies/:id/logo` with an SVG → 400 with the
      "File type image/svg+xml not allowed" error.
- [ ] POST `/users/me/photo` with a PNG → `photoUrl` returned, file
      visible at the Spaces URL, prior avatar removed.
- [ ] PATCH `/employees/:id/photo` and `/applicants/:id/photo` →
      photo replaces, prior object deleted.
- [ ] POST `/application-drafts/mine/photo` → draft row stores Spaces
      URL. POST `/application-drafts/mine/documents` → adds entry to
      `draft.documents` with Spaces URL. DELETE `/application-drafts/mine`
      → all `application-drafts/{draftId}/*` objects removed via prefix
      delete.
- [ ] POST `/settings/branding/logo` → `branding.logoUrl` stored in
      `system_settings`, prior logo removed.
- [ ] POST `/documents/upload` (PDF) → row created with Spaces URL,
      file accessible.
- [ ] POST `/documents/:id/renew` (with file) → renewed row uses new
      URL; original row untouched.
- [ ] POST `/finance/:id/attachments` (PDF) → attachment row created;
      DELETE removes object.
- [ ] POST `/vehicles/:vehicleId/documents` (PDF) → document row
      created.
- [ ] POST `/employees/:employeeId/work-history/:entryId/attachments`
      → attachment row created; DELETE removes object.
- [ ] POST `/documents/bulk-download` with mixed Spaces + legacy URLs
      → ZIP downloads successfully (Spaces objects fetched via HTTPS,
      `/uploads/...` files read from disk).
- [ ] Legacy `/uploads/<path>` URLs in existing rows still load via
      `express.static`.

## 9. Rollback

1. Set `UPLOAD_STORAGE_DRIVER=local` in the environment.
2. Restart the API. New uploads return to writing under `./uploads/`
   with the same key layout (`agencies/{id}/logos/<uuid>.<ext>` etc.).
3. Existing Spaces URLs in the database keep working — they're just
   external references at that point. They can be re-uploaded
   manually if required.

No DB migration is required for rollback.
