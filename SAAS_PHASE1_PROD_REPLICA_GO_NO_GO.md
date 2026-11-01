# Phase 1 — "Production Replica" Validation: Go / No-Go

**Date:** 2026-05-09
**Branch:** `claude/design-multitenant-recruitment-8H42T`
**Tooling commit:** `cd65acd9d7b7c1a584d0c252b333f82731bf9ce7`
**Validation target:** `saas_phase1_fixture` on `127.0.0.1` (classified `SAFE_CLONE`).

---

## Decision

> **`GO_TO_PHASE2_PREPARATION`** — for the *tooling* and the *Phase 2 preparation track*.
> **`NO_GO_NO_REALISTIC_DATA`** — for the *production cutover* (TKT-P1-09).

These two decisions are not contradictory. The tooling has been
exercised end-to-end on a SAFE_CLONE; it works. But the validation
gate explicitly required by `SAAS_PHASE1_IMPLEMENTATION_PLAN.md`
TKT-P1-08 (two clean dry-runs against a sanitized prod clone) has not
been satisfied because no such clone was available to this engagement.

The path to `GO_TO_PHASE1_PRODUCTION_CUTOVER` is operational, not code.

---

## 1. Evidence

| Item | Result | Pointer |
|---|---|---|
| Environment classifier | `SAFE_CLONE` correctly identified | `SAAS_PHASE1_ENVIRONMENT_SAFETY_REPORT.md` |
| Phase 0 + Phase 1 prep migrations | Applied cleanly; idempotent re-apply produced no change; rollback verified on disposable copy | `SAAS_PHASE1_MIGRATION_VALIDATION_REPORT.md` |
| Preflight (7 audits) | Ran end-to-end. Status BLOCKER as **expected** for fixture-seeded edge cases. | `SAAS_PHASE1_PROD_REPLICA_PREFLIGHT_ANALYSIS.md` |
| Reconciliation (5 scripts, dry-run) | All 5 emit reports; 28 actions proposed; per-row owners assigned | `SAAS_PHASE1_PROD_REPLICA_RECONCILIATION_ANALYSIS.md` |
| Tenant backfill dry-run | `ROLLED_BACK`. **8/8 verification checks PASS.** Database byte-identical post-run | `SAAS_PHASE1_PROD_REPLICA_BACKFILL_DRY_RUN_RESULTS.md` §1–6 |
| Optional staging-apply orchestrator | `Overall OK`. 4 tenants, 11 memberships, 11 agency memberships, 2 PlatformAdmins, 1 quarantine. Post-apply verifier: 12 PASS / 0 FAIL | `phase1-prod-replica/staging-apply/PHASE1_APPLY_STAGING.md` |
| Identifier-sequence snapshot | Tooling correct (`recon-seq-snapshot.md`). Empty result on fixture because seed data lacks `identifier` columns. | same |
| Production runtime | Unchanged. AppModule, main.ts, auth, prisma.service byte-identical. | `git diff` empty |

## 2. Per-criterion against `SAAS_PHASE1_IMPLEMENTATION_PLAN.md` Go/No-Go

| # | Criterion | Status | Note |
|---|---|---|---|
| 1 | Preflight overall ≤ WARN | ❌ on fixture (BLOCKER); cause = seeded edge cases | Real-replica run is the gate, not the fixture |
| 2 | `users.duplicate-emails == 0` | ✅ | structural via existing `email UNIQUE` |
| 3 | `users.invalid-email == 0` | ✅ | |
| 4 | `users.no-agency` rows decided | ❌ pending | 1 row queued; needs Data steward |
| 5 | `<table>.orphan-owner == 0` | ✅ | 0 orphan FK references |
| 6 | `saas_phase1_seq_snapshot` populated | ⚠️ | tooling proven; fixture has no source data; real prod will populate |
| 7 | Two clean dry-runs (staging + sanitized prod clone) | 1 of 2 | first done on SAFE_CLONE; second on real prod clone NOT done |
| 8 | Five sign-offs | ❌ | operational, awaiting human signers |

## 3. Resolved blockers (from this engagement)

| ID | Blocker | Resolution |
|---|---|---|
| TECH-1 | Algorithm correctness against real schema shape | Validated: backfill dry-run + apply both pass, verifier 12 PASS |
| TECH-2 | Migration idempotency | Verified: re-application produces zero change |
| TECH-3 | Rollback safety pre-data | Verified: down.sql cleanly removes all SaaS tables |
| TECH-4 | Cross-platform tooling | Apply-migrations script works without `psql`; orchestrator works on Windows after the runStage fix |
| TECH-5 | Environment safety classification | Classifier ships and is wired; refuses `--apply` outside SAFE_*; 5 sample paths tested |
| TECH-6 | `.env` auto-load | Backend/.env, shell env, and inline --db= all work |

