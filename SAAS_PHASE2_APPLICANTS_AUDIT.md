# Phase 2.28 — Applicants Module Audit

> Inventory of every Prisma touchpoint in `src/applicants` plus
> the read/write split for the Phase 2.28 reads-first pilot.

---

## 1. Module surface

| File | Role | Lines |
|------|------|------:|
| `src/applicants/applicants.service.ts` | business logic | 1222 |
| `src/applicants/applicants.controller.ts` | HTTP surface | 313 |
| `src/applicants/applicants.module.ts` | Nest wiring | 12 |

Total Prisma sites: **53**.

## 2. Models touched — tenancy map

| Model | Has `tenantId`? | Treatment |
|-------|:---:|-----------|
| `Applicant` | ✓ | Phase 2.3 denorm; primary entity |
| `ApplicantFinancialProfile` | – | child of Applicant; parent-gated |
| `ApplicantAgencyHistory` | – | child of Applicant; parent-gated |
| `CandidateDeleteRequest` | – | child of Applicant; parent-gated |
| `Agency` | ✓ | catalog/parent (Phase 2.3 denorm) |
| `StageTemplate` | – | global catalog (Phase 2.26 decision) |
| `SystemSetting` | – | global |
| `Employee` | ✓ | reads (conversion target lookup) |
| `Document` | ✓ | reads/writes (conversion side effect) |
| `FinancialRecord` | ✓ | reads/writes (conversion side effect) |
| `AuditLog` | – | global by design |

## 3. Read paths — INCLUDED in Phase 2.28

| # | Method | Operation | Tenant filter |
|--:|--------|-----------|---------------|
| 1 | `findAll` | `applicant.findMany` + count | `where.tenantId` (pilot) |
| 2 | `findOne` | `applicant.findUnique` → `findFirst` | id + tenantId |
| 3 | `getFinancialProfile` | `applicantFinancialProfile.findUnique` | parent-gated via NEW `findApplicantOrFail` |
| 4 | `getAgencyHistory` | `applicantAgencyHistory.findMany` | parent-gated via NEW `findApplicantOrFail` |
| 5 | `exportCsv` | `applicant.findMany` | `where.tenantId` |
| 6 | `exportExcel` | `applicant.findMany` | `where.tenantId` |
| 7 | `getDeleteRequests` | `candidateDeleteRequest.findMany` + count | candidate must belong to active tenant — narrow via `candidate: { tenantId }` relation filter |

## 4. Catalog/global reads — `phase228-global`

| Method | Operation | Note |
|--------|-----------|------|
| `setCurrentStage` (mutation) | `stageTemplate.findUnique` | Phase 2.26 — global catalog |
| `convertLeadToCandidate` (mutation) | `systemSetting.findUnique` | global |
| Email duplicate-check in `update` | `applicant.findFirst({ email, NOT: { id } })` | **stays global** — Phase 2 keeps email-uniqueness behaviour. The check is on the legacy path; new mutations stay legacy. |

## 5. External actor (agency-scoped) behaviour — UNCHANGED

`findAll` and `findOne` already apply an external-actor agency
filter:

```ts
if (actor && this.isExternalActor(actor) && actor.agencyId) {
  where.agencyId = actor.agencyId;
}
```

Phase 2.28 keeps this behaviour exactly. The pilot tenant
spread is **additive**: `where.tenantId = ALS` AND
`where.agencyId = actor.agencyId`. External actors keep their
existing agency-scope; pilot mode adds a tenant filter on top.

## 6. Mutation paths — EXCLUDED from Phase 2.28

| Method | Reason |
|--------|--------|
| `create` | applicant create + agency lookup; Phase 2.29+ |
| `update` | applicant update + email dup-check |
| `uploadPhoto` | storage upload; Phase 2.30+ |
| `updateStatus` | status mutation |
| `remove` | soft-delete |
| `publicSubmit` | public form path; Phase 2.29+ |
| `setCurrentStage` | workflow stage assignment |
| `approveApplicant` / `rejectApplicant` | status flow |
| `convertLeadToCandidate` | transactional conversion |
| `reassignAgency` | agency reassignment + history insert |
| `upsertFinancialProfile` | profile mutation |
| `bulkAction` | bulk mutation operations |
| `convertToEmployee` | huge transactional conversion (Document.updateMany, FinancialRecord.updateMany, applicant + employee writes) |
| `requestDelete` | candidate delete request |
| `reviewDeleteRequest` | approve/reject delete |
| `auditLog` (helper) | global audit log |
| `generateIdentifier` | raw SQL ID generator |

## 7. Cross-module mutation side effects (DEFERRED)

`convertToEmployee` writes:
- `employee.create` (creates new tenant employee)
- `document.updateMany` (re-points entityType/entityId to EMPLOYEE)
- `financialRecord.updateMany` (re-points entityType/entityId)
- `applicant.update` (sets `convertedToEmployeeId`, `deletedAt`)

Each of these target rows that should belong to the same tenant.
The cross-module write is gated structurally (tenant A's
applicant shouldn't have tenant B's documents/records linked
today). Phase 2.29+ will land the mutation pilot with explicit
parent gates.

## 8. Notification side effects

`publicSubmit` may dispatch email notifications via
`EmailService`. Out of scope for Phase 2.28.

## 9. Risks / out-of-scope concerns

- Applicant email is globally unique (`@unique`). Two tenants
  cannot register the same email today. Phase 2.28 does NOT
  change this. Per-tenant email uniqueness would need a Phase 3
  schema migration.
- `ApplicantFinancialProfile` has an `applicantId @unique`
  one-to-one relationship; cross-tenant access prevented by the
  parent applicant gate.
- `ApplicantAgencyHistory` has no `tenantId`; child-of-applicant.
- `CandidateDeleteRequest` has no `tenantId`; child-of-applicant.
- The conversion paths touch Document, FinancialRecord, Employee
  — all already piloted (documents, finance) or read-only (employee).
- Raw `$queryRaw` calls in `generateIdentifier` build globally
  unique candidate/applicant numbers — they don't read tenant
  data, just generate sequence. Tagged `phase228-global`.

## 10. Scope summary

| Class | Methods |
|-------|---------|
| **INCLUDED — pilot scope** | `findAll`, `findOne` (findUnique→findFirst), `getFinancialProfile`, `getAgencyHistory`, `exportCsv`, `exportExcel`, `getDeleteRequests` |
| **GLOBAL** | duplicate-email check in mutations, StageTemplate / SystemSetting / Agency reads inside mutation paths, raw SQL identifier generators |
| **EXCLUDED — Phase 2.29+ writes** | every CRUD / lifecycle / conversion method |
| **EXCLUDED — audit log** | every `auditLog.create` site |
