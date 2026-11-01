# Phase 2.32 — `convertToEmployee` Safety Decision

> "Conversion must never smuggle another tenant's records across the border."

---

## 1. Tenant safety guarantees (Phase 2.32 onwards)

| Step | Guarantee | Source |
|---|---|---|
| Applicant load | Tenant-gated read via `findOne(id, actor)` (pilot client + `tenantWhere()` + agency scope). Cross-tenant id raises 404 BEFORE any write. | Phase 2.28 |
| Employee.create | New Employee inherits `tenantId = applicant.tenantId` via `scope.tenantData()`. | Phase 2.29 |
| Document re-link | `Document.updateMany` where-clause narrowed by `tenantId` in pilot mode. Foreign-tenant Documents that incidentally point at the applicant id stay untouched. | **Phase 2.32 (new)** |
| FinancialRecord re-link | `FinancialRecord.updateMany` where-clause narrowed by `tenantId` in pilot mode. Foreign-tenant FinancialRecords stay untouched. | **Phase 2.32 (new)** |
| ApplicantFinancialProfile re-link | Keyed by `applicantId` (unique). Tenant safety inherited from the gated applicant. | unchanged |
| Applicant soft-delete + back-pointer | Updates the same tenant-gated row. | Phase 2.29 |
| Audit emission | Shared `TenantAuditLogService` (Phase 2.30). Tenant attribution inherited from ALS. | Phase 2.30 |

## 2. Legacy NULL-tenant rows — treatment

Phase 2.32 uses **strict equality** on `tenantId`. Pre-pilot rows
whose `tenantId` is `NULL` (created before Phase 2.16 / 2.20 / 2.29)
do not match a non-null `tenantId` filter and will not be re-linked
during conversion in pilot mode.

This is intentional. The alternative — `OR { tenantId: null }` —
would re-open the cross-tenant smuggling vector for any legacy row
that happens to be NULL. The Phase 2 strict rules forbid that.

Operators with legacy data must run an offline backfill (out of scope
this phase) before relying on conversion to re-link historical
documents/financial records.

## 3. Transaction semantics

Unchanged. The conversion is a sequence of independent Prisma calls,
exactly as Phase 2.29 left it. Wrapping in `$transaction` is a
behaviour change and is explicitly out of scope.

## 4. Audit-log tenant behaviour

`convertToEmployee`'s audit emit uses `this.auditLog(...)` which
delegates to the shared `TenantAuditLogService` (Phase 2.30). With
`TENANT_AUDIT_LOG_PILOT_ENABLED=true` the audit row carries
`tenantId = applicant.tenantId`; with the flag off the row is
NULL-tenant.

## 5. Behaviour with flags OFF

`scope().active === false` ⇒ `tenantWhere()` returns `{}` ⇒ both new
filtered where-clauses degrade to today's where-clauses. The Employee
gets no `tenantId`. Document/FinancialRecord re-link runs over the
same row set as today. **Byte-identical to pre-2.32.**

## 6. What this phase does NOT do

- No schema migration.
- No global enforcement.
- No new flag.
- No conversion-flow redesign.
- No transaction-boundary change.
- No identifier-generation change.
- No `Employee.email` uniqueness change.
- No permissions change.
- No ApplicantFinancialProfile schema change.
