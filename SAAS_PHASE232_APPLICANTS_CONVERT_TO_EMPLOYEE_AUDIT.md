# Phase 2.32 — `convertToEmployee` Audit

> Per-call audit of `convertToEmployee` after Phase 2.29 (parent gate +
> Employee.create tenant write) and Phase 2.31 (deferred paths closed).

---

## 1. Method shape

`src/applicants/applicants.service.ts:1025` —
`convertToEmployee(id, dto, actorId?, actor?)`.

Not wrapped in a single `$transaction`. The conversion is a sequence
of independent Prisma calls; preserving this shape is a strict rule
of Phase 2.32 ("preserve transaction boundaries").

## 2. Per-call audit

| # | Site | Call | Phase 2.29 tag | Tenant guard today | Cross-tenant risk | Phase 2.32 action |
|---|---|---|---|---|---|---|
| 1 | role gate | (in-memory) | n/a | n/a | none | unchanged |
| 2 | applicant load | `findOne(id, actor)` | `phase228-pilot-scope` | **YES** — pilot client + `tenantWhere()` + agency scope. Cross-tenant 404. | NONE | unchanged (this is the cross-module gate) |
| 3 | tier / approval guards | (in-memory) | n/a | n/a | none | unchanged |
| 4 | duplicate-email check | `legacyPrisma.employee.findFirst({ email, deletedAt: null })` | `phase229-pilot-scope-precheck` | None — global by design (Employee.email is globally unique like Applicant.email) | n/a (read-only sanity check) | **unchanged** — global email uniqueness is a Phase 3 product question. Same shape as `Applicant.email @unique`. |
| 5 | stage template fetch | `legacyPrisma.stageTemplate.findMany({ isActive: true })` | `phase228-global` | None — StageTemplate is a global catalog | none | unchanged |
| 6 | identifier generation | `generateIdentifier('E')` | `phase228-global` | n/a — sequence | none | unchanged |
| 7 | **Employee.create** | `legacyPrisma.employee.create({ data: { …, …tdata } })` | `phase229-pilot-scope` | **YES** — `scope.tenantData()` writes `tenantId` in pilot mode. New Employee inherits applicant's tenant. | NONE | unchanged |
| 8 | **Document.updateMany** | `legacyPrisma.document.updateMany({ where: { entityType: 'APPLICANT', entityId: id, deletedAt: null }, data: { entityType: 'EMPLOYEE', entityId: employee.id } })` | `phase229-pilot-scope-precheck` | **NONE today.** The where clause does not filter by `tenantId`. Although the applicant is tenant-gated, *if* a foreign-tenant Document row mistakenly carries `entityId = applicantId`, the conversion would silently re-link it. Cross-module integrity hole. | **MEDIUM** | **ADD `...scope.tenantWhere()` to the where clause.** |
| 9 | **FinancialRecord.updateMany** | `legacyPrisma.financialRecord.updateMany({ where: { entityType: 'APPLICANT', entityId: id, deletedAt: null }, data: { entityType: 'EMPLOYEE', entityId: employee.id, applicantId: id } })` | `phase229-pilot-scope-precheck` | **NONE today.** Same gap as Document. | **MEDIUM** | **ADD `...scope.tenantWhere()` to the where clause.** |
| 10 | ApplicantFinancialProfile re-link | `prisma.applicantFinancialProfile.updateMany({ where: { applicantId: id }, data: { employeeId } })` | (untagged today) | None — the model has no `tenantId` column | LOW — `applicantId` is unique-per-applicant; the gated applicant restricts the row | annotate `phase232-conversion-gate` |
| 11 | Applicant.update (soft delete + back-pointer) | `legacyPrisma.applicant.update({ where: { id }, data: { deletedAt, convertedToEmployeeId, employeeConvertedAt } })` | `phase229-pilot-scope-precheck` | Gated by `findOne(id)` above | NONE | unchanged |
| 12 | audit emit | `this.auditLog(actorId, 'CONVERT_TO_EMPLOYEE', id, …)` | (delegates to `TenantAuditLogService` via Phase 2.30) | YES — shared audit helper applies tenant attribution | NONE | unchanged |

