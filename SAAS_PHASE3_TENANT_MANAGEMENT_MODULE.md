# SaaS Phase 3.15 — Tenant Management Module

Phase 3.15 delivers an operator-facing Tenant Management module on top
of the existing SaaS tenancy + PlatformAdmin authority foundations.

## Architecture

### Backend

* `backend/src/tenants/` — new Nest module:
  * `tenants.controller.ts` — `/tenants` HTTP surface.
  * `tenants.service.ts` — business logic. Branding-scoped fields
    (logo, primaryColor, timezone, locale, contact, address, notes,
    planId, featureFlags, onboardingStatus, archivedAt, deletedAt)
    live in the existing `Tenant.branding Json?` column to avoid a
    schema migration. Hard columns: `name, slug, customDomain,
    status, region, planId`.
  * `platform-tenant.guard.ts` + `@RequireTenantLevel('SUPPORT' | 'OPERATOR' | 'SUPER')`
    — RBAC: loads the caller's `platform_admins` row and rejects
    non-PlatformAdmin users (or any user below the required level).
  * `dto/create-tenant.dto.ts` + `dto/update-tenant.dto.ts` — class-validator
    DTOs.  `slug` is enforced lowercase + URL-safe.
* `backend/src/app.module.ts` registers `TenantsModule`.

Soft-delete model:

| Operation | `status` | `branding.archivedAt` | `branding.deletedAt` |
|---|---|---|---|
| `create`   | `ACTIVE`    | null                  | null                 |
| `archive`  | `SUSPENDED` | now                   | unchanged            |
| `activate` | `ACTIVE`    | null                  | null                 |
| `softDelete` | `INACTIVE` | unchanged            | now                  |
| `restore`  | `ACTIVE`    | null                  | null                 |

The list endpoint hides rows with `branding.deletedAt` unless
`includeDeleted=true` is passed.

`/auth/me` now surfaces `platformAdmin: { level }` so the frontend
can gate the sidebar entry on viewer level.

### Frontend

* `src/app/pages/tenants/`
  * `TenantsList.tsx` — paginated table with search, status filter,
    include-deleted toggle, per-row quick actions
    (view/edit/archive/activate/restore/delete) gated by the
    viewer's PlatformAdmin level.
  * `TenantForm.tsx` — create/edit form with slug auto-generation
    from name, color picker, locale + timezone selectors,
    branding/contact sections.
  * `TenantDetails.tsx` — tabbed profile page (General / Branding /
    Access / Statistics / Feature Flags).
  * `TenantCreate.tsx` + `TenantEdit.tsx` — thin route wrappers.
* `src/app/components/layout/Sidebar.tsx` — adds the **Tenants**
  entry with `platformAdminLevel: 'SUPPORT'`. The new gate filters
  by `viewer.platformAdmin.level` BEFORE the legacy role/permission
  filter, so non-PlatformAdmin users never see the item.
* `src/app/services/api.ts` — new `tenantsApi` (list/get/stats/
  create/update/archive/activate/restore/remove) + extended
  `AuthUser` type with `platformAdmin.level`.
* `src/app/routes.ts` — four new routes under `/dashboard/tenants/*`.

## RBAC matrix

| Operation | SUPPORT | OPERATOR | SUPER |
|---|:-:|:-:|:-:|
| List / View / Stats | ✓ | ✓ | ✓ |
| Update (non-slug)   | — | ✓ | ✓ |
| Archive / Activate  | — | ✓ | ✓ |
| Slug change         | — | — | ✓ |
| Custom domain change | — | ✓ | ✓ |
| Create              | — | — | ✓ |
| Soft delete         | — | — | ✓ |
| Restore             | — | — | ✓ |

Non-PlatformAdmin callers get `403 TENANT.NOT_PLATFORM_ADMIN`.
Under-level callers get `403 TENANT.LEVEL_TOO_LOW`.

## CRUD rules

* `slug` — lowercase, URL-safe (`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`),
  globally unique, **immutable** unless caller is SUPER.
* `customDomain` — validated format, globally unique.
* `softDelete` blocks when active `tenant_memberships` exist
  unless `force=true` query param is passed.
* Every mutation writes a `platform_audit_logs` row tagged with
  the tenant id and the previous/new shape. Failures of the audit
  write are swallowed so the main flow continues — same fail-soft
  contract used by the rest of the SaaS phases.

## Audit events

* `TENANT_CREATED`
* `TENANT_UPDATED`
* `TENANT_STATUS_CHANGED`
* `TENANT_DOMAIN_UPDATED`
* `TENANT_ARCHIVED`
* `TENANT_DELETED`
* `TENANT_RESTORED`

## Sidebar / Navigation

Sidebar adds a **Tenants** item using the new `platformAdminLevel`
gate. The label uses `nav.tenants`. The `nav.platformAdministration`
key is reserved for a future grouping header (no UI grouping yet —
the item renders as a peer of `Settings`).

## i18n coverage

Translation keys added in:

* `src/i18n/locales/{en,ar,de,ru,sk,tr}/nav.json` — `tenants`,
  `platformAdministration`.
* `src/i18n/locales/{en,ar,de,ru,sk,tr,pseudo}/pages.json` — full
  `tenants.*` namespace (list, form, fields, statuses, tabs,
  stats, flags, confirmDialog labels, toast messages).
* Pseudo locale is materialized at runtime from English via the
  existing `pseudoizeTree` helper; the harness still asserts a
  static `pseudo/pages.json` to lock the surface.

RTL: all directional CSS in the new pages uses logical Tailwind
classes (`me-*`, `ms-*`, `ps-*`, `end-*`). No hard-coded
`ml-*` / `mr-*` / `left-*` / `right-*` in tenant pages.

## Harness

`backend/scripts/saas/phase3/tenant-management-module.ts` exercises
the full surface (see file header for the 20-case list).

Run:

```
npm run saas:phase315-tenant-management-module
```

Outputs land in `backend/reports/saas/phase3/tenant-management-module.{json,md}`.

## Rollout

1. Deploy backend + frontend together. The new `TenantsModule` is
   inert for non-PlatformAdmin users (the guard always rejects).
2. Verify `/auth/me` now returns `platformAdmin.level` (existing
   PlatformAdmin viewers will see the new Tenants nav).
3. Bake one release cycle. Monitor:
   * 403 rate on `/tenants/*` (should be ~0 — only PlatformAdmin
     users reach these routes).
   * Sidebar visibility (Tenants must only appear for
     PlatformAdmin viewers).
   * Audit row volume in `platform_audit_logs`.

## Rollback

* Hide the route by reverting the Sidebar entry (one line) — the
  module stays mounted but is unreachable from UI.
* Remove `TenantsModule` from `AppModule.imports` to disable
  the routes entirely.
* No destructive migration in this phase — Tenant rows + audit
  rows are unchanged. Nothing to revert at the schema level.

## Validation

* `npx tsc --noEmit` (backend) — clean.
* `npm run saas:phase315-tenant-management-module` — 20/20 PASS.
* Existing Phase 2/3 harnesses unchanged.
