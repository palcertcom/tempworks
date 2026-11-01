# SaaS Implementation — Go / No-Go

**Decision:** **GO** for Phase 0 implementation, with the constraints listed below.

**Date:** 2026-05-09
**Branch:** `claude/design-multitenant-recruitment-8H42T`
**Decision basis:** six executed spikes (1–6), risk matrix, and seven ratified ADRs.

---

## Per-Spike Decision

| Spike | Status | Decision | Notes |
|---|---|---|---|
| 1 — Prisma + RLS | **PASS WITH CONSTRAINTS** | GO | Apply `NULLIF` policy template; ban `SET` without `LOCAL` |
| 2 — ALS context | **PASS WITH CONSTRAINTS** | GO | `TenantAwareJobProcessor` mandatory at all worker boundaries |
| 3 — Agency → Tenant | **PASS WITH CONSTRAINTS** | GO **for staging dry-run twice; production GO only after** | Pre-flight + snapshot + 2× staging dry-run before prod |
| 4 — Reports isolation | **PASS WITH CONSTRAINTS** | GO | Boot validator + field allowlist + ESLint allowlist mandatory |
| 5 — Storage signed URLs | **PASS WITH CONSTRAINTS** | GO | Cutover order: rekey → frontend → ACL flip; metric-gated |
| 6 — Background jobs | **PASS WITH CONSTRAINTS** | GO | Typed payloads + `groupKey: tenantId` rate limit |

**No spike returned FAIL or BLOCKED.**

---

## Phase 0 GO Criteria — Status

| Criterion | Required for GO | Met? |
|---|---|---|
| ADRs ratified | Yes | ✅ ADR-001 … ADR-007 merged |
| Architectural assumptions validated by spike | Yes | ✅ Six spikes executed |
| No FAIL spikes | Yes | ✅ |
| Risk matrix has no unmitigated CRITICAL | Yes | ✅ All criticals mitigated or accepted with operational controls |
| Phase 0 ticket breakdown ready | Yes | ✅ TKT-00..15 in `SAAS_PHASE0_TICKET_BREAKDOWN.md` |
| Pre-flight blockers identified | Yes | ✅ Captured in `SAAS_PHASE0_ARCHITECT_REVIEW.md` §6 |
| Pre-flight read-only audit run on prod replica | **No (TKT-15)** | ⏳ Required before Phase 1, **not** Phase 0 |
| Phase 0 produces zero runtime change | Yes | ✅ All flags default false |

---

## Constraints That Carry Into Phase 0

These are the spike-derived rules that must hold from day one of Phase 0 implementation:

1. **RLS template:** every policy uses `tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid`. (DB-1)
2. **`SET LOCAL` only:** plain `SET ` is forbidden via ESLint. (DB-2)
3. **Transactional `TenantPrismaService`:** every tenant-scoped op runs inside `prisma.$transaction(callback)`. (DB-3, DB-4)
4. **Two pools:** API on transaction-mode pool; workers/long-jobs on session-mode pool. (DB-5)
5. **`TenantAwareJobProcessor` base class** is the only authorized way to register tenant-scoped workers. (CTX-2)
6. **No module-load EventEmitter / `setInterval` patterns** in tenant-scoped modules. (CTX-3, CTX-4)
7. **`User.agencyId` becomes nullable**; document as legacy. (MIG-5)
8. **Reserved-word column names forbidden** (`grant` → `effect`/`is_grant`). (MIG-6)
9. **Mandatory pre-migration snapshot**; two staging dry-runs before prod. (MIG-7)
10. **`SOURCE_DEFS.tenantColumn` mandatory**; boot validator crashes on missing. (REP-1, REP-2)
11. **Single SQL composition surface** for reports (`reports/engine/build-query.ts`). (REP-1)
12. **Storage cutover order: rekey → frontend → ACL flip**, gated by `signed_url_issuance_ratio > 99% for 24 h`. (STO-1)
13. **Server resolves tenantId from ALS** for signed-URL minting; never from request body. (STO-3)
14. **TTL ≤ 5 min** for sensitive document signed URLs; **emails never embed signed URLs**. (STO-4)
15. **Frontend `useSignedUrl` cache** with `expiresAt - 30s` eviction + 403-aware refetch. (STO-5)
16. **Job payloads typed** to require `tenantId`. (JOB-1)
17. **ESLint allowlist** prevents non-tenant workers from importing `TenantPrismaService`. (JOB-2)
18. **BullMQ `groupKey: 'tenantId'` rate limiter** on high-volume queues. (JOB-3)
19. **JWKS exposes both keys for ≥ 30 days** during JWT key rotation. (OPS-4)
20. **PII redaction** is a Phase 5 deliverable and **not** blocking SaaS launch. (OPS-3, accepted)

---

## Blockers Before Phase 1 (NOT Phase 0)

These do not block Phase 0 ticket execution. They block the **Phase 1 → Phase 2 transition**.

- **B-PR-1** Pre-flight read-only audit on prod replica (TKT-15) — must surface duplicate emails or NULL agency_ids ahead of Phase 2 backfill.
- **B-PR-2** Product approval of slug-derivation rules and reserved-slug list.
- **B-PR-3** Two staging dry-runs of the agency-split migration on a sanitized prod clone.
- **B-PR-4** DevOps confirmation that production PgBouncer can serve both transaction-mode (API) and session-mode (workers) pools concurrently.
- **B-PR-5** `PlatformAdmin` rows enumerated and approved for backfill (every current `Agency.isSystem=true` user).
- **B-PR-6** DNS plan for `*.app.tempworks.com` wildcard cert (Phase 2 needs).
- **B-PR-7** Storage rekey job sized against actual production object count (estimate copy time, S3 API quotas).

---

## Recommended Next Engineering Step

**Begin Phase 0 ticket execution starting with TKT-00 (ADR ratification PR).**

In parallel:

- TKT-15 (read-only pre-flight) can run immediately on a prod replica to surface real-world data quirks early.
- The reports-engine refactor can be sized based on a manual count of `SOURCE_DEFS` entries (TKT-04 spike result is already in hand).
- DevOps engages on B-PR-4 (PgBouncer pool topology).

The first deployable artifact at end of Phase 0 is a build that has all foundations present, all flags off, and produces **byte-identical runtime behavior** to today.

---

## What Would Trigger a No-Go (re-evaluation)

- Pre-flight reveals duplicate `User.email` rows that cannot be reconciled (would block backfill).
- DevOps cannot run a session-mode pool alongside transaction-mode (would force reports/workers redesign).
- A surprise dependency (e.g. a third-party module-load `setInterval` we don't control) cannot be wrapped in ALS.
- Spike-001's overhead numbers are not reproducible against a real PgBouncer + DigitalOcean managed Postgres (re-spike with managed infra during early Phase 0).

None of these are observed today.

---

## Final Recommendation

> **Proceed with Phase 0 implementation.** Spike risks are mitigated, ADRs are aligned with measured reality, and the only remaining blockers are operational, scoped to Phase 1 entry. The architecture is ready.