## 3. Transaction boundaries

The method is **not** wrapped in `$transaction`. Phase 2.32 keeps
this. Any failure between (7) and (11) leaves a partially-converted
state. This is the existing semantics (since Phase 2.29) and is out
of scope for Phase 2.32 — wrapping the whole flow in `$transaction`
is a behaviour change that needs its own phase.

## 4. Identifier generation

`generateIdentifier('E')` is unchanged. Phase 2.32 does **not** touch
the sequence/serial path.

## 5. Tenant ownership path

In pilot mode the conversion follows this attribution path:

```
applicant.tenantId  (from findOne gate)
  → employee.tenantId  (from scope.tenantData() in Employee.create)
  → eligible documents:        document.tenantId == applicant.tenantId
  → eligible financial records: financialRecord.tenantId == applicant.tenantId
```

`ApplicantFinancialProfile` rides on the tenant-gated `applicantId`.

## 6. Required guards (Phase 2.32 deltas)

Two `where` clauses get a `tenantId` filter spread:

```ts
// Document re-link (Phase 2.32 — narrow by active tenant)
this.legacyPrisma.document.updateMany({
  where: { entityType: 'APPLICANT', entityId: id, deletedAt: null,
           ...this.scope().tenantWhere() },
  data:  { entityType: 'EMPLOYEE', entityId: employee.id },
});

// FinancialRecord re-link (Phase 2.32 — narrow by active tenant)
this.legacyPrisma.financialRecord.updateMany({
  where: { entityType: 'APPLICANT', entityId: id, deletedAt: null,
           ...this.scope().tenantWhere() },
  data:  { entityType: 'EMPLOYEE', entityId: employee.id, applicantId: id },
});
```

Annotate both with `phase232-conversion-gate`. In legacy mode
`tenantWhere()` returns `{}` and behaviour is byte-identical to
pre-2.32. In pilot mode the active tenant id participates in the
where clause.

## 7. Legacy NULL-tenant treatment

Pre-existing rows whose `tenantId` is NULL (created before Phase 2.16
/ 2.20 / 2.29) will not match a non-null `tenantId` filter. Two
options:

- **Option A (chosen):** Match exact tenant id only. Legacy NULL rows
  are silently skipped during conversion in pilot mode.
- Option B: `OR { tenantId: null }`. Bridges legacy data but reopens
  the cross-tenant smuggling vector for any row that happens to be
  NULL.

Phase 2.32 picks **Option A** — strict equality. Legacy rows are
re-linked only by an offline backfill (out of scope), or by re-saving
the parent under the pilot. Operators get a deterministic, tenant-
safe outcome; legacy continuity is acceptable to lose at the cost of
correctness.

## 8. Audit-log behaviour

`auditLog('CONVERT_TO_EMPLOYEE', …)` already routes through
`TenantAuditLogService` (Phase 2.30). The shared helper writes
`tenantId` only when its own pilot flag is on; legacy
audit-row shape is preserved otherwise. No change required.

## 9. Behaviour with flags OFF

`scope.active === false` ⇒ `tenantWhere()` returns `{}` ⇒ both
new where clauses collapse to today's clauses ⇒ byte-identical to
pre-2.32.

## 10. Included vs. deferred decisions

**Included in Phase 2.32:**
- Document re-link tenant filter.
- FinancialRecord re-link tenant filter.
- Source-level meta-assertion in the new isolation harness.

**Deferred:**
- Wrapping the conversion in `$transaction` (preserve current
  boundaries — strict rule).
- Per-tenant Employee.email uniqueness (Phase 3 product).
- ApplicantFinancialProfile.tenantId column (would be additive but
  not needed for the security guarantee).
- Workflow / EmployeeStage cross-module audit (workflow stages are
  already tenant-gated by parent employee in Phase 2.27).
