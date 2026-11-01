# Phase 2.17.1 — Finance Helper Enrichment Review

> Three helpers used `legacyPrisma`. Two were structurally safe;
> one had a real cross-tenant create vulnerability. This phase
> closes the vulnerability and adds defence in depth on the others.

---

## 1. Helpers in scope

| Helper | Callers | Used at |
|--------|---------|---------|
| `attachEntityNames(records)` | `findAll`, `getPersonRecords` | post-read enrichment |
| `resolvePersonIdentity(entityType, entityId)` | `create` | pre-insert validation |
| `resolveEntityNameForNotif(entityType, entityId)` | `create`, `update`, `remove`, `updateStatus`, `addDeduction` | notification body |

## 2. Pre-2.17.1 risk per helper

### 2.1 `attachEntityNames` — LOW

Called after the records list is already tenant-filtered (Phase
2.16). The `entityIds` it sees come exclusively from records the
tenant is authorised to read. A cross-tenant leak would require a
record's `entityId` FK to point at an entity in a different tenant
— possible only via a corrupt insert. Phase 2.17 already narrowed
the create path's `tenantData()` spread, so newly-created records
carry the active tenant's id; the attached entity is still subject
to the create-time validation in `resolvePersonIdentity`.

### 2.2 `resolvePersonIdentity` — **HIGH (real bug)**

Called by `create` BEFORE the new record exists. The caller passes
`entityType + entityId`. The helper looked up the entity by ID
**without** a tenant predicate. In pilot mode, a tenant-A caller
could pass a tenant-B `entityId`; the helper would resolve it
successfully; `create` would then persist a financial record with
`tenantId=A` but `entityId` pointing at a tenant-B entity.

The record would be invisible to tenant B (their `tenantWhere()`
filter excludes it) and visible to tenant A (matching `tenantId`).
The result: tenant A's ledger would carry a row about a foreign
person — accounting pollution + an information disclosure path
(tenant A could read a tenant-B name back through
`resolveEntityNameForNotif` if it joined to the entity).

This is a real bug in pilot mode, found by review of Phase 2.17's
audit. Fix: switch the lookups to `this.prisma.X.findFirst({
where: { id, ...t } })`. In pilot mode, cross-tenant entityIds
raise `NotFoundException`. Legacy mode (`t = {}`) is unchanged.

### 2.3 `resolveEntityNameForNotif` — LOW

Called AFTER mutations. Its `entityId` arrives either from the
caller's DTO (in `create`, but `resolvePersonIdentity` has already
authorised it) or from `existing.entityType / existing.entityId`
(loaded via the tenant-scoped `findOne`). Cross-tenant exposure is
already prevented by callers. Defence in depth: narrow the
lookups to `this.prisma.X.findFirst({ where: { id, ...t } })` so a
future caller cannot bypass the authorisation chain by reaching
in directly.

## 3. Implementation in 2.17.1

All three helpers now route through `this.prisma` (the pilot-aware
client) and spread `this.scope().tenantWhere()` into their `where`
clauses. New annotation tag: `phase2171-helper-narrowed`.

Behaviour matrix:

| Mode | Lookup |
|------|--------|
| Pilot OFF (production default) | `where: { id }` — same as pre-2.17.1 |
| Pilot ON, ALS attached | `where: { id, tenantId: <ALS> }` — cross-tenant ids return null |
| Pilot ON, no ALS tenant | `tenantWhere()` returns `{}` (legacy fallback) — `where: { id }` |

The schema spread is purely additive: removing the tenant filter
returns the legacy result. Production behaviour is unchanged.

## 4. Test coverage

`finance-mutation-isolation` adds two new cases:

- **case 9**: pilot ON, tenant A: `create` with `entityId`
  pointing at a tenant-B employee raises `NotFoundException`. No
  financial record is inserted; no audit log; no notification.
- **case 10**: pilot ON, tenant A: `update` ignores any smuggled
  `entityType` / `entityId` / `applicantId` / `stageAtCreation`
  passed via `as any`; the persisted row's identity columns are
  unchanged. Validates the Phase 2.17.1 defensive scrub in
  `update`.

`finance-isolation` (read-side) is unchanged — the helpers run
only inside read flows that were already tenant-filtered.

## 5. Production safety

Production flag default `TENANT_PRISMA_PILOT_ENABLED=false`. With
that off, `tenantWhere()` returns `{}` and all three helpers
behave exactly as in legacy. No new field is required, no DTO
breaks, no migration. The change is a same-process spread
narrowing.

## 6. Unresolved follow-ups

- ~~The fixture's `applicants.tier` column is required by
  `resolvePersonIdentity` for APPLICANT entityType; the harness
  exercises EMPLOYEE entities only. A future phase should add an
  applicant-typed cross-tenant create case.~~ **Closed in
  Phase 2.18** — see
  `SAAS_PHASE218_FINANCE_APPLICANT_HELPER_COVERAGE.md`. Three new
  isolation cases (11, 12, 13) cover APPLICANT cross-tenant
  rejection, same-tenant success, and update-path notification
  helper safety. 13/13 pass on real DB.
- **Phase 2.19** added cases 14, 15, 16 covering the AGENCY
  branch: cross-tenant rejection / same-tenant success / update-
  path notif-helper safety. The per-entity coverage matrix is
  complete (EMPLOYEE + APPLICANT + AGENCY all proven on real DB).
  See `SAAS_PHASE219_FINANCE_AGENCY_HELPER_COVERAGE.md`. 16/16
  isolation cases pass; 41/41 finance harness cases overall.
- `getPersonRecords` already calls `findFirst` with tenant filter
  (Phase 2.16). It is unaffected by 2.17.1.
- `checkAndNotifyHighBalance` (background path) remains
  `DEFERRED_HIGH_RISK`.