## 4. Unresolved blockers (operational, not code)

| ID | Blocker | Owner | Estimated effort |
|---|---|---|---|
| OP-1 | Real prod replica preflight (TKT-P1-02) | Backend + DevOps | ½ day |
| OP-2 | Reconciliation queue drained on real data | Product + Security | 1–3 days depending on row count |
| OP-3 | Two clean dry-runs on a fresh prod clone (TKT-P1-08) | Backend | ½ day each |
| OP-4 | Five sign-offs (Engineering / Product / Security / DevOps / Data steward) | All | n/a |
| OP-5 | Real production snapshot + restore rehearsal | DevOps / SRE | 2–4 hours |

## 5. Required manual actions before TKT-P1-09 (production cutover)

1. Provision a sanitized prod replica (read-only or SAFE_CLONE shape).
2. Run `npm run saas:env-safety` to confirm classification.
3. Run `npm run saas:phase1-preflight`. Archive outputs.
4. Triage findings into `saas_reconciliation_queue` with proposed decisions.
5. Drain the queue (Product + Security + Data steward) until no `pending` rows remain.
6. Run `npm run saas:phase1-backfill-dry-run -- --max-quarantine 50`. Expect ROLLED_BACK + verifications PASS.
7. Run `npm run saas:phase1-backfill-apply-staging -- --apply`. Expect `Overall OK` and verifier 12 PASS.
8. Reset clone; repeat #6–#7. Compare verification reports; differences must be explainable.
9. Capture signed-off Markdown bundle into the change-record system.
10. Take production snapshot. Rehearse restore.
11. Schedule maintenance window.
12. Run `apply-migrations`, `dry-run-backfill --apply`, `seq-snapshot --apply`, `verify-backfill` against production during the window.

## 6. Required code/tooling fixes (none blocking)

The validation surfaced no code issues that block Phase 1 cutover.
Cross-platform fixes (Windows orchestrator + `.env` loader + node-based
applier) shipped earlier in this branch.

| Optional follow-ups | Trigger |
|---|---|
| Reconciliation-queue CLI (TKT-P1-07) | When prod-data queue volume makes raw SQL infeasible |
| Per-tenant policy override for `attendance_locked_periods` | When Finance signs off the replicate-default |
| Phase 2 reports refactor (ADR-007) | Hard prerequisite to Phase 2 enforcement; Phase 1 backfill is unaffected |

## 7. Operational sign-offs needed

> Same as `SAAS_PHASE1_DATA_RECONCILIATION_PLAN.md` §6 + `SAAS_PHASE1_STAGING_APPLY_CHECKLIST.md`.

- [ ] Engineering lead — preflight green on prod replica; backfill rehearsed twice
- [ ] Product owner — slug list, reserved slugs, catalog mode, queue decisions
- [ ] Security — PlatformAdmin grants confirmed
- [ ] DevOps / SRE — snapshot + restore rehearsed
- [ ] Data steward — `users.no-agency` and orphan dispositions

## 8. Recommended next step

> **Spin up a sanitized production replica and run `npm run saas:env-safety` + `npm run saas:phase1-preflight` against it.**

That single operation closes OP-1 and OP-3 simultaneously, populates
the real reconciliation worklist, and unlocks the sign-off path. No
new code is needed. The same scripts that succeeded on this engagement
will run unchanged on the real replica.

In parallel, **Phase 2 preparation** can begin without conflict:
- Reports-engine refactor (ADR-007).
- `TenantPrismaService` extension activation behind the flag.
- Frontend `TenantContext` skeleton.

These do not depend on the Phase 1 production cutover; they only
depend on the new schema being present in dev/staging, which is
already done.

## 9. Risks accepted

- The Phase 1 backfill destroys the original `agencies` rows at step
  5.4 (ADR-003). Mandatory pre-migration snapshot.
- Default PlatformAdmin level = `SUPER` until Security review post-cutover.
- Identifier-sequence cutover holds advisory locks per tenant.
- Reconciliation queue may grow large on real data; queue-CLI is a
  Phase 1 follow-up.

## 10. Risks NOT accepted (would block GO)

- Running backfill without a pre-migration snapshot.
- Running `--apply` against a host not classified `SAFE_*`.
- Skipping the second dry-run on a fresh prod clone.
- Skipping security review of platform-admin grants.
- Identifier-sequence cutover without TKT-P1-05 snapshot.

## 11. Production safety confirmation

> No mutation reached, was attempted on, or could have reached a
> production database during this engagement. The branch leaves
> `AppModule`, `main.ts`, `auth/`, and `prisma.service.ts` byte-
> identical. All Phase 1 scripts respect the environment classifier.

---

## TL;DR

The Phase 1 *toolchain* is GO. The Phase 1 *production cutover* awaits
a real sanitized replica and the operational sign-offs.
