# Phase 1 — Implementation Plan

**Goal:** carry the application from "Phase 0 dormant scaffolding" to "tenant model exists, populated, idempotent" — with **no service-layer rewrites**, **no flag-on production**, **no RLS**, and a fully reversible exit.

Phase 1 is the data layer. Phase 2 is the application layer.

| Property | Phase 0 (done) | Phase 1 (this plan) | Phase 2 |
|---|---|---|---|
| Domain code | unchanged | unchanged | refactored |
| New schema tables | created (idempotent) | populated | read by app |
| `tenantId` columns on existing tables | none | added (nullable) | NOT NULL |
| Old constraints | unchanged | unchanged | replaced (expand-contract) |
| RLS | off | off | audit-mode |
| Feature flags | all off | all off | flipped per-env |

---

## TKT-P1-01 — Land Phase 1 prep migration on staging

- **Goal:** Apply `prisma/migrations/saas_phase1_tenant_backfill_prepare/migration.sql` against the staging DB.
- **Files affected:** none in `backend/src`. Migration script only.
- **Steps:**
  1. Take staging snapshot (PITR or `pg_dump`).
  2. Run the migration as `psql -1 -f migration.sql` (single transaction).
  3. Smoke-test: `nest start` on staging — verify `app.module` boots; no behaviour change.
  4. Run preflight against staging: `DATABASE_URL=... npx ts-node backend/scripts/saas/phase1/run-preflight.ts`.
- **Acceptance:**
  - Staging backend starts and serves traffic identically.
  - Preflight runs and writes reports under `backend/reports/saas/phase1/`.
- **Tests:** Phase 0 `saas:validate`, `saas:schema-lint`. New columns visible via `\d agencies`.
- **Rollback:** `psql -1 -f migration.down.sql`.
- **Risk:** LOW (additive only).

## TKT-P1-02 — Run preflight on a sanitized prod replica

- **Goal:** Capture a real reconciliation worklist.
- **Files affected:** none.
- **Steps:**
  1. Provision a logical replica from prod (read-only).
  2. Run preflight read-only against it.
  3. Commit the resulting `PHASE1_PREFLIGHT_SUMMARY.md` to a security-tracked location (NOT the public repo if it contains tenant identifiers).
  4. Triage findings into `saas_reconciliation_queue`.
- **Acceptance:** Triage worklist exists; sign-offs assigned per `SAAS_PHASE1_DATA_RECONCILIATION_PLAN.md` §6.
- **Tests:** preflight exit code documented.
- **Rollback:** N/A (read-only).
- **Risk:** LOW.

## TKT-P1-03 — Implement backfill script (`saas:phase1-backfill`)

- **Goal:** Translate `SAAS_PHASE1_TENANT_BACKFILL_ALGORITHM.md` into TypeScript.
- **Files affected:**
  - `backend/scripts/saas/phase1/backfill.ts` (new)
  - `backend/scripts/saas/phase1/lib/backfill-runner.ts` (new)
  - `backend/package.json` — add `saas:phase1-backfill` script
- **Steps:**
  1. Use `pg` (no Prisma — script must work even if the client is stale).
  2. Acquire `pg_advisory_lock(hashtext('saas-agency-tenant-split'))`.
  3. Re-run the preflight gate inside the same transaction; abort on blocker.
  4. Iterate `agencies WHERE isSystem = false` in `created_at` order.
  5. For each row, execute the per-agency transaction (algorithm §5).
  6. Process `isSystem = true` agencies (algorithm §7).
  7. Write the verification report.
  8. `pg_advisory_unlock(...)`.
- **Acceptance:**
  - `BACKFILL_DRY_RUN=true` works against staging without committing.
  - Real run on staging produces a `PHASE1_BACKFILL_VERIFICATION.md` with all green checks.
  - Re-running the script changes nothing (idempotency).
- **Tests:**
  - Apply against the fixture DB → verify counts.
  - Halt mid-run (kill process) → re-run resumes.
- **Rollback:** Restore from snapshot.
- **Risk:** **HIGH** (data movement). Requires staged dry-runs and a sign-off per ticket TKT-P1-08.

## TKT-P1-04 — Backfill verification report generator

- **Goal:** Independent verifier reads the post-backfill state and asserts invariants.
- **Files affected:**
  - `backend/scripts/saas/phase1/verify-backfill.ts` (new)
- **Steps:** Implement `SAAS_PHASE1_TENANT_BACKFILL_ALGORITHM.md` §9 checks; emit JSON + Markdown.
- **Acceptance:** All invariants `PASS`; sample 100 random rows confirms `tenantId` matches.
- **Tests:** Run on the fixture before/after; report differences.
- **Rollback:** N/A.
- **Risk:** LOW.

