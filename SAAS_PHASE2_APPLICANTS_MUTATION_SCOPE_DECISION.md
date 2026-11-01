# Phase 2.29 — Applicants Mutation Scope Decision

> Per-method classification for the Phase 2.29 mutation pilot.

---

## Classification

| Method | Class | Justification |
|--------|-------|---------------|
| `create` | **INCLUDED_NOW** | Spread `scope.tenantData()` into create data. Caller-supplied agency stays unchanged. |
| `update` | **INCLUDED_WITH_GUARD** | Parent gate via `findApplicantOrFail`; by-id update never reaches foreign tenant. Email dup-check stays global (`phase228-global`). |
| `remove` | **INCLUDED_WITH_GUARD** | Same parent gate; soft-delete by id. |
| `updateStatus` / `approveApplicant` / `rejectApplicant` | **INCLUDED_WITH_GUARD** | Same parent gate; by-id status update. |
| `setCurrentStage` | **INCLUDED_WITH_GUARD** | Parent gate; StageTemplate stays global catalog (Phase 2.26). |
| `upsertFinancialProfile` | **INCLUDED_WITH_GUARD** | Already calls `findOne` (Phase 2.28 tenant-scoped). Just retag. |
| `convertLeadToCandidate` | **INCLUDED_WITH_GUARD** | Parent gate + NEW `findAgencyOrFail` for target agency. Multi-row transactional behaviour preserved. |
| `reassignAgency` | **INCLUDED_WITH_GUARD** | Parent gate + agency gate. |
| `bulkAction` | **INCLUDED_WITH_BULK_FILTER** | Pre-filter `dto.applicantIds[]` via `applicant.findMany({ id: { in }, ...t })` BEFORE the per-id loop. Cross-tenant ids silently dropped. |
| `convertToEmployee` | **INCLUDED_WITH_GUARD** | Parent applicant gate + spread `scope.tenantData()` into the `employee.create`. Document/FinancialRecord cross-module `updateMany` filter by `entityType + entityId` which the gated applicant guarantees is tenant A. **Conversion semantics UNCHANGED.** |
| `requestDelete` | **INCLUDED_WITH_GUARD** | Parent gate via `findApplicantOrFail`. |
| `reviewDeleteRequest` | **INCLUDED_WITH_GUARD** | NEW pre-check via `this.prisma.candidateDeleteRequest.findFirst({ id, applicant: { ...t } })` relation filter (no tenantId column on CandidateDeleteRequest). |
| `publicSubmit` | **DEFERRED_PUBLIC_ENTRY** | Public form runs WITHOUT an ALS tenant frame. Defaulting tenant pin requires product input (which tenant owns a public submission?). Stays `phase228-excluded-mutation`. |
| `uploadPhoto` | **DEFERRED_HIGH_RISK** | Storage upload precedes tenant gate; needs Phase 2.30+ storage-guard pattern. |
| `auditLog.create` (helper) | **LEGACY_ONLY** | Global by design; cross-module audit-log tenancy phase. |
| Email duplicate-check | **LEGACY_ONLY** (`phase228-global`) | `Applicant.email @unique` stays globally unique (Phase 3 product question). |
| Raw SQL identifier generators | **LEGACY_ONLY** (`phase228-global`) | Sequence ID generation; no tenant data read. |

## Rationale — INCLUDED_NOW (`create`)

Single-row insert; spread `scope.tenantData()` so the new
applicant carries `tenantId = ALS.id` in pilot mode. Legacy mode
unchanged.

## Rationale — INCLUDED_WITH_GUARD

Each of these calls had a by-id `findUnique` (or no pre-check at
all, e.g. `updateStatus`). Phase 2.29 gates them with
`findApplicantOrFail` so cross-tenant ids raise 404 BEFORE any
mutation. Legacy mode reduces the helper to plain by-id lookup.

## Rationale — INCLUDED_WITH_BULK_FILTER (`bulkAction`)

`bulkAction` accepts `dto.applicantIds: string[]` and iterates.
Today the per-id branching has no tenant filter — a tenant-A
caller could include tenant-B ids in the list and mutate them.

Phase 2.29 adds:

```ts
const t = this.scope().tenantWhere();
const allowed = await this.prisma.applicant.findMany({
  where: { id: { in: dto.applicantIds }, deletedAt: null, ...t },
  select: { id: true },
});
const allowedIds = new Set(allowed.map(a => a.id));
const filtered = dto.applicantIds.filter(id => allowedIds.has(id));
// proceed with `filtered` instead of `dto.applicantIds`
```

In legacy mode `tenantWhere()` returns `{}` and `filtered ===
dto.applicantIds` (modulo soft-deleted rows). In pilot mode
foreign ids are silently dropped — same shape as documents 2.22
download-guard.

## Rationale — INCLUDED_WITH_GUARD + tenantData (`convertToEmployee`)

Most sensitive path. Phase 2.29 changes:

1. Parent applicant gate via `findApplicantOrFail(id)` BEFORE the
   transaction begins.
2. Spread `scope.tenantData()` into the `employee.create.data`
   (Employee.tenantId already exists from Phase 2.3 denorm).
3. Existing `document.updateMany({ where: { entityType: 'APPLICANT', entityId: id } })`
   and `financialRecord.updateMany` stay legacy — they're
   filtered by entity which is the gated applicant.

Conversion business semantics unchanged.

## Rationale — DEFERRED_PUBLIC_ENTRY (`publicSubmit`)

Public form has NO ALS tenant frame. Pilot scope is inactive.
Three options for Phase 2.30+:
1. Default-tenant pin via env config (operational, not a code change).
2. Resolve tenant from `dto.agencyId → agency.tenantId`.
3. Reject submissions without explicit tenant attribution.

All three need product input. Phase 2.29 stays
`phase228-excluded-mutation`.

## Rationale — DEFERRED_HIGH_RISK (`uploadPhoto`)

Storage upload runs BEFORE the DB update with no tenant gate
today. Mirrors documents `addDocument` pre-2.21. Phase 2.30+
will land the storage-guard pattern.

## Out-of-scope safeguards

- No schema change.
- No new feature flag.
- No `Applicant.email @unique` change.
- No identifier-generator semantics change.
- No conversion architecture redesign.
- No notification rewrites.
- No cross-module audit log (separate phase).
