# Phase 1 — Go / No-Go Decision

**Date:** 2026-05-09
**Branch:** `claude/design-multitenant-recruitment-8H42T`
**Decision basis:** preflight + 5 reconciliation scripts + dry-run backfill, all executed against the staging clone (`saas_phase1_fixture`).

---

## Verdict

> **GO for Phase 1 *implementation work* (TKT-P1-01..07).
> NO-GO for the production cutover (TKT-P1-09) until the eight Go/No-Go criteria are met against a sanitized prod replica.**

The algorithm, scripts, and migration are validated. The only remaining gates are operational (run on real data; sign-offs; second dry-run).

---

## What was demonstrated

- Phase 1 prep migration applies cleanly, additively, and reversibly. ✅
- Pre-flight scripts run end-to-end and produce structured JSON+MD reports. ✅
- All 5 reconciliation scripts execute in dry-run mode and propose machine-readable actions. ✅
- Dry-run tenant backfill projects 4 tenants from 4 customer agencies; creates 11 memberships + 11 agency memberships + 11 membership roles + 2 platform admins; assigns `tenantId` to 72 applicants, 29 employees, 2 vehicles; quarantines 1 NULL-agency user. **All 5 verification checks PASS.** ✅
- Transaction rolls back at end of dry-run; database byte-identical. ✅
- Re-running scripts produces identical results (idempotent). ✅
- Production runtime untouched (`AppModule`, `main.ts`, `auth/`, `prisma/prisma.service.ts` all byte-identical). ✅
- Phase 0 validation suite still passes 28/28. ✅

---

## Per-criterion status (against staging fixture)

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Preflight overall ≤ WARN | ❌ BLOCKER | `PHASE1_PREFLIGHT_SUMMARY.md`: 3 BLOCKER suites (intentional fixture seeding) |
| 2 | `users.duplicate-emails == 0` | ✅ | `02-user-identity.json` |
| 3 | `users.invalid-email == 0` | ✅ | `02-user-identity.json` |
| 4 | `users.no-agency` rows decided | ❌ pending | 1 row, no decision yet |
| 5 | `<table>.orphan-owner == 0` | ✅ | `03-data-ownership.json` |
| 6 | `saas_phase1_seq_snapshot` populated | ❌ | TKT-P1-05 not yet executed |
| 7 | Two dry-runs PASS | 1 of 2 | First (staging fixture) PASS; second (sanitized prod clone) not run by this engagement |
| 8 | Five sign-offs recorded | ❌ | sign-off process is operational, not technical |

**Aggregate against staging fixture:** the staging fixture is intentionally messy (orphan user, code collisions, global sequences) so blockers are **expected** there. Against a sanitized prod clone — once the standard reconciliation has been performed — criteria 1, 4, 6 are achievable mechanically; criteria 7 and 8 are operational sign-offs.

---

## Unresolved blockers (operational, not technical)

| ID | Blocker | What blocks it | Owner | Effort |
|---|---|---|---|---|
| OP-1 | No real prod replica preflight executed | Engagement scope (staging fixture used as proxy) | Backend + DevOps | 1 day |
| OP-2 | TKT-P1-05 (`seq-snapshot`) not yet implemented | Phase 1 ticket pending | Backend | 1 day |
| OP-3 | Reconciliation queue has not been drained on real data | Dependent on OP-1 | Product + Security | 1–3 days |
| OP-4 | Second dry-run on fresh prod clone | Dependent on OP-1, OP-3 | Backend | 0.5 day |
| OP-5 | Five sign-offs | Dependent on OP-1..OP-4 | All | n/a |

**None of these blockers require code changes** to the artifacts already shipped in this branch.

---

## Resolved blockers

