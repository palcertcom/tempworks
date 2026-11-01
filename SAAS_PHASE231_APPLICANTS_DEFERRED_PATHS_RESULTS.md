# Phase 2.31 — Applicants Deferred Paths Results

> Closes the two paths Phase 2.29 deferred: `uploadPhoto` (storage)
> and `publicSubmit` (public entry).

---

## 1. What changed

| Surface | Change |
|---------|--------|
| `src/applicants/applicants.service.ts` — `uploadPhoto` | Untenanted `findUnique` replaced by pilot-aware `findFirst({ id, deletedAt: null, ...scope.tenantWhere() })` BEFORE `storage.uploadFile`. Tag `phase231-storage-guard`. |
| `src/applicants/applicants.service.ts` — `publicSubmit` | Inserts `tenantId` resolved by `resolvePublicSubmitTenantId(agencyId)` (ALS first, agency fallback, reject otherwise in pilot mode). Tag `phase231-public-submit-attribution`. |
| `src/applicants/applicants.service.ts` — NEW helper `resolvePublicSubmitTenantId` | Hybrid Option A + B resolver. Pure function aside from one agency lookup. |
| `scripts/scan-annotations.ts` | New tags `phase231-storage-guard`, `phase231-public-submit-attribution`, `phase231-pilot-scope`. |
| `scripts/saas/phase2/applicants-deferred-paths-equivalence.ts` | NEW 6-case harness. |
| `scripts/saas/phase2/applicants-deferred-paths-isolation.ts` | NEW 9-case harness. |
| `package.json` | New scripts `saas:phase231-applicants-deferred-equivalence` / `…-isolation`. |

## 2. What did not change

- No schema migration (`Applicant.tenantId` already exists from Phase 2.29).
- No new feature flag — the existing `TENANT_PRISMA_PILOT_ENABLED` +
  per-module allow-list gate Phase 2.31.
- No login / session / auth change.
- No storage key, ACL, or signed-URL change.
- No reCAPTCHA / email / identifier-generation change.
- No mutation of any other module.
- `Applicant.email @unique` unchanged.
- Production behaviour with all flags OFF is byte-identical to pre-2.31.

## 3. Storage decision (`uploadPhoto`)

Owner-validation lands BEFORE byte write. The applicant resolver uses
the pilot client when active, so a cross-tenant id raises 404 without
the storage `uploadFile` call ever running. Same behaviour in legacy
mode collapses to the old `findUnique({ id })` semantics, which is
byte-equivalent to today's path. No change to storage keys or ACLs.

## 4. Attribution decision (`publicSubmit`)

Hybrid Option A + B. See
`SAAS_PHASE231_APPLICANTS_PUBLIC_SUBMIT_ATTRIBUTION_DECISION.md`.

- ALS frame wins when present.
- Otherwise `agency.tenantId` is used when the body has `agencyId`.
- Otherwise the request is rejected (pilot mode only).
- A mismatch between ALS and agency raises `TENANT_MISMATCH`.
- Legacy mode: NULL tenant attribution preserved.

## 5. Equivalence harness — 6/6 PASS

```
[applicants-deferred-paths-equivalence] 6/6 PASS
```

1. uploadPhoto legacy: shape preserved.
2. uploadPhoto pilot: shape preserved.
3. uploadPhoto pilot same-tenant: 1 storage call.
4. publicSubmit legacy: tenantId NULL.
5. publicSubmit pilot + agencyId (no ALS): tenantId = A.
6. publicSubmit pilot + ALS A: tenantId = A.

## 6. Isolation harness — 9/9 PASS

```
[applicants-deferred-paths-isolation] 9/9 PASS
```

1. uploadPhoto cross-tenant rejected; **no storage call**.
2. uploadPhoto same-tenant succeeds; exactly 1 storage call.
3. publicSubmit ALS A + agency A: tenantId = A.
4. publicSubmit ALS A + agency B: `TENANT_MISMATCH`; no row.
5. publicSubmit pilot, no ALS, no agency: `NO_TENANT`; no row.
6. publicSubmit agency B (no ALS): tenantId = B; tenant A cannot see it.
7. publicSubmit legacy: tenantId NULL (pre-2.31 behaviour).
8. concurrent ALS frames isolated.
9. source-level meta-assertion: phase231 patterns present.

## 7. Regression sentinels — all green

| Harness | Cases |
|---------|------:|
| `saas:phase2-applicants-equivalence`            | 12/12 |
| `saas:phase2-applicants-isolation`              | 10/10 |
| `saas:phase2-applicants-mutation-equivalence`   | 10/10 |
| `saas:phase2-applicants-mutation-isolation`     | 11/11 |
| `saas:phase230-audit-log-harness`               | 8/8   |
| `saas:phase2-finance-mutation-isolation`        | 16/16 |
| `saas:phase2-documents-mutation-isolation`      | 9/9   |
| `saas:phase2-workflow-mutation-isolation`       | 11/11 |

## 8. Production behaviour

With `TENANT_PRISMA_PILOT_ENABLED=false` (production default),
`uploadPhoto` reduces to the same legacy shape (`findFirst({ id, deletedAt: null })`,
no tenant predicate) and `publicSubmit` writes a NULL-tenant row —
both byte-identical to pre-2.31. The new error codes are unreachable
without the pilot flag set AND the runtime classifier returning
SAFE_CLONE/SAFE_STAGING.

## 9. Rollback runbook

```
TENANT_PRISMA_PILOT_ENABLED=false
# OR
TENANT_PRISMA_PILOT_MODULES=  # remove 'applicants'
```

No data migration introduced; no schema change. Rollback is
configuration only.

## 10. Remaining applicants blockers

- `Applicant.email @unique` (Phase 3 product).
- `convertToEmployee` cross-module entity validation
  (Document/FinancialRecord/Employee target-tenant validation) — needs
  a dedicated cross-module phase.
- Custom-domain public-form host resolution — Phase 3 product;
  the hybrid resolver is forward-compatible (path A engages
  automatically once `TenantContextMiddleware` resolves a host).

## 11. Annotation tag delta

Added: `phase231-storage-guard`, `phase231-public-submit-attribution`,
`phase231-pilot-scope` (reserved for any future site that engages
during follow-up review).

Phase 2.28's `phase228-excluded-mutation` annotations on `uploadPhoto`
and `publicSubmit` are gone — those sites now carry the Phase 2.31
tags.
