# Phase 2.1 / 2.3 — Reports Read-Equivalence Results

**Run command:** `npm run saas:phase2-reports-equivalence`
**Run target:** SAFE_CLONE staging fixture (`saas_phase1_fixture` on 127.0.0.1).
**Tenant under test:** the first tenant alphabetically in `tenants`.

---

## Headline (post Phase 2.5 rehearsal)

```
PASS=17  WARN=0  FAIL=0  SKIPPED=1  (of 17 READY)
```

Re-validated as part of the Phase 2.5 staging rollout rehearsal harness.
Rehearsal result: `[rollout-rehearsal] 20/20 steps PASS`. Per-source
verdicts and joined-cardinality counts unchanged from Phase 2.4.

Every READY source's tenant-safe SQL returns the same parent-row id
set as the legacy-shape SQL when both are scoped to the same tenant.
Joined-cardinality counts (LEFT JOIN row expansion) match. Pagination
(page 1, limit 5) and sort (ASC by id) probes pass for every source.

The single SKIPPED source is `document_types`, intentionally DISABLED
(global catalog reachable only via joined sources — see
`SAAS_PHASE2_CATALOG_SOURCES_DECISION.md`).

For exact per-source row counts, joined-cardinality counts, and
pagination/sort verdicts, see `backend/reports/saas/phase2/reports-read-equivalence.{json,md}`.

Quick view (verdict per source, post Phase 2.4 fixture extension applied):

| Group | Sources | Verdict |
|------|--------|--------:|
| Phase 2.1 single-table | `employees`, `applicants`, `agencies` | 3 × PASS |
| Phase 2.3 single-table | `documents`, `compliance_alerts`, `work_permits`, `visas` | 4 × PASS |
| Phase 2.4 joined (entity-keyed) | `employees_documents`, `employees_work_permits`, `employees_compliance`, `applicants_documents`, `applicants_compliance`, `employees_visas`, `applicants_visas` | 7 × PASS |
| Phase 2.4 joined (denorm) | `employees_agencies` | 1 × PASS |
| Phase 2.4 catalog-join | `documents_with_type`, `employees_documents_type` | 2 × PASS |
| Disabled (catalog direct) | `document_types` | 1 × SKIPPED (intended) |

(For exact row counts, see the live `backend/reports/saas/phase2/reports-read-equivalence.{json,md}`. The equivalence file is regenerated each run.)

## Methodology

For each READY source:

1. **Legacy SQL** — selects all matching ids using the legacy WHERE shape (`deletedAt IS NULL`, plus an explicit `tenantId = $tenant` filter wrapped around it so the comparison is fair). Without that wrapper, the legacy query would include other tenants' rows and the diff would be enormous and uninformative.
2. **Safe SQL** — generated via the new builder: `<primaryAlias>.tenantId = $1 [AND <agencyId> IN (...)] [AND deletedAt IS NULL]`.
3. Both queries return only the `id` column.
4. Set comparison; the report records `onlyLegacy`, `onlySafe`, `setEqual`.

## Tenant under test

`11111111-1111-1111-1111-111111111111` (Acme HR — derived deterministically from the fixture).

## Notes

- The harness runs against the fixture: small data volumes; results are not load-test-grade. They confirm correctness.
- For real production data on a SAFE_CLONE replica: row counts will be orders of magnitude higher; the same `0 delta, 0 errors` outcome is the acceptance gate per source.

## How to extend

- `--source <key>` to run a single source.
- `--tenant <uuid>` to scope to a specific tenant.
- `--agency <uuid>` to add the agency-scope filter.

```sh
npm run saas:phase2-reports-equivalence -- --source employees --tenant <uuid>
```

## Acceptance for cutover

Phase 3 (per-source flag flip) requires read-equivalence to be **PASS** (0 delta, 0 errors, pagination & sort equal) for that source on a sanitized prod clone. The current run on the staging fixture (with `phase24-extension.sql` applied) shows PASS for all 17 READY sources. A re-run on a real prod-shaped clone is the next operational gate before flipping `TENANT_SAFE_REPORTS_ENABLED=true` for the joined sources.

Real-prod-clone re-run is the next operational gate (TKT-P2-01 in the Phase 2 implementation plan).