## TKT-P1-05 — Identifier-sequence snapshot job

- **Goal:** Compute per-tenant counters for every existing `(prefix, year, month)` and store them in a staging table for Phase 2 cutover.
- **Files affected:**
  - `backend/scripts/saas/phase1/seq-snapshot.ts` (new)
  - SQL: `CREATE TABLE saas_phase1_seq_snapshot(...)`.
- **Steps:** Per algorithm §6.
- **Acceptance:** `saas_phase1_seq_snapshot` populated; row count matches `count(distinct (tenantId, prefix, year, month))` derivable from real identifiers.
- **Tests:** spike-3 fixture sanity.
- **Rollback:** `DROP TABLE saas_phase1_seq_snapshot;`.
- **Risk:** LOW.

## TKT-P1-06 — Wire scripts into `package.json`

- **Goal:** Convenient entry points.
- **Files affected:**
  - `backend/package.json` — add:
    - `saas:phase1-preflight`: `ts-node scripts/saas/phase1/run-preflight.ts`
    - `saas:phase1-backfill`: `ts-node scripts/saas/phase1/backfill.ts`
    - `saas:phase1-verify`:   `ts-node scripts/saas/phase1/verify-backfill.ts`
    - `saas:phase1-seq-snapshot`: `ts-node scripts/saas/phase1/seq-snapshot.ts`
- **Acceptance:** scripts listed and executable.
- **Tests:** Manual `pnpm run saas:phase1-preflight --help`.
- **Rollback:** revert.
- **Risk:** none.

## TKT-P1-07 — Reconciliation-queue admin tooling (CLI)

- **Goal:** Ops can drain `saas_reconciliation_queue` without writing SQL.
- **Files affected:** `backend/scripts/saas/phase1/queue-cli.ts` (new).
- **Steps:** Commands: `list`, `assign --id N --to <agencyId>`, `platform-admin --id N`, `deactivate --id N`, `comment --id N`.
- **Acceptance:** All command paths write to `decided_by` + `decided_at`; idempotent.
- **Tests:** Replay all paths against the fixture queue.
- **Rollback:** revert.
- **Risk:** LOW.

## TKT-P1-08 — Two staging dry-runs + sign-off

- **Goal:** Prove the backfill on real-shape data twice before prod.
- **Files affected:** none.
- **Steps:**
  1. **Run 1:** apply against a fresh sanitized prod clone; capture verification.
  2. Reset clone; re-apply Phase 0 + Phase 1 prep migrations.
  3. **Run 2:** repeat. Compare outputs; differences must be explainable.
  4. Sign-offs per `SAAS_PHASE1_DATA_RECONCILIATION_PLAN.md` §6.
- **Acceptance:** Both dry-runs match expected verification report; rehearsed rollback (snapshot restore) succeeds in both.
- **Tests:** N/A.
- **Rollback:** N/A.
- **Risk:** MEDIUM operationally; LOW technically given idempotency.

## TKT-P1-09 — Production maintenance-window run

- **Goal:** The real cutover.
- **Files affected:** none in source; production DB only.
- **Steps:**
  1. Snapshot.
  2. Pause writes (drain HTTP — not strictly required because backfill takes per-agency advisory locks; recommended to reduce contention).
  3. Apply migration + backfill (single window; backfill < 60 min for mid-sized prod).
  4. Run verification.
  5. Resume traffic. Behaviour unchanged (flags off; old code path).
  6. Post-mortem if anything unexpected; otherwise sign-off and archive logs.
- **Acceptance:** Verification green; no application errors; latency unchanged.
- **Tests:** Smoke tests + business-critical user journey suite (recruitment flow, attendance lock).
- **Rollback:** Restore snapshot. Backfill is destructive at step 5.4; no other recovery path.
- **Risk:** **HIGH** unless TKT-P1-08 was clean.

## TKT-P1-10 — Documentation + runbook

- **Goal:** Operations can run the backfill again (e.g. for a new region).
- **Files affected:**
  - `docs/runbooks/phase1-backfill.md` (new)
- **Acceptance:** Runbook covers preflight, queue triage, dry-run, prod run, verification, rollback.
- **Tests:** Two engineers independently follow it on a clean fixture.
- **Risk:** none.

---

## Sequencing summary

```
TKT-P1-01 (staging migration apply)
    └── TKT-P1-02 (prod replica preflight)
            ├── TKT-P1-03 (backfill script)
            │       ├── TKT-P1-04 (verifier)
            │       ├── TKT-P1-05 (seq snapshot)
            │       └── TKT-P1-07 (queue CLI)
            ├── TKT-P1-06 (package.json scripts)
            └── TKT-P1-10 (runbook, in parallel)
                    └── TKT-P1-08 (two staging dry-runs)
                            └── TKT-P1-09 (PROD)
```

