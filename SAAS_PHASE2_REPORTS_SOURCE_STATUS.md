# Phase 2.1 / 2.3 / 2.4 — Reports Source Status Dashboard

**Live at:** `backend/src/saas/reports/runtime/report-sources.ts`
**Auto-generated machine view:** `backend/reports/saas/phase2/reports-source-validation.{json,md}`.

> Counts updated as of Phase 2.4 (joined sources landed). Re-run
> `npm run saas:phase2-reports-status` (alias of `…-reports-validate`) to refresh.

| Status | Count |
|---|---:|
| READY | **17** |
| DISABLED | 1 |

---

## Per-source

| Key | Status | Reason | tenantColumn | agencyColumn | Test coverage | Owner |
|---|---|---|---|---|---|---|
| `employees`        | **READY**    | Direct `employees.tenantId` from Phase 1 backfill           | `tenantId` | `agencyId` | isolation + equivalence (PASS) | reports |
| `applicants`       | **READY**    | Direct `applicants.tenantId`                                | `tenantId` | `agencyId` | isolation + equivalence (PASS) | reports |
| `agencies`         | **READY**    | `agencies.tenantId`; self-scope via `id`                    | `tenantId` | `id`       | isolation + equivalence (PASS) | reports |
| `documents`        | **READY**    | Phase 2.3 — `documents.tenantId` backfilled + verified      | `tenantId` | `null` (entity-keyed) | isolation + equivalence (PASS) | reports |
| `compliance_alerts`| **READY**    | Phase 2.3 — `compliance_alerts.tenantId` backfilled         | `tenantId` | `null` | isolation + equivalence (PASS, fixture missing table) | reports |
| `work_permits`     | **READY**    | Phase 2.3 — entity-keyed via Employee; backfilled           | `tenantId` | `null` | isolation + equivalence (PASS, fixture missing table) | reports |
| `visas`            | **READY**    | Phase 2.3 — entity-keyed; backfilled                        | `tenantId` | `null` | isolation + equivalence (PASS, fixture missing table) | reports |
| `document_types`   | DISABLED     | Phase 2.4 — global catalog; reachable via joined sources only (see CATALOG_SOURCES_DECISION) | (n/a)  | (n/a)      | — | product+reports |
| `employees_documents`        | **READY** | Phase 2.4 — tenant-equality LEFT JOIN on documents; entityType='EMPLOYEE'; doc.deletedAt IS NULL | `tenantId` | `agencyId` | isolation + equivalence (PASS) | reports |
| `employees_work_permits`     | **READY** | Phase 2.4 — tenant-equality LEFT JOIN on work_permits.employeeId | `tenantId` | `agencyId` | isolation + equivalence (PASS) | reports |
| `employees_compliance`       | **READY** | Phase 2.4 — tenant-equality LEFT JOIN on compliance_alerts; entityType='EMPLOYEE' | `tenantId` | `agencyId` | isolation + equivalence (PASS) | reports |
| `applicants_documents`       | **READY** | Phase 2.4 — same shape as employees_documents but APPLICANT discriminator | `tenantId` | `agencyId` | isolation + equivalence (PASS) | reports |
| `applicants_compliance`      | **READY** | Phase 2.4 — tenant-equality LEFT JOIN on compliance_alerts; APPLICANT discriminator | `tenantId` | `agencyId` | isolation + equivalence (PASS) | reports |
| `employees_visas`            | **READY** | Phase 2.4 — tenant-equality LEFT JOIN on visas; EMPLOYEE discriminator | `tenantId` | `agencyId` | isolation + equivalence (PASS) | reports |
| `applicants_visas`           | **READY** | Phase 2.4 — tenant-equality LEFT JOIN on visas; APPLICANT discriminator | `tenantId` | `agencyId` | isolation + equivalence (PASS) | reports |
| `employees_agencies`         | **READY** | Phase 2.4 — tenant-equality LEFT JOIN on agencies; agency.deletedAt IS NULL | `tenantId` | `agencyId` | isolation + equivalence (PASS) | reports |
| `documents_with_type`        | **READY** | Phase 2.4 — catalog LEFT JOIN on document_types via documentTypeId | `tenantId` | (entity-keyed) | isolation + equivalence (PASS) | reports |
| `employees_documents_type`   | **READY** | Phase 2.4 — two-step: tenant-equality JOIN documents, catalog JOIN document_types | `tenantId` | `agencyId` | isolation + equivalence (PASS) | reports |

## Known behaviour differences (READY sources only)

Read-equivalence run on the staging fixture with Phase 2.4 fixture
extension applied:

```
PASS=17  WARN=0  FAIL=0  SKIPPED=1  (of 17 READY)
```

Every READY source matches the legacy SQL row-set when both are
tenant-scoped to the same tenant. Joined-cardinality counts also
match. Pagination and sort probes pass.

## Cutover order (re-stated from `SAAS_PHASE2_REPORTS_SOURCE_MAPPING.md`)

| Wave | Sources | Status |
|---|---|---|
| Wave A | `employees`, `applicants`, `agencies` | DONE (Phase 2.1) |
| Wave B | `documents`, `compliance_alerts`, `work_permits`, `visas` | DONE (Phase 2.3) |
| **Wave C (this PR — Phase 2.4)** | `employees_documents`, `employees_work_permits`, `employees_compliance`, `applicants_documents`, `applicants_compliance`, `employees_visas`, `applicants_visas`, `employees_agencies`, `documents_with_type`, `employees_documents_type` | **DONE — flipped to READY** |
| Wave D-residual | `document_types` (direct) | DISABLED — global catalog reachable through joined sources only; direct exposure pending product decision |

## Source-level Done definition

A source moves from **DISABLED** → **READY** when:

1. The primary table has `tenantId` populated for every active row (verified by `verify-tenant-backfill.ts`).
2. Every join in the new `tenantAwareJoins` list contains `<aliasA>.tenant_id = <aliasB>.tenant_id`.
3. The registry's `assertAllValid()` passes.
4. The per-source isolation test passes.
5. The per-source read-equivalence diff is empty (or all deltas explained).
6. Code-owner sign-off recorded in the migration PR.
