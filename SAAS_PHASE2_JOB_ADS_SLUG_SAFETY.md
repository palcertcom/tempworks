# Phase 2.9 — Job Ads Slug Safety Analysis

> Public-facing records need tenant walls without breaking the front door.

This document analyses the slug uniqueness story for `job_ads` and
specifies the safe transition path from today's globally-unique slug
to a future per-tenant unique slug, without breaking any existing
public URL.

---

## 1. Current slug uniqueness

`prisma/schema.prisma`:

```prisma
model JobAd {
  ...
  slug String @unique
  ...
}
```

DB constraint: `UNIQUE (slug)` — global across all tenants. A second
tenant cannot reuse a slug that any tenant already published.

Service-layer flow (`JobAdsService.uniqueSlug`):

1. Compute base slug from title (`toSlug`).
2. Loop: `findFirst({ where: { slug, deletedAt: null } })`.
3. If found, append `-1`, `-2`, … until unique.

The lookup is intentionally tenant-agnostic (`legacyPrisma` is used)
so the suffix-loop never hands out a slug that the global unique
index would then reject on insert.

## 2. Target SaaS slug strategy

Long-term goal:

```prisma
model JobAd {
  ...
  slug String
  ...
  @@unique([tenantId, slug])
}
```

This lets tenant A publish `engineer-london` AND tenant B publish
`engineer-london` simultaneously, each visible only at the tenant's
public URL.

## 3. Whether slug must become `(tenantId, slug)` later

**Yes, eventually**, for these reasons:

- Tenant isolation: today, tenant A can squat slugs that tenant B
  needs.
- SaaS hostnames: when each tenant gets its own public host (e.g.
  `acme.tempworks.com/jobs/engineer-london`), the slug semantically
  belongs to the host, not the global namespace.
- SEO / link economy: tenants want stable URLs that don't collide
  with siblings.

Phase 2.9 does NOT make this change. It adds the column + composite
index, leaving the global unique in place so today's public URLs
continue to resolve unchanged.

## 4. Public URL impact

Today: `GET /jobs/:slug` → returns the single PUBLISHED row whose
`slug = :slug`. After Phase 3 the slug lookup must additionally
include `tenantId`. Three paths to get there safely:

### Path A: host-based tenant resolver (preferred)

A future middleware reads the `Host` header (or path prefix) and
attaches the resolved tenant to ALS for the public request. The
existing service code then automatically narrows to that tenant
because `scope.tenantWhere()` is already spread into `findBySlug`'s
`where`. No service code change is needed.

### Path B: explicit tenant-id in path

Add `/jobs/:tenant/:slug` and 301-redirect the legacy `/jobs/:slug`
URLs to the new shape using a one-time URL-mapping table.

### Path C: tenant-id query param

A weaker cousin of Path B, only used as a fallback for environments
where the host resolver isn't yet available.

Phase 2.9 doesn't choose a path; that's a product decision in Phase 3.

## 5. Collision risks during tenant migration

When Phase 3 swaps to `@@unique([tenantId, slug])`:

- Rows with `tenantId IS NULL` (legacy, pre-pilot inserts) will all
  collide on the new composite if any two share a slug under a NULL
  tenant. Mitigation: backfill `tenantId` on every legacy row before
  the unique swap (out of scope for Phase 2.9 — handled by a future
  backfill).
- Rows where two tenants happen to share a slug today are impossible:
  the existing global unique already rules this out. So zero
  cross-tenant collisions exist today.
- The Phase 3 migration MUST run as:
  1. Backfill `tenantId` on every legacy `tenantId IS NULL` row.
  2. Verify no `(tenantId, slug)` pair has duplicates.
  3. Drop `slug @unique`.
  4. Add `@@unique([tenantId, slug])`.

## 6. Safe transition plan without breaking public links

| Step | Action | Risk |
|------|--------|------|
| 1 (this PR) | Add nullable `tenantId` + composite index `(tenantId, slug)`. Service writes `tenantId` from ALS for new ads when pilot is active. | None — additive only. |
| 2 (Phase 2.9 + 2.5 staging rehearsal) | Rehearse the pilot in SAFE_STAGING. Verify per-tenant counts and the public listing's intentional cross-tenant visibility. | None — flag-gated. |
| 3 (Phase 3 prep) | Backfill `tenantId` for every legacy `JobAd` row. Run a duplicate-slug detector across `(tenantId, slug)`. | Backfill correctness — caught by the verifier. |
| 4 (Phase 3 cutover) | Add the host-based public resolver. Service automatically narrows public lookups via the existing `scope.tenantWhere()` spread. | Public URLs continue to resolve since the service still accepts the slug; the resolver attaches the tenant. |
| 5 (Phase 3 unique swap) | Drop global `slug @unique`, add `@@unique([tenantId, slug])`. Apply only after step 3 is green. | Migration sequenced AFTER backfill, so no insert constraint failures. |
| 6 (Phase 4) | Allow tenants to use overlapping slugs. UI surfaces same-slug-different-tenant clearly. | Documentation + UX. |

## 7. Public-link guarantee for Phase 2.9

After this PR:
- Every existing public URL `/jobs/:slug` still resolves to the same
  `JobAd` row it did before (the global `slug @unique` is unchanged).
- The pilot's `findBySlug` lookup spreads `scope.tenantWhere()`, but
  public traffic carries no tenant in ALS, so the spread is `{}` —
  the lookup is still global.
- New ads created under the pilot in staging carry a `tenantId`
  alongside their globally-unique slug; the slug is suffixed by the
  service if a base collision exists, exactly as before.

No public link breaks. No SEO impact. No URL redirects required.

## 8. Operator-visible warnings

- A pilot operator who creates two ads with the same desired slug
  across two tenants will see the second one auto-suffixed (`-1`).
  This is the pre-pilot behaviour preserved verbatim. The operator
  is told via the response payload's `slug` field.
- A future Phase 3 migration that tries to apply the composite
  unique without a backfill of legacy NULL-tenant rows will fail at
  migration time. The recommended order in §6 prevents this; the
  Phase 3 PR should include a precondition assertion.
