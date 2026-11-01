# Phase 2.35 — System Agency Decision

> What `Agency.isSystem = true` rows mean for the pilot's read predicate.

---

## 1. Current behaviour (pre-2.35)

- `Agency.isSystem` is a boolean (default `false`).
- The schema comment states: "users attached to an `isSystem=true`
  agency bypass tenancy scoping and see global data".
- `EmployeesService.isExternalActor` and
  `AgenciesService.isExternalActor` use `agencyIsSystem !== true` as
  the marker for an external (non-Tempworks) caller.
- The fixture today has **zero** system agencies.

## 2. Mapping to PlatformAdmin / Tenant model

`Agency.isSystem` is the legacy mechanism for "Tempworks-internal
staff sees everything". The newer `PlatformAdmin` table + `Tenant`
model (Phase 1) is the eventual replacement, but it does not yet
front-end every Tempworks-staff query.

For Phase 2.35 the pragmatic position is: `isSystem=true` agencies
remain visible across tenants. They are platform fixtures that every
tenant has a legitimate reason to enumerate (e.g. "show me the
Tempworks root agency in dropdowns").

## 3. Phase 2.35 read predicate

In pilot mode the read predicate becomes:

```
where: {
  deletedAt: null,
  OR: [
    { tenantId: <ALS tenant> },
    { isSystem: true },
  ],
  ...other filters
}
```

In legacy mode the predicate is the original `where: { deletedAt: null, ... }`.

The `OR isSystem: true` term is the **only** documented departure
from the strict "tenant-scoped reads" pattern used by every other
piloted module so far. It is justified by the system-agency
contract: these rows exist precisely to be visible across tenants.

## 4. What Phase 3 must decide

- Should `Agency.isSystem` be deprecated in favour of a
  platform-only `PlatformAdmin` table?
- Should system agencies live in a separate table entirely, with no
  `tenantId` column?
- Should `isSystem` be replaced by a per-tenant `isDefault` marker
  and a global `Tenant.platformAdminAgencyId` pointer?

These are product decisions out of scope for Phase 2.35.

## 5. Risks if system-agency rows leak into tenant reads

- A system agency carries **no tenant data**, so leakage is informational
  ("there is an agency called Tempworks") and not data-confidential.
- A system agency is still subject to `assertAgencyAccess` for
  external actors — they cannot read its detail unless they belong
  to it.
- The `OR isSystem: true` clause does **not** widen the writes
  (writes are excluded from this phase).

## 6. Decision (this phase)

**Keep system agencies visible in pilot reads via `OR isSystem: true`.**

- Tested explicitly in the isolation harness: a tenant A request
  sees system agencies AND tenant A agencies, but does NOT see
  tenant B agencies.
- Documented as an explicit deviation, not silent.
- Reversible: dropping the `OR isSystem: true` term produces a strict
  per-tenant read; this can ship in Phase 3 once the Tempworks-staff
  flow has migrated off `isSystem` entirely.