Phase 1 is **complete** when TKT-P1-09 verification passes and the application has continued to behave identically across the cutover.

---

## Phase 1 → Phase 2 hand-off

After Phase 1, the following are true:

- `tenants` populated (one row per non-system Agency).
- Every customer Agency now has `tenantId` set; a Default `Agency` child exists per Tenant.
- `tenant_memberships` populated for every active user.
- Platform admins exist as `platform_admins` rows.
- `applicants.tenantId`, `employees.tenantId`, `vehicles.tenantId` populated for all rows.
- Identifier sequence snapshots stored.
- Reconciliation queue empty (or every row decided).

These are the preconditions for Phase 2 (application-layer enforcement, RLS audit-mode, JWT dual-claim issuance turn-on).

---

## Addendum — Blocker resolution sequence (added 2026-05-09 after first dry-run)

The first dry-run (`SAAS_PHASE1_STAGING_DRY_RUN_RESULTS.md`) showed the
algorithm is correct on the staging fixture. Before the prod run, these
gates must pass in this exact order:

```
G-01  Run preflight on a sanitized prod replica.
G-02  Triage findings → saas_reconciliation_queue.
G-03  Run all 5 reconciliation scripts in --apply mode against staging
      (writes only to saas_reconciliation_queue + Phase 1 prep columns).
G-04  Drain saas_reconciliation_queue (queue-cli sets decisions).
G-05  Re-run preflight; expect status ≤ WARN (only product-signed warns).
G-06  Run TKT-P1-05 seq-snapshot.
G-07  Run dry-run-tenant-backfill (--dry-run) on the sanitized clone.
G-08  Second dry-run on a fresh clone; compare verification.
G-09  Sign-offs per SAAS_PHASE1_DATA_RECONCILIATION_PLAN.md §6.
G-10  Schedule maintenance window.
G-11  TKT-P1-09 (production run).
```

### Reconciliation gates

| Gate | Owner | Pass criteria |
|------|-------|---------------|
| G-01 preflight on prod replica | Backend | Reports written; severity captured |
| G-02 triage | Data steward | Every BLOCKER finding has a queue row |
| G-03 recon --apply | Backend | All 5 scripts emit `OK`/`WARN`/`BLOCKER` consistent with G-02 |
| G-04 queue drain | Product + Security | `decision != 'pending'` for every row |
| G-05 preflight re-run | Backend | Status ≤ WARN |
| G-06 seq snapshot | Backend | `saas_phase1_seq_snapshot` populated; row-count matches `count(distinct tenantId × prefix × year × month)` |
| G-07 dry-run on prod clone | Backend | All 5 verification checks PASS; status `ROLLED_BACK` |
| G-08 dry-run #2 on a fresh clone | Backend | Verification matches G-07 |
| G-09 sign-offs | All | Five names recorded in `decided_by` per role |
| G-10 maintenance window | DevOps + SRE | Calendar + comms draft |

### Sign-off checklist (TKT-P1-09 entry gate)

- [ ] **Engineering lead** — preflight green; backfill rehearsed twice on a real-shape clone.
- [ ] **Product owner** — slug list + reserved slugs + catalog mode confirmed; queue decisions accepted.
- [ ] **Security** — PlatformAdmin grants confirmed; reconciliation accepted.
- [ ] **DevOps / SRE** — pre-migration snapshot; restore rehearsed.
- [ ] **Data steward** — `users.no-agency` and orphan dispositions confirmed.

### Go / No-Go criteria (objective)

**GO** if and only if all of the following are true:

1. Preflight overall ≤ `WARN`.
2. `users.duplicate-emails == 0`.
3. `users.invalid-email == 0`.
4. Every `users.no-agency` row has `decision != 'pending'`.
5. `<table>.orphan-owner == 0` for every model.
6. `saas_phase1_seq_snapshot` populated.
7. Two dry-runs (staging + sanitized prod clone) PASS.
8. Five sign-offs recorded.

**NO-GO** if any of the above is false. There are no partial GOs.

### Staging dry-run acceptance criteria

Each dry-run must produce `PHASE1_DRY_RUN_BACKFILL.md` with:

| Criterion | Threshold |
|---|---|
| Status | `ROLLED_BACK` (or `OK` for `--apply` on staging) |
| `tenants.count` verification | PASS |
| `users.with-agency-have-membership` | PASS |
| `users.no-agency.handled` | PASS |
| `applicants.tenantId-populated` | PASS |
| `employees.tenantId-populated` | PASS |
| Pre-run vs post-run table counts (existing tables) | byte-identical when `--dry-run` |
| Re-running the script | identical projection and verification |