| ID | Original blocker | Resolution mechanism | Status |
|---|---|---|---|
| TECH-1 | Algorithm correctness uncertain | Dry-run on staging fixture; all 5 verifications PASS | ✅ |
| TECH-2 | Membership status enum cast | Explicit `::"MembershipStatus"` casts | ✅ |
| TECH-3 | Slug derivation rules ambiguous | Codified in Recon B + reserved-slug list | ✅ |
| TECH-4 | Idempotency uncertain | `agency_split_progress` checkpoint; `ON CONFLICT DO NOTHING` everywhere | ✅ |
| TECH-5 | Rollback unproven | Dry-run rolls back transaction; verified database byte-identical | ✅ |
| TECH-6 | Quarantine path uncertain | Recon scripts + dry-run write to `saas_reconciliation_queue` with `decision='pending'`; no destructive action | ✅ |

---

## Manual decisions still needed

1. **Disposition of `users.no-agency` rows on real data.** Default proposal: `assign:<tenantId>` if the user is operationally part of one tenant; else `deactivate`.
2. **Final tenant slugs.** Default: kebab-case + collision suffix; product reviews the projection in Recon B's queue entries before backfill commits.
3. **PlatformAdmin levels.** Default: SUPER for everyone migrated from `Agency.isSystem=true`; security downgrades selected ones to SUPPORT/OPERATOR within 30 days post-cutover.
4. **AttendanceLockedPeriod replication.** Default: replicate every existing global lock to every tenant (preserves status quo). Finance can override.
5. **Catalog vs replicate** for `Workshop`, `MaintenanceType`, `NotificationRule`, `DocumentType`. Default: catalog (locked in ADR-004 §6).
6. **Soft-deleted user disposition.** Default: skip from membership backfill (status will be `INACTIVE` regardless).

All defaults are recorded in the corresponding scripts' `proposedDecision` field and visible to Product before any data moves.

---

## Risks accepted

- **Backfill destroys the original `Agency` row** at step 5.4. Mandatory pre-migration snapshot. (ADR-003 D-21.)
- **`User.agencyId` becomes nullable** for legacy users; supported through Phase 4. (ADR-002 D-5.)
- **Identifier-sequence cutover holds advisory locks per tenant** during the dual-key window. Estimated < 1 minute per tenant; scaled across hundreds of tenants this is sub-hour.
- **Reconciliation queue may grow large** on a real prod replica. Acceptable; Recon scripts are idempotent and the queue is paginated.
- **Default PlatformAdmin level = SUPER** carries elevated blast radius until security review. Mitigated by step-up MFA + audit logging (Phase 3).

## Risks NOT accepted (would block GO)

- **Running backfill without a pre-migration snapshot.** Refused outright.
- **Running `--apply` against any host not on the staging allowlist** (without `ALLOW_NON_STAGING_APPLY`). Script refuses.
- **Skipping the second dry-run** (OP-4). Cannot be waived.
- **Skipping security review of platform-admin grants.** Cannot be waived.
- **Identifier-sequence cutover without TKT-P1-05.** Cannot be waived; data corruption risk.

---

## Phase 1 implementation entry decision

**Phase 1 implementation work is GO** for tickets TKT-P1-01 (staging migration apply), TKT-P1-02 (preflight on real replica), TKT-P1-03 (backfill script productionisation; the dry-run script in this branch is its skeleton), TKT-P1-04 (verifier), TKT-P1-05 (seq snapshot), TKT-P1-06 (package.json wiring), TKT-P1-07 (queue CLI), TKT-P1-10 (runbook). These can begin immediately on this branch.

**Phase 1 production cutover (TKT-P1-09) is NO-GO** until OP-1..OP-5 land. Estimated total ops effort: 4–6 working days on top of the implementation tickets.

---

## Validation snapshot (this engagement)

| Check | Result |
|---|---|
| `nest build` | clean |
| `npm run saas:validate` | 28/28 PASS |
| `npm run saas:schema-lint` | 0 issues |
| `npm run saas:phase1-preflight` against fixture | runs; status BLOCKER (intentional) |
| 5 recon scripts (dry-run) against fixture | all run; statuses match preflight |
| `dry-run-tenant-backfill` against fixture | ROLLED_BACK; verifications PASS |
| `git diff src/app.module.ts src/main.ts src/auth/ src/prisma/prisma.service.ts` | empty |

The system is ready for Phase 1 implementation work. The system is not yet ready for the production cutover. The path between the two is documented and gated.
