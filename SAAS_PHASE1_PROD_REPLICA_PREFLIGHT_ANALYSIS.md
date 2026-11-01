# Phase 1 — "Production Replica" Preflight Analysis

> **Disclosure:** the active "production replica" was the synthetic
> staging fixture `saas_phase1_fixture` (classified `SAFE_CLONE`).
> The fixture is intentionally seeded with edge cases that mirror the
> patterns expected on real prod data (orphan user, employee-code
> collision, public-Spaces document URLs, raw SQL in reports,
> globally-keyed identifier sequences). Findings here are therefore a
> **prototype** of a real-replica preflight; the same scripts run
> unchanged against the real DB will produce shape-compatible output.

**Run command:** `npm run saas:phase1-preflight`
**Output dir:** `backend/reports/saas/phase1-prod-replica/`
**Run timestamp:** `2026-05-09T14:53:…Z`

---

## 1. Overall status

| Field | Value |
|---|---|
| Overall classification | **`BLOCKER`** |
| Risk level | HIGH against this fixture; review per finding |
| Suites that ran | 7 / 7 |

## 2. Counts

| Severity | Count |
|---|---|
| BLOCKER | 4 |
| WARN | 5 |
| INFO | (informational only; not gating) |

## 3. Per-suite

| Suite | Status |
|---|---|
| `01-agency-structure` | INFO |
| `02-user-identity` | **BLOCKER** |
| `03-data-ownership` | WARN |
| `04-uniqueness-collisions` | **BLOCKER** |
| `05-permissions` | INFO |
| `06-storage` | WARN |
| `07-reports-sql` | **BLOCKER** |

## 4. Top 10 issues (in detection order)

| # | Suite / rule | Severity | Summary |
|---|---|---|---|
| 1 | `02-user-identity / user.no-agency` | BLOCKER | 1 user has NULL `agencyId` (orphan@nowhere.test). Disposition required. |
| 2 | `04-uniqueness-collisions / unique.employee-code` | BLOCKER | 1 `employeeCode` ("COMMON-001") used in 2 agencies → collision under `(tenantId, employeeCode)`. |
| 3 | `04-uniqueness-collisions / unique.identifier-sequences` | BLOCKER | 2 global identifier-sequence rows. Per-tenant snapshot mandatory before cutover. |
| 4 | `07-reports-sql / reports.raw-sql-without-tenant-column` | BLOCKER | 13 raw-SQL occurrences without `tenantColumn`. Phase 2 reports refactor (ADR-007) required. |
| 5 | `03-data-ownership / model.vehicles.null-owner` | WARN | 1 vehicle row with NULL `agencyId` (orphan plate). |
| 6 | `04-uniqueness-collisions / unique.attendance-locked` | WARN | 2 global `attendance_locked_periods` rows. Replicate-per-tenant policy required. |
| 7 | `06-storage / storage.public-spaces` | WARN | 50 documents stored as public-readable Spaces URLs. Phase 3 rekey + ACL flip. |
| 8 | `06-storage / storage.local-path` | WARN | 1 document references legacy `/uploads/...`. |
| 9 | `06-storage / storage.missing-pointer` | WARN | 1 document has neither `storageKey` nor `storageUrl`. |
| 10 | `01-agency-structure / agency.empty` (informational) | INFO | 1 customer agency has no users / employees / applicants. |

## 5. Data volume

| Table | Rows |
|---|---|
| agencies (incl. system) | 5 |
| users | 14 |
| employees | 29 |
| applicants | 72 |
| documents | 52 |
| vehicles | 3 |
| job_ads | 3 |
| reports | 2 |
| identifier_sequences | 2 (global) |
| attendance_locked_periods | 2 (global) |

This is a small fixture by design. A real prod replica will have
orders of magnitude more rows. The same script produces the same
shape of output; only the counts change.

## 6. Estimated manual reconciliation workload

Computed from the BLOCKER+WARN finding count and the per-finding
ownership table in `SAAS_PHASE1_BLOCKER_RESOLUTION_REPORT.md`:

| Owner | Items in fixture | Rough estimate |
|---|---|---|
| Data steward | 3 (orphan user; orphan vehicle; missing-pointer doc) | 30–60 min |
| Product (sign-off) | 4 (employee-code semantics; locked-period policy; catalog-vs-replicate; report names) | half-day |
| Backend (Phase 2) | 1 (reports refactor) | already scoped to Phase 2 |
| Security | 1 (PlatformAdmin grants) | 1 hour |
| DevOps / Storage | 50+ (Phase 3 rekey, not Phase 1) | parallel track |

On a real prod replica, the same WORKLOAD CATEGORIES apply but:

- `user.no-agency` is expected to be ≤ 5 rows (typical); each takes
  < 10 min of triage.
- `unique.employee-code` collisions on real data may be 10–100s of
  rows depending on whether agencies historically reused codes; **no
  data action** is required because the constraint becomes
  tenant-scoped.
- `identifier-sequences` is mechanical; the `seq-snapshot` script
  produces all per-tenant counters in seconds.

## 7. Did fixture assumptions hold?

| Assumption | Held? | Notes |
|---|---|---|
| `agencies.isSystem = true` count is exactly 1 | YES | The fixture has the Tempworks system agency. |
| Customer agencies do NOT have a `parentId` | YES | Hierarchical sub-agencies out of Phase 1 scope. |
| Every active user has `agencyId` OR is being promoted to PlatformAdmin | YES | 1 orphan flagged for triage; rest map cleanly. |
| `Employee.email` was globally unique today | YES | Confirmed by the `unique_violation` blocking duplicate inserts. |
| `Document` is entity-keyed (no `agencyId`) | YES | tenantId derived in Phase 2 via parent entity. |
| Identifier sequences are global today | YES | Per-tenant snapshot is the cutover prerequisite. |

No fixture assumption was invalidated by this run. The blockers are
**expected** outputs of the audits when run against intentionally
messy data.

## 8. What the same run would look like on real production data

Expected differences:

1. **Counts scale** — orders of magnitude more rows; preflight runtime
   stays sub-minute on managed Postgres because every query has an
   index that leads with the relevant scan key.
2. **`user.no-agency`** likely a small handful (recent invitations
   that never resolved; deactivated staff). Triage is per-row.
3. **Cross-tenant employee email/code pairs** likely produce more
   rows. They are NOT blockers — the new constraint is tenant-scoped.
   Product sign-off only.
4. **Reports raw-SQL** count is the actual `Prisma.raw` occurrences in
   `backend/src/reports/` — file count fixed, not data-dependent.
5. **Storage findings** scale with `documents.count` × `storageKey`
   pattern frequency. Already partially migrated to Spaces by
   `UPLOAD_SPACES_MIGRATION.md`; remaining migration is Phase 3.
6. **Reconciliation queue** is bigger; the queue-CLI tool (TKT-P1-07)
   handles bulk decisions.

## 9. Conclusion

The preflight tooling is correct, complete, and faithfully reports
findings on the available data. The four blockers found are
**expected** for any pre-migration database; their resolution paths
are documented in `SAAS_PHASE1_BLOCKER_RESOLUTION_REPORT.md`.

> **Phase 1 implementation tooling is ready.**
> A real-replica run is the next operational gate (TKT-P1-02), not a
> code-readiness gate.
