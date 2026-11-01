# Phase 2.9 — Job Ads Pilot Results

> Third tenant-scoped pilot. First to ship a schema change (additive
> nullable `tenantId`) alongside the service refactor. First with
> public-facing URLs that must keep working.

---

## 1. Headline

```
build:                                           ✅
prisma validate:                                 ✅
saas:validate (6 suites):                        ✅
saas:schema-lint:                                 ✅
saas:phase2-job-ads-equivalence:                 13/13 cases PASS
saas:phase2-job-ads-isolation:                    9/9  cases PASS
saas:phase2-compliance-equivalence (regression): 12/12 cases PASS
saas:phase2-compliance-isolation  (regression):   7/7  cases PASS
saas:phase2-ewh-equivalence       (regression):  12/12 cases PASS
saas:phase2-ewh-isolation         (regression):   8/8  cases PASS
saas:scan:                                       786 unreviewed (down from 795)
saas:scan:raw-sql:                               baseline unchanged
production defaults:                             all OFF
```

## 2. What was tested

### Equivalence (13/13 PASS)

- Pilot active state under flag combinations.
- `findAll` total: pilot < legacy (cross-tenant rows filtered).
- `findPublished` total: pilot ≤ legacy (public listing preserves
  cross-tenant visibility when no ALS tenant).
- `findBySlug(tenantA-slug)`: legacy and pilot resolve the SAME id.
- `findOne(tenantA-id)`: both modes resolve to tenantA.
- Error path: missing id raises `NotFoundException` in both modes.
- `create` legacy persists `tenantId=NULL`; pilot persists
  `tenantId=tenantA`; both produce non-empty slugs.
- `update` reflects new title in both modes (auto-slug regenerated).
- `remove` sets `deletedAt` in both modes.
- Response shape preserved (`PaginatedResponse<JobAd>`).

### Isolation (9/9 PASS)

- Pilot ON tenant A: `findAll` returns ONLY tenant A rows; tenant B
  ads and the NULL-tenant legacy row excluded.
- Pilot ON tenant A: `findOne(tenantB-id)` raises `NotFoundException`.
- Pilot ON tenant A: `update(tenantB-id)` rejected; row's title
  unchanged.
- Pilot ON tenant A: `remove(tenantB-id)` rejected; `deletedAt`
  remains NULL.
- Pilot ON tenant A: `create` persists `tenantId=A`.
- Same-slug request in two tenants: service auto-suffixes; both
  inserts succeed and carry the correct tenantId. The legacy global
  `slug @unique` is honoured throughout.
- Public listing (no ALS tenant): includes ads from ALL tenants —
  preserves public URL semantics.
- Concurrent ALS frames: T_A no B-rows, T_B no A-rows.
- Pilot OFF: legacy returns the union (tenant B + NULL-tenant
  included).

## 3. Schema changes

`prisma/schema.prisma`:

```prisma
model JobAd {
  ...
  tenantId   String?
  @@index([tenantId])
  @@index([tenantId, slug])
  ...
}
```

Migration: `prisma/migrations/saas_phase29_jobads_tenantid/migration.sql`
adds the column + indexes idempotently. `migration.down.sql` reverses.
The existing `slug @unique` global constraint is preserved exactly —
public URLs continue to resolve unchanged.

## 4. Slug safety summary

See `SAAS_PHASE2_JOB_ADS_SLUG_SAFETY.md` for the full plan. Key points
for Phase 2.9:

- Schema's `slug @unique` (global) is unchanged.
- `uniqueSlug()` lookup intentionally tenant-agnostic — the suffix-
  loop matches the global constraint so inserts never fail with P2002.
- `findBySlug` spreads `scope.tenantWhere()` for forward-compat with a
  future host-based public resolver (Phase 3); today public traffic
  has no ALS tenant, so the lookup stays global.
- Phase 3 will swap to a composite `(tenantId, slug)` unique only
  AFTER a NULL-tenant backfill. This PR is strictly additive.

## 5. Lessons learned

1. **Add the column before the service.** Phase 2.7 (EWH) and 2.8
   (compliance) refactored services whose tables already had `tenantId`
   from Phase 2.3. Phase 2.9 added the column itself. The right
   sequence is: schema migration first → fixture extension second →
   service refactor third → harness last. Doing it backwards is a
   recipe for "Prisma client doesn't know the field" errors.
2. **Public endpoints fall out cleanly.** Public traffic has no ALS
   tenant, so `getPilotScope` returns inactive and the spread is `{}`
   automatically. No code branch needed; the pattern Just Works.
3. **Slug suffixing must remain tenant-agnostic** while the DB unique
   is global. The `legacyPrisma` injection (kept for the audit log in
   prior phases) doubles as the slug-uniqueness probe here.
4. **Cross-tenant slug collision is a Phase 3 product decision.** The
   pilot doesn't try to allow `engineer-london` in two tenants today;
   it just makes sure adding `tenantId` doesn't break the slug story.
5. **Migration applier choice.** This PR uses `psql -f` directly to
   apply the migration to the staging fixture (matching Phase 2.3's
   tolerant DO-block style). The Prisma migrate engine is not invoked
   on staging fixtures.

## 6. Whether the pattern remains reusable

**Yes.** The Phase 2.7 + 2.8 pattern (`PilotPrismaAccessor` +
`getPilotScope(pilot, moduleName)` + `tenantWhere()` / `tenantData()`
spreads) handles a third module without modification. The new
ingredients in Phase 2.9 are:

- A schema migration that adds nullable `tenantId` (already a Phase 2.3
  pattern).
- A public-endpoint scope-spread that's a no-op without ALS tenant
  (a property of the existing helper, not a new feature).
- A slug uniqueness probe routed through `legacyPrisma` (precedent: the
  audit log split in EWH and compliance).

No new helpers were added. No flags were added. The architecture
holds.

## 7. Risks before next module

- **Legacy NULL-tenant rows accumulate** until Phase 3's backfill runs
  on production. New ads created under the pilot have `tenantId` set;
  pre-pilot ads don't. The dashboard's tenant filter intentionally
  hides them in pilot mode — operators of staging clones see this
  immediately.
- **`generateAlerts`-style background jobs** that touch `JobAd` need a
  tenant context if they want to write `tenantId`. Today no such job
  exists for `JobAd`, but a future scheduler should attach a tenant
  before invoking the service.
- **`uniqueSlug` race condition** is unchanged from pre-pilot: the
  loop reads then writes; two concurrent creates can both pick `-1`
  and one will fail with P2002. The pilot doesn't introduce or fix
  this; it's a pre-existing latent bug. Recommended Phase 3 fix:
  retry on P2002 with a fresh suffix.
- **Public listing tenant scope** is currently a no-op (no ALS tenant
  on public traffic). Phase 3 host-based resolver will activate it
  automatically; before that lands, plan the URL strategy
  (see slug safety doc).

## 8. Next recommended module

`src/notifications` (read-only views of notification rules + recent
notifications) is the natural fourth pilot. Has its own `tenantId`
(Phase 2.3 denorm). Read-mostly with limited mutation surface.

Backups:
- `src/recycle-bin` — small, read-mostly.
- Splitting `src/vehicles` into reads-first / mutations-second.

## 9. Production behaviour change status

**Unchanged.** With `TENANT_PRISMA_PILOT_ENABLED=false` (default),
`getPilotScope()` returns inactive and the spreads are no-ops. The
schema migration is additive (nullable column + two indexes), so it
neither alters nor removes any existing column / constraint. Public
URLs continue to resolve byte-identically. Legacy reports engine and
legacy Prisma access path untouched.
