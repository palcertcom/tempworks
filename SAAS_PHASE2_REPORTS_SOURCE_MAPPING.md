# Phase 2 — Reports Source Mapping

> Maps every entry in the legacy `SOURCE_DEFS` (in `backend/src/reports/reports.service.ts`) onto its Phase 3 tenant-safe replacement.
>
> Auto-generated machine view: `backend/reports/saas/phase2/reports-source-validation.{json,md}`. Re-run with `npm run saas:phase2-reports-validate`.

**Headline numbers** (live, scanned 2026-05-09):

- 18 sources total.
- 0 currently `READY` (no source declares `tenantColumn` because the field doesn't exist yet — that's Phase 2 work).
- 8 need a decision (single-table sources; need only the column).
- 10 are blocked on join refactors (`tenant_id = tenant_id` not yet present).

---

## 1. Single-table sources — 8 entries (status: NEEDS_DECISION)

These sources have `joins = 0`. The migration is a column declaration plus a Phase 2 backfill of the `tenantId` column on the source table.

| Source key | Primary table | Tenant column candidate | Agency column candidate | Joins → tenant-eq | Aggregate risk | Export risk | Status | Notes |
|---|---|---|---|---:|---|---|---|---|
| `employees`        | `employees`        | `tenantId` (added Phase 1) | `agencyId` | 0 → 0 (n/a) | low | low | NEEDS_DECISION | Confirm Phase 1 backfill populated `tenantId` before flag flip |
| `applicants`       | `applicants`       | `tenantId` (Phase 1)       | `agencyId` | 0 → 0       | low | low | NEEDS_DECISION | Same |
| `documents`        | `documents`        | `tenantId` (Phase 2 denorm) | (none — entity-keyed) | 0 → 0 | medium (group by entityType) | low | NEEDS_DECISION | The `tenantId` column will be denormalised at backfill via `documents.entityType + entityId → parent.tenantId` |
| `compliance_alerts`| `compliance_alerts`| `tenantId` (Phase 2 denorm) | (none) | 0 → 0 | low | low | NEEDS_DECISION | Entity-keyed |
| `agencies`         | `agencies`         | `tenantId` (Phase 1)       | (none — agency IS the agency) | 0 → 0 | low | low | NEEDS_DECISION | This source CAN be agency-aware via `agencies.id IN agencyIds`; treat as primary table = agency |
| `work_permits`     | `work_permits`     | `tenantId` (Phase 2 denorm) | (none — entity-keyed) | 0 → 0 | low | low | NEEDS_DECISION | Entity-keyed via Employee |
| `document_types`   | `document_types`   | `tenantId` (catalog) — nullable | (none) | 0 → 0 | low | low | NEEDS_DECISION | Catalog model: tenantId NULL = system catalog row; per-tenant overrides have non-NULL. Resolution per ADR-004 §6. |
| `visas`            | `visas`            | `tenantId` (Phase 2 denorm) | (none) | 0 → 0 | low | low | NEEDS_DECISION | Entity-keyed |

## 2. Multi-table sources — 10 entries (status: BLOCKED)

These sources have at least one join. Each join's `on` clause must be edited to include `<aliasA>.tenantId = <aliasB>.tenantId`. Until then the boot validator will reject the source.

| Source key | Primary | Joined table(s) | Required `tenant_id =` clauses | Aggregate risk | Export risk | Status | Notes |
|---|---|---|---|---|---|---|---|
| `employees_documents`        | employees | documents | `documents.tenantId = employees.tenantId` | medium | medium | BLOCKED | High-volume; needs `documents.tenantId` denorm in place |
| `employees_work_permits`     | employees | work_permits | `work_permits.tenantId = employees.tenantId` | low | low | BLOCKED | |
| `employees_compliance`       | employees | compliance_alerts | `compliance_alerts.tenantId = employees.tenantId` | low | low | BLOCKED | |
| `applicants_documents`       | applicants | documents | `documents.tenantId = applicants.tenantId` | medium | medium | BLOCKED | |
| `employees_agencies`         | employees | agencies | `employees.tenantId = agencies.tenantId` | low | low | BLOCKED | Can also use `employees.agencyId = agencies.id` for sub-scope |
| `applicants_compliance`      | applicants | compliance_alerts | `compliance_alerts.tenantId = applicants.tenantId` | low | low | BLOCKED | |
| `documents_with_type`        | documents | document_types | `document_types.tenantId IS NULL OR document_types.tenantId = documents.tenantId` | low | low | BLOCKED | Catalog join (system rows + tenant overrides) |
| `employees_visas`            | employees | visas | `visas.tenantId = employees.tenantId` | low | low | BLOCKED | |
| `applicants_visas`           | applicants | visas | `visas.tenantId = applicants.tenantId` | low | low | BLOCKED | |
| `employees_documents_type`   | employees | documents, document_types | both above | medium | medium | BLOCKED | 2-join chain |

