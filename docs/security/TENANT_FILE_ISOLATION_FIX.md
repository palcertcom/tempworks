# Security fix: cross-tenant document file access — deployment package

**Status:** prepared, not deployed. **Severity:** cross-tenant data exposure
(confidential employee/applicant documents). **Recommendation:** ship this fix
on its own, ahead of and independently from the disaster-recovery work.

## The issue

In the default ("legacy", non-pilot) Prisma mode, `scope().tenantWhere()`
returns `{}`, so two endpoints served files **across tenants by document ID**:

| Endpoint | Before | After |
|---|---|---|
| `GET /api/v1/documents/:id/file` (stream bytes) | another tenant's file → **200** | **404** |
| `POST /api/v1/documents/bulk-download` (ZIP) | other tenants' files **included** | silently **dropped** |
| `GET /api/v1/documents/:id` (metadata) | already 404 | unchanged |

Found by the DR drill (local, 2026-10-25) and confirmed pre-existing: the leak
reproduced on code whose two affected functions are **byte-identical to
`origin/main` (`5bffa16`)** — so production is affected if it runs `main` or
anything older that contains these functions. Exploiting it needs an
authenticated account with `documents:read` and a document ID (UUIDs — not
guessable, but they appear in URLs, exports and notification e-mails).

## The fix

`backend/src/documents/documents.service.ts`, `documents.controller.ts` only
(commit `c04c98a`; app-only patch: `docs/security/tenant-file-isolation.patch`,
sha256 `fedd8ded9755cfa3845e206ab086d71a589ff300bbbd922eff61e05dc2c2b298`).
The byte endpoints now apply **the same rule the metadata endpoint `findOne`
already applies in production**: the document's *owning entity* (employee,
applicant, agency, user, attendance) must be in the caller's tenant; platform
admins (`PlatformAdmin` → `agencyIsSystem`) bypass. The rule is factored into
one helper, `isSameTenantAsCaller()`, used by all three paths.

## Dependencies — none beyond the two files

| Question | Answer (checked) |
|---|---|
| Schema change / migration? | No |
| New environment variables? | No |
| Other commits of this branch required? | No — applies cleanly to `origin/main` `5bffa16` and compiles with **0** TypeScript errors there |
| Recent `main` changes to the documents module? | None since merge-base `8c99763` |
| Uses existing code only | `resolveEntityTenantId()` (exists on main), JWT `tenantId` + `agencyIsSystem` (exist on main) |
| Frontend change needed? | No. Callers: applicant PDF export (`/file`) and Document Explorer (bulk ZIP) — same-tenant use continues to work |
| Can it block legitimate access? | It blocks exactly what the metadata endpoint `findOne` already blocks. Legacy rows with `tenantId = NULL` and users without a tenant are treated as `findOne` treats them (allowed). **One data-dependent case — see below.** |
| Callers of `createBulkDownloadArchive(ids)` without a caller (scripts/harnesses) | Unchanged behaviour (treated as internal) |

## Data-dependent dependency: cross-tenant agency grants (check BEFORE deploying)

`grantAgencyAccess` does **not** verify that the granted agency belongs to the
employee's tenant (in legacy mode its lookups are by id only). So a grant can
link an agency of tenant B to an employee of tenant A. Such a grantee can open
the employee record (grant check passes) and, before this fix, could stream the
employee's files via `/documents/:id/file` and the bulk ZIP. After the fix they
get 404 / the file is dropped — the same answer `findOne` already gives them.

Whether that is a regression or the closing of a second leak depends on
whether cross-tenant grants are intended. Run this **read-only** query on
production first:

```sql
SELECT count(*) AS cross_tenant_view_grants
  FROM employee_agency_access g
  JOIN employees e ON e.id = g."employeeId"
  JOIN agencies  a ON a.id = g."agencyId"
 WHERE g."canView"
   AND e."tenantId" IS NOT NULL AND a."tenantId" IS NOT NULL
   AND e."tenantId" <> a."tenantId";
```

- **0** → no user is affected; deploy the fix as is.
- **> 0** → decide: (a) such grants are mistakes → deploy as is (and consider
  making `grantAgencyAccess` call the existing `assertAgencyInTenant` check);
  or (b) they are intended → extend `isSameTenantAsCaller` to also allow a
  caller whose agency holds a `canView` grant on the owning employee, then deploy.

## Residual risks (not fixed here — separate decisions)

1. **Objects are `public-read`.** `StorageService.uploadFile` stores files with
   `ACL: 'public-read'`, and the UI's *Download* links use the public
   `fileUrl` directly. Anyone holding a file URL can fetch it without the API.
   Closing that requires a private bucket + short-lived presigned URLs (larger change).
2. **Agency-level (intra-tenant) scoping is not enforced in the documents
   service.** Employee records honour agency grants; document bytes only honour
   the tenant boundary (before and after this fix).

## Deploy (when you choose to) — standalone onto `main`

```bash
git fetch origin && git checkout -b fix/tenant-file-isolation origin/main
git apply docs/security/tenant-file-isolation.patch     # from a checkout of this branch, or:
# git cherry-pick c04c98a   (then drop its drill/test-script hunks if undesired)
cd backend && npm ci && npx tsc --noEmit -p tsconfig.json && npm run build
# open a PR, review, merge, deploy through the normal process
```

**Post-deploy smoke test** (read-only; two users from different tenants):

```bash
# as tenant A user, a document ID that belongs to tenant B:
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN_A" \
  https://careers.tempworks.eu/api/v1/documents/$TENANT_B_DOC_ID/file      # expect 404
# own tenant's document still works:
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN_A" \
  https://careers.tempworks.eu/api/v1/documents/$TENANT_A_DOC_ID/file      # expect 200
```

**Rollback:** revert the commit (two files, no data or schema changes).

## Verification performed

- Local application drill (real backend + UI, PostgreSQL 18): before the fix
  cross-tenant `/file` → 200; after → 404; bulk ZIP drops the other tenant's
  file; same-tenant downloads byte-identical (`docs/dr-evidence/2026-10-25-local-drill/`).
- `origin/main` + patch: applies cleanly, `tsc` 0 errors.
- Not run: the repository's DB-backed `scripts/saas/phase2/documents-download-*`
  harnesses (they need a dedicated database).
