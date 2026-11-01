# Phase 2.31 — Applicants Deferred Path Audit

> Audit of the two paths Phase 2.29 deferred:
> `uploadPhoto` (storage-side) and `publicSubmit` (public entry).

---

## 1. `uploadPhoto`

`src/applicants/applicants.service.ts:281`

### 1.1 Current behaviour

```ts
async uploadPhoto(id: string, file: Express.Multer.File) {
  const applicant = await this.legacyPrisma.applicant.findUnique({  // phase228-excluded-mutation
    where: { id }, select: { firstName: true, lastName: true, photoUrl: true },
  });
  if (!applicant) throw new NotFoundException(...);

  const upload = await this.storage.uploadFile(file.buffer, {
    keyPrefix: `applicants/${id}/photos`,
    contentType: file.mimetype,
    originalName: file.originalname,
    inline: true,
  });

  const updated = await this.legacyPrisma.applicant.update({  // phase228-excluded-mutation
    where: { id }, data: { photoUrl: upload.url }, include: this.include,
  });
  if (applicant.photoUrl && applicant.photoUrl !== upload.url) {
    await this.storage.deleteFileByUrlOrKey(applicant.photoUrl);
  }
  return updated;
}
```

### 1.2 Audit

| Aspect | State |
|---|---|
| Prisma calls | `legacyPrisma.applicant.findUnique`, `legacyPrisma.applicant.update` (untenanted) |
| Storage calls | `storage.uploadFile` (BEFORE owner validation), `storage.deleteFileByUrlOrKey` (orphan cleanup, fine) |
| Audit log | None today |
| Public request context | N/A — authenticated route |
| Tenant context | Available (caller is authenticated) but never consulted |
| Cross-tenant risk | **HIGH** — any authenticated user with the applicant id can upload; no tenant gate. Even worse: storage write happens BEFORE `findUnique`, so a 404 still leaves a leaked byte write. |
| Storage risk | An attacker who knows tenant B's applicant id can land bytes under `applicants/<id>/photos/...` even if the subsequent DB update fails. `findUnique` doesn't filter by deletedAt either. |
| Required tenant attribution | The applicant already carries `tenantId` from Phase 2.29 — no new column needed. The fix is a **pre-check**, not a write. |
| Rollback behaviour | Removing the new pre-check returns to today's behaviour byte-for-byte. |
| Decision | **INCLUDED** — `phase231-storage-guard`. Replace the untenanted `findUnique` with the existing `findApplicantOrFail(id)` parent gate (added in Phase 2.28) called BEFORE `storage.uploadFile`, so a cross-tenant id raises 404 *without writing bytes*. |

### 1.3 Storage decision

- **No change to storage keys.** `applicants/<id>/photos/...` continues to use the applicant id, which is already globally unique.
- **No ACL flip.** Inline-public default unchanged.
- **No signed URLs.** Out of scope for Phase 2.31.
- **Owner validation lands BEFORE byte write.** This is the only behaviour change.
- **Orphan cleanup (`deleteFileByUrlOrKey` on the previous `photoUrl`) is unchanged.**

## 2. `publicSubmit`

`src/applicants/applicants.service.ts:343`

### 2.1 Current behaviour

The route is `@Public POST /applicants/public/submit`. It accepts a JSON body, optionally verifies reCAPTCHA, and creates an applicant row with `tier='LEAD'`, `source='SELF_APPLIED'`, no `tenantId`. The tenant field is never set, even when Phase 2.29's pilot is active — `publicSubmit` was explicitly skipped.

### 2.2 Audit

| Aspect | State |
|---|---|
| Prisma calls | `legacyPrisma.applicant.create` |
| Storage calls | None |
| Audit log | None today |
| Public request context | No JWT, no session, no auth user |
| Tenant context | **Maybe**. If the request hits a tenant subdomain/host, `TenantContextMiddleware` populates ALS via `TenantResolverService`. If it hits a generic host (no domain mapping), there is no ALS frame. |
| Cross-tenant risk | **MEDIUM** — today every public submission is global / NULL-tenant. Pilot-mode tenants reading their own applicants miss self-applied leads (data invisible). Conversely, a malicious tenant id in the body would not affect anything because the field isn't read; but if Phase 2.31 starts writing `tenantId`, the attribution decision must be airtight. |
| Storage risk | None — no storage path. |
| Required tenant attribution | A self-applied lead must land under a known tenant. Allowed sources, in order of precedence: ALS frame (host-resolved), agency.tenantId (when payload has agencyId). Never a default tenant. |
| Rollback behaviour | With the new flag OFF the row is created without `tenantId`, exactly as today. |
| Decision | **INCLUDED** — `phase231-public-submit-attribution`. Hybrid Option A + B (see attribution-decision doc). |

### 2.3 reCAPTCHA, email, and identifier generation are unchanged

- `RECAPTCHA_SECRET_KEY` gate is preserved.
- `generateIdentifier('A')` is preserved.
- Confirmation email fire-and-forget call is preserved.
- `applicationData` shape, `source='SELF_APPLIED'`, `tier='LEAD'`, `status='NEW'` defaults are all preserved.

## 3. Cross-cutting decisions

| Concern | Decision |
|---|---|
| Schema migration | **None.** `Applicant.tenantId String?` already exists. |
| RLS | **Unchanged.** Not introduced. |
| Global enforcement | **Unchanged.** `TENANT_PRISMA_ENFORCEMENT` stays default off. |
| New flag? | **No new flag.** Phase 2.31 reuses the existing `TENANT_PRISMA_PILOT_ENABLED` + the per-module allow-list (`TENANT_PRISMA_PILOT_MODULES=applicants`). |
| Email uniqueness | **Unchanged.** `Applicant.email @unique` stays globally unique. |
| ACL / signed URLs | **Unchanged.** |
| Audit log helper | `uploadPhoto` does not emit an audit row today and Phase 2.31 does not start emitting one (out of scope). `publicSubmit` likewise unchanged. |

## 4. Included vs. deferred

**Included in Phase 2.31:**
- `uploadPhoto` storage guard (parent tenant gate before byte write).
- `publicSubmit` tenant attribution (hybrid ALS + agency).

**Deferred beyond Phase 2.31:**
- Public submission via custom-domain (only relevant once tenant custom domains ship in Phase 3).
- Photo `signed URLs` and tenant-scoped storage prefixes.
- `convertToEmployee` cross-module entity validation (Document / FinancialRecord / Employee target tenant must equal active tenant) — distinct cross-module phase.

## 5. Production safety summary

With every flag at its default (`false`), both methods take the legacy code path: `uploadPhoto` runs the unguarded `findUnique` exactly as today; `publicSubmit` writes a NULL-tenant row exactly as today. The Phase 2.31 changes are gated by `getPilotScope(this.pilot, 'applicants').active`, which requires `TENANT_PRISMA_PILOT_ENABLED=true` AND `applicants` in the allow-list AND a SAFE_CLONE/SAFE_STAGING runtime environment. None of those is true in production.
