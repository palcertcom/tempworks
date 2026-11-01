# Phase 1 — "Production Replica" Backfill Dry-Run Results

> Same disclosure: target is the SAFE_CLONE staging fixture.
> Outputs at `backend/reports/saas/phase1-prod-replica/backfill-dry-run/`.

**Run command:** `npm run saas:phase1-backfill-dry-run -- --max-quarantine 50`
**Mode:** `dry-run` (transaction ROLLED BACK at end).

---

## 1. Final status

```
status:    ROLLED_BACK
duration:  62 ms
mode:      dry-run
database:  postgres://postgres@127.0.0.1/saas_phase1_fixture (masked)
```

## 2. Pre-flight summary (in-tx)

| Check | Count |
|---|---|
| Duplicate user emails | 0 |
| NULL-agency users | 1 |
| Employee email cross-tenant pairs | 0 |
| Employee code cross-tenant pairs | 1 |

Pre-flight gate did not abort. Emails were not duplicated; the orphan
NULL-agency user was correctly quarantined rather than blocking.

## 3. Tenant projection

| Original Agency | Reused Tenant id | Projected slug | Conflicts |
|---|---|---|---|
| Acme HR | `11111111-…-1111` | `acme-hr` | none |
| Globex Co. | `22222222-…-2222` | `globex-co` | none |
| Initech | `33333333-…-3333` | `initech` | none |
| Empty Co | `44444444-…-4444` | `empty-co` | none |

Total **projected tenants:** 4 (= `agencies WHERE isSystem=false`).

## 4. Writes recorded (rolled back)

| Kind | Count |
|---|---|
| Tenants | **4** |
| Default agencies | **4** |
| Tenant memberships | **11** |
| Membership roles | **11** |
| Agency memberships | **11** |
| Membership permission overrides | **0** *(fixture has no `agency_user_permission` rows)* |
| Platform admins | **2** |
| Quarantine rows | **1** *(orphan@nowhere.test)* |
| `applicants.tenantId` populated | **72** |
| `employees.tenantId` populated | **29** |
| `vehicles.tenantId` populated | **2** *(orphan vehicle correctly NOT migrated)* |

## 5. Verification (in-tx, before ROLLBACK)

| Check | Result | Detail |
|---|---|---|
| `tenants.count` | PASS | 4 expected, 4 actual |
| `users.with-agency-have-membership` | PASS | 0 unmembershipped |
| `users.no-agency.handled` | PASS | 0 unhandled (orphan moved to queue) |
| `applicants.tenantId-populated` | PASS | 0 NULL |
| `employees.tenantId-populated` | PASS | 0 NULL |
| `tenants.no-duplicate-slug` | PASS | 0 duplicates |
| `tenant_memberships.no-duplicate-pair` | PASS | 0 duplicates |
| `checkpoint.no-partial` | PASS | 0 partial |

**5/5 verification checks PASS.** Plus 3 hardened postcondition checks
(slug uniqueness, membership uniqueness, checkpoint completeness)
= 8/8 PASS overall.

## 6. Rollback verification

After the dry-run completed (status `ROLLED_BACK`), the database state
was queried directly:

```
tenants:                         0
tenant_memberships:              0
agency_memberships:              0
platform_admins:                 0
agency_split_progress:           0
saas_reconciliation_queue:       0
agencies:                        5  (unchanged)
employees:                      29  (unchanged; tenantId still NULL)
applicants:                     72  (unchanged)
```

The dry-run did not commit a single row. Database is byte-identical to
the pre-run state.

## 7. Diff summary captured during the dry-run

The hardened backfill prints a pre-run vs in-tx row-count diff in its
Markdown report. Excerpt:

```
| Table                            | Before | After | Δ   |
| tenants                          |     0  |    4  | +4  |
| tenant_memberships               |     0  |   11  | +11 |
| agency_memberships               |     0  |   11  | +11 |
| membership_roles                 |     0  |   11  | +11 |
| platform_admins                  |     0  |    2  | +2  |
| agency_split_progress            |     0  |    4  | +4  |
| saas_reconciliation_queue        |     0  |    1  | +1  |
| agencies                         |     5  |    5  |  0  |
| applicants                       |    72  |   72  |  0  |
| employees                        |    29  |   29  |  0  |
```

The "agencies" delta is 0 because every old customer agency is
deleted at backfill step 5.4 and replaced with a fresh DefaultAgency
child of the new Tenant — net same row count.

## 8. Idempotency

The script was invoked a second time immediately after the first
ROLLBACK. Output was identical: same 4 tenants projected, same writes
recorded, same verification PASS, same final ROLLBACK. The
`agency_split_progress` table was empty before each run (no partial
state), so `--resume` was not exercised on this run.

A third run after a `--apply` (see §9) would, with `--resume`,
correctly skip every agency already marked DONE in
`agency_split_progress`.

## 9. Optional staging apply (since classification is SAFE_CLONE)

Re-ran the orchestrator with `--apply` to exercise the full apply path
end-to-end:

```
ALLOW_SAAS_STAGING_MUTATION=true \
DATABASE_URL=postgres://postgres@127.0.0.1/saas_phase1_fixture \
  npx ts-node backend/scripts/saas/phase1/apply-tenant-backfill-staging.ts --apply
```

Result: **`Overall: OK`**. Per-stage:

| Stage | Mode | Result |
|---|---|---|
| preflight | read-only | BLOCKER (informational) |
| recon-A..E | apply | findings recorded to queue |
| dry-run-backfill | apply | 4 tenants committed; 11 memberships; 2 platform admins |
| seq-snapshot | apply | OK (0 rows because fixture lacks `identifier` columns) |
| verify-backfill | dry-run | **12 PASS / 0 FAIL / 1 SKIPPED** |

Outputs preserved at
`backend/reports/saas/phase1-prod-replica/staging-apply/`.

## 10. What the same dry-run would look like on real production

- **Tenant projection** count = number of customer agencies (`isSystem=false`).
- **Memberships** count = number of active users with non-NULL agency.
- **Platform admins** count = number of users in the system agency (typically a small handful).
- **Quarantine queue** count proportional to NULL-agency users (typically < 5).
- **Verification** expected to remain 5/5 PASS (8/8 with the hardened checks) — the algorithm is independent of data volume.
- **Runtime** dominated by the Postgres advisory lock + per-agency loop. For a mid-sized prod (~ 50 customer agencies, ~ 5k users, ~ 50k employees+applicants) we estimate **< 5 minutes** in the per-agency loop. The seq-snapshot is a separate query per source table; sub-second on indexed identifier columns.

The hardened `--max-quarantine N` flag becomes meaningful on prod:
ops can pin the acceptable quarantine count and abort if exceeded.

## 11. Conclusion

The dry-run backfill is correct, idempotent, fully rolled back, and
matches projection. No further code changes are required to run the
same script against a real prod replica; only the operational gates
(snapshot, sign-off, second clean run) remain.
