# Phase 2.15 — Notifications Fanout Writer Audit

> Pre-narrowing audit of `notifyUploaderAndRoles` and `notifyUsersByRoles`.
> Phase 2.14 added the assertion guards. Phase 2.15 narrows the
> internal scans + creates.

---

## 1. `notifyUploaderAndRoles`

| Aspect | Detail |
|---|---|
| Signature | `(uploaderId, roles[], eventKey, title, message, relatedEntity?, relatedEntityId?, i18n?) → Promise<void>` |
| Callers | document upload (`notifyDocumentUploaded`), pipeline notifications, finance flows |
| Role/user query | `User.findMany({ where: { role: { name: { in: roles } }, status: 'ACTIVE' }, select: { id: true } })` — global today |
| Uploader | added directly by id; no tenant validation today |
| Notification create | one row per recipient; `relatedEntity` defaults to `'Document'` |
| Global scan risk | a fanout from tenant A reaches tenant B users with the same role |
| Tenant ownership path | User → Agency → Tenant (User has no `tenantId` column) |
| Required tenant filter | `agency: { tenantId: tid }` on User scan; `tenantId: tid` on create |
| Caller contract | HTTP requests today come with no obligation to attach a tenant. After 2.15, in tenant-aware mode, callers without tenant context are refused. |
| Risk level | medium — wide caller fan-out across modules; legacy mode untouched |
| Refactor approach | (a) `narrowingTenantId()` once at top; (b) when active, validate uploader belongs to the active tenant via a `findFirst` probe; (c) spread `agency: { tenantId: tid }` into the role scan; (d) spread `tenantId: tid` into the create payload |

## 2. `notifyUsersByRoles`

| Aspect | Detail |
|---|---|
| Signature | `(roles[], eventKey, title, message, relatedEntity?, relatedEntityId?, i18n?) → Promise<void>` |
| Callers | non-uploader cross-cutting events (e.g. compliance officer alerts) |
| Role/user query | identical shape to 2.1 — global today |
| Notification create | one row per recipient |
| Global scan risk | same as 2.1 |
| Tenant ownership path | same as 2.1 |
| Required tenant filter | same as 2.1 |
| Caller contract | same as 2.1 |
| Risk level | medium |
| Refactor approach | same as 2.1 minus the uploader probe (no uploader argument) |

## 3. Helper reuse

Phase 2.14.1's `narrowingTenantId()` is reused unchanged. Returns:

- the active tenant id when both flags are on AND env is staging-
  classified AND ALS has a tenant.
- `null` otherwise — every spread becomes `{}`, legacy behaviour
  byte-identical.

## 4. Annotation tag

New tag `phase215-pilot-scope` (allowed in `src/notifications/**`).
Each modified site previously annotated `phase210-excluded-background`
moves to `phase215-pilot-scope`. Three writer-internal sites land on
this tag (one in `notifyUsersByRoles`, two in `notifyUploaderAndRoles`
including the new uploader probe).

## 5. Scope NOT in this PR

- Caller-side changes (e.g. document uploads explicitly passing
  `tenantId`). The writers read tenant from ALS — no caller change is
  needed because every caller already runs inside a request middleware
  that attaches a tenant.
- Email / SMS / push delivery workers. Out of scope; deferred to
  Phase 3.
- Migration of `Notification.tenantId` for legacy NULL-tenant rows.
  Same Phase 3 backfill that Phase 2.14.1 flagged.

## 6. Risks after Phase 2.15

- **Cross-tenant role fanout in tenant-aware mode is now blocked.**
  Production today does not have shared roles across tenants, so no
  observable change is expected. Legacy mode preserves the old
  behaviour for safety.
- **Uploader probe adds one extra DB round-trip** per call when
  tenant-aware mode is active. Worst case ~5ms; negligible for non-
  hot paths. The legacy mode skips the probe.
- **Uploader from another tenant is silently dropped** (rather than
  raising). Rationale: callers never have a legitimate reason to pass
  a cross-tenant uploader; raising would surface as 500s in odd
  edge cases that the pilot doesn't yet have rich diagnostics for.
  This matches the existing pattern of the `roles[]` filter — users
  not matching the role are silently ignored.
