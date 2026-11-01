# Phase 2.17 — Finance Mutation Scope Decision

> Per-method classification for the Phase 2.17 mutation pilot.
> A method must reach **INCLUDED_NOW** or **INCLUDED_WITH_GUARD**
> only if its tenant behavior is provable in the harnesses.

---

## Classification

| Method | Class | Reason |
|--------|-------|--------|
| `create` | **INCLUDED_NOW** | Spread `scope.tenantData()` into create data; pilot mode persists `tenantId`. |
| `update` | **INCLUDED_WITH_GUARD** | Pre-check via tenant-scoped `findOne` (Phase 2.16); the by-id update never executes for cross-tenant ids. |
| `remove` | **INCLUDED_WITH_GUARD** | Same `findOne` gate; cross-tenant soft-delete cannot reach the update statement. |
| `updateStatus` | **INCLUDED_WITH_GUARD** | Same `findOne` gate; status flip never reaches a foreign row. |
| `addDeduction` | **INCLUDED_WITH_GUARD** | Same `findOne` gate; child deduction insert and parent recomputation only target authorized record. |
| `addAttachment` | **INCLUDED_WITH_GUARD** | Same `findOne` gate; storage upload + child insert only after tenant authorization. |
| `removeAttachment` | **INCLUDED_WITH_GUARD** | `findOne(recordId)` tenant gate plus `financialRecordId` predicate on attachment lookup. |
| `removeDeduction` | **INCLUDED_NOW** | Adds a NEW parent-record tenant pre-check (`findFirst` with `tenantWhere`) before child deletion. Closes a pre-existing cross-tenant gap. |
| `auditLog` (helper) | **LEGACY_ONLY** | Global by design (`AuditLog` has no `tenantId`); deferred to a cross-module audit phase. |
| `checkAndNotifyHighBalance` (helper write path) | **DEFERRED_HIGH_RISK** | Fire-and-forget background; scheduler/job-context engagement is a separate phase. |
| Entity-name enrichment helpers (`attachEntityNames`, `resolvePersonIdentity`, `resolveEntityNameForNotif`) | **LEGACY_ONLY** (this phase) | Reads only; tighten later. |

## Rationale — INCLUDED_WITH_GUARD

The Phase 2.16 read pilot made `findOne` tenant-scoped. Every
mutation listed under INCLUDED_WITH_GUARD calls `findOne(id)` (or
`findOne(recordId)`) before issuing its `legacyPrisma.update` /
`create` / soft-delete. In pilot mode that pre-check raises
`NotFoundException` for cross-tenant ids, so the by-id mutation
never reaches Prisma. In legacy mode the pre-check still runs and
behavior is byte-identical to pre-2.16.

This pattern requires no Prisma `update` API change. Prisma's
`update({ where })` only accepts a unique key; we cannot append a
`tenantId` predicate without using `updateMany`. Switching to
`updateMany` would change the response shape (return count, not
row) and is therefore deliberately avoided.

The isolation harness asserts the tenant gate by attempting a
cross-tenant `update` / `remove` / `updateStatus` / `addDeduction`
/ `addAttachment` / `removeAttachment` from tenant A on a tenant B
record id and verifying that:

1. `NotFoundException` is raised, and
2. the target row in tenant B is unchanged after the attempt
   (pre-check fired before any `update` reached Prisma).

## Rationale — INCLUDED_NOW for `removeDeduction`

`removeDeduction` is unique among the mutations: it accepts a
`deductionId`, not a parent `recordId`. There is no existing
`findOne` pre-check on the parent. Today, a caller in tenant A
can pass a deduction id from tenant B and the service will delete
it.

Phase 2.17 closes this by:

```ts
const parent = await this.prisma.financialRecord.findFirst({
  where: { id: deduction.financialRecordId, ...this.scope().tenantWhere() },
  select: { id: true },
});
if (!parent) throw new NotFoundException('Deduction not found');
```

In pilot mode this raises 404; in legacy mode the spread is `{}`
and the lookup matches by id alone — same behavior as before.

## Rationale — DEFERRED_HIGH_RISK

`checkAndNotifyHighBalance` runs as a fire-and-forget read+notify
chain. Its scheduler/job-context engagement requires the
Phase 2.13 framework (`runForTenant`) to wrap the call. That is
a separable change from per-method mutation narrowing; deferring
it keeps the Phase 2.17 surface tight.

## Rationale — LEGACY_ONLY

`auditLog.create` is intentionally tenant-less in the current
schema. Adding `tenantId` to `AuditLog` is a wide refactor (every
audit-emitting service) and belongs to a cross-module audit phase.

Entity-name enrichment helpers (`attachEntityNames` etc.) are
reads called from already tenant-filtered records. Tightening
them is non-trivial (they accept arrays of mixed entity types) and
not strictly required for ledger isolation. Deferred.

## Phase 2.17.1 addendum — helper enrichment narrowed

The Phase 2.17 review left three finance helpers (`attachEntityNames`,
`resolvePersonIdentity`, `resolveEntityNameForNotif`) on
`legacyPrisma`. The 2.17.1 execution-on-real-DB review elevated
`resolvePersonIdentity` from LEGACY_ONLY to **INCLUDED_NOW**: it
had a real cross-tenant create vulnerability when the pilot was
active. The other two were narrowed defensively in the same pass.
Tag: `phase2171-helper-narrowed`.

`update` also got a one-shot defensive scrub of
`entityType`/`entityId`/`applicantId`/`stageAtCreation` to keep
the cross-entity invariant intact even if a future DTO refactor
re-introduced those fields. See
`SAAS_PHASE2171_FINANCE_CROSS_ENTITY_GUARD_REVIEW.md`.

## Out-of-scope safeguards

- No schema change.
- No new feature flag.
- No change to `auditLog`.
- No change to notification fanout (Phase 2.15 already covers it).
- No `updateMany`-based rewrites that would alter response shape.
- No removal of legacy paths.
