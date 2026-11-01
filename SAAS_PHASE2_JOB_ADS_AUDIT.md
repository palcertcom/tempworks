# Phase 2.9 — Job Ads Module Audit

> Pre-refactor audit of `src/job-ads`. Third tenant-scoped pilot, and
> the first to refactor a model that did NOT have `tenantId` before
> this PR.

---

## 1. Files in module

| File | Lines | Role |
|------|------|------|
| `job-ads.module.ts` | 11 | Nest module |
| `job-ads.controller.ts` | 121 | HTTP surface (dashboard CRUD + public endpoints) |
| `job-ads.service.ts` | 241 | business logic |
| `constants.ts` | 36 | enum-like constants for the dropdowns |
| `dto/*.ts` | (small) | input shapes |

Total: ~410 lines.

## 2. Prisma call sites (pre-refactor)

10 direct `this.prisma.jobAd.*` call sites:

| Method | Calls |
|---|---|
| `uniqueSlug` | 1 (`findFirst`) |
| `findAll` | 2 (`findMany`, `count`) |
| `findPublished` | 2 (`findMany`, `count`) |
| `findBySlug` | 1 |
| `findOne` | 1 |
| `create` | 1 |
| `update` | 1 |
| `remove` | 1 |

No raw SQL. No background tasks. No file/storage interactions.

## 3. Models used

- `JobAd` — primary tenant-scoped target. **Did NOT have `tenantId`
  before Phase 2.9** — the migration added a nullable `tenantId` plus
  `@@index([tenantId])` and `@@index([tenantId, slug])`.
- `User` — read-only via `createdBy` include. GLOBAL.
- `Applicant` — referenced via `_count: { applicants: true }`.

## 4. Tenant ownership path

```
JobAd.tenantId  ← Phase 2.9 nullable column (this PR)
JobAd.createdById → User.id (no tenant ownership today)
```

The natural ownership chain through the creating user is not currently
captured (User → AgencyMembership → Tenant in Phase 1). The pilot's
filter relies on `JobAd.tenantId` directly, populated at create-time
when the pilot scope is active.

## 5. Use of `tenantId`

- Pre-refactor: column did not exist.
- Schema (post Phase 2.9): nullable; two new indexes. The existing
  `slug @unique` global constraint is preserved.
- Service (post-refactor):
  - reads spread `scope.tenantWhere()` into every `where`
  - create spreads `scope.tenantData()` into the data
  - `uniqueSlug` lookup stays GLOBAL by design (see §6)

## 6. Slug uniqueness behavior

- Schema: `slug String @unique` — globally unique.
- Service: `uniqueSlug(base, excludeId?)` runs a global lookup and
  appends `-1`, `-2`, … on collision.
- Why we kept the lookup global in pilot mode: the Postgres constraint
  is still global. If we tenant-scoped the suffix-loop, it would hand
  out a slug that the unique index then rejected on insert (P2002).
- Phase 3 plan: swap the constraint to a composite `(tenantId, slug)`
  unique once every existing public URL is reconciled. See
  `SAAS_PHASE2_JOB_ADS_SLUG_SAFETY.md`.

## 7. Public listing behavior

`PublicJobAdsController` exposes two endpoints with NO authentication:

- `GET /jobs` → `findPublished()` — paginated list of PUBLISHED ads
- `GET /jobs/:slug` → `findBySlug()` — single ad by slug

Public traffic carries no tenant context in ALS, so
`scope.tenantWhere()` returns `{}` and the service surfaces every
PUBLISHED ad across all tenants — preserving today's public URL
semantics. Phase 3 may add a tenant-from-host resolver; the same code
path will then automatically scope public traffic to the resolved
tenant without further service changes.

## 8. Create/update/delete paths

| Method | Effect | Tenant constraint (pilot mode) |
|--------|--------|--------------------------------|
| `create` | inserts with auto-slug + optional `tenantId` | persists `tenantId` from ALS |
| `update` | updates by id; pre-checked by tenant-scoped `findOne` | cross-tenant id ⇒ 404 |
| `remove` | soft-delete by id; same pre-check | cross-tenant id ⇒ 404 |

## 9. Permissions

Permissions are enforced at the controller via the standard guards.
The pilot does NOT change auth, RBAC, or HTTP status codes. A
cross-tenant id presents as `NotFoundException` (404).

## 10. Current risks (pre-refactor)

- Cross-tenant `id` reuse: a caller with a guess could read/update/
  delete across tenants. Pilot closes this hole.
- Slug squatting: tenant A could publish an ad with slug `engineer`,
  pre-empting tenant B's ability to use the same slug. The pilot
  preserves this behaviour today; Phase 3 swap to composite unique
  resolves it.
- Public listing exposure: public listing surfaces every PUBLISHED ad
  across tenants. This is intentional today; tenant-scoped public
  routing is a Phase 3 product decision (not in scope here).

## 11. Refactor plan (executed in this PR)

1. **Schema:** add nullable `tenantId` + two indexes via
   `prisma/migrations/saas_phase29_jobads_tenantid/migration.sql`.
   Reverse migration provided.
2. **Module:** import `FeatureFlagsModule`, provide `TenantPrismaService`
   + `PilotPrismaAccessor`.
3. **Service:** inject `PilotPrismaAccessor`; rename `prisma` →
   `legacyPrisma` (kept for `uniqueSlug` lookup); add `private get prisma()`
   + `private scope() = getPilotScope(this.pilot, 'job-ads')`.
4. Spread `scope.tenantWhere()` into all 9 read sites (findAll,
   findPublished, findBySlug, findOne, uniqueSlug NOT spread); spread
   `scope.tenantData()` into the create payload.
5. Annotate every retained `this.prisma.jobAd.*` line with
   `// @tenant-reviewed: phase29-pilot-scope`.
6. Add `phase29-jobads-extension.sql` to materialise the columns the
   staging fixture lacks + seed two-tenant ads.
7. Build `job-ads-equivalence.ts` (13 cases) and
   `job-ads-isolation.ts` (9 cases) including a public-listing case
   that confirms cross-tenant visibility under no-ALS public traffic.

Acceptance: legacy behaviour unchanged when pilot flag is off OR
module not in allow-list; tenant-safe behaviour proven when scope is
active.