## 3. Per-source action items

For every source above, the Phase 3 cutover ticket performs:

1. Copy the legacy entry into the new registry under `backend/src/saas/reports/`.
2. Add `tenantColumn: 'tenantId'`. (For `agencies`, the column is on the same row.)
3. Add `agencyColumn` only if the primary table has a direct `agencyId` and product wants per-agency reporting from this source. Today: `employees`, `applicants`, `agencies` source. Document-style sources do NOT get an `agencyColumn` because their entity-keyed model would require a denorm we don't ship.
4. Rewrite each join's `on` clause to include the tenant equality term.
5. Write a 2-tenant isolation test under `backend/src/saas/__validation__/reports-<source>.check.ts`.
6. Run `npm run saas:phase2-reports-validate` — expect status `READY` for the source.
7. Open the cutover flag for that source in staging; observe no row-count regression on a known report; promote.

## 4. Aggregate risk legend

- **low** — single primary key per row, no fan-out via joins.
- **medium** — one-to-many join (e.g. employees → many documents). Aggregates that GROUP BY the primary table risk over-counting if the join lacks tenant equality. Mitigated by the mandatory `tenant_id = tenant_id` join condition.
- **high** — many-to-many join. Today's `SOURCE_DEFS` does not contain any.

## 5. Export risk legend

- **low** — < 10k expected rows per typical report; export libraries (exceljs / pdfkit / docx) stream rows comfortably.
- **medium** — multi-table join can produce 50k+ rows on real prod. Export must reuse the engine output, not re-query.
- **high** — none expected.

The engine enforces a per-source `LIMIT` (default 10,000 rows) regardless of caller.

## 6. Open product decisions

| Question | Default proposal | Owner |
|---|---|---|
| Should `agencies` source allow agency-scoped reporting (a recruiter sees only their agencies)? | Yes — set `agencyColumn = 'id'` and let `AgencyMembership.agencyIds` constrain. | Product |
| Should `document_types` follow the catalog model (tenantId NULL + per-tenant overrides)? | Yes — locked in ADR-004 §6. | confirmed |
| Should `documents` get a real `agencyColumn` denormalised at write time? | No — agency scope on documents flows through the parent entity (Employee/Applicant). The `documents_with_type` source picks up agency scope via the parent's `agencyColumn`. | Backend |
| `documents_with_type` join with the catalog: how to allow system rows? | `document_types.tenantId IS NULL OR document_types.tenantId = documents.tenantId`. The boot validator's regex accepts this form. | confirmed |

## 7. Cutover order

| Wave | Sources | Why |
|---|---|---|
| Wave A (single-table, easy) | `employees`, `applicants`, `agencies`, `work_permits`, `visas` | Direct `tenantId` after Phase 1 backfill; minimal risk |
| Wave B (single-table, derived) | `documents`, `compliance_alerts`, `document_types` | Depend on Phase 2 entity-keyed denorm |
| Wave C (multi-table) | `employees_*`, `applicants_*`, `documents_with_type` | Depend on Wave A + Wave B |
| Wave D (catalog joins) | `employees_documents_type` | Last; chains Wave B + catalog rules |

## 8. Done definition

The reports refactor is "done" when:

- All 18 sources are present in the new registry.
- `assertAllValid()` passes at boot.
- `npm run saas:scan:raw-sql --strict` against `backend/src/reports/` reports `0` BLOCKER findings.
- Per-source isolation tests all PASS.
- `REPORTS_TENANT_FILTER_ENFORCED=true` in production for ≥ 14 days with zero leakage incidents.
- Legacy `SOURCE_DEFS` deleted.
