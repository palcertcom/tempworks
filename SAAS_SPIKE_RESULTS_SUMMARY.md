# SaaS Spike Results Summary

**Six spikes ran. Five executed real code against a real Postgres 16 instance; one was an offline cryptographic / API-shape simulation. No production code was modified.**

| # | Spike | Status | Executed | Headline |
|---|---|---|---|---|
| 1 | Prisma + RLS + transaction-pooling | **PASS WITH CONSTRAINTS** | Yes (real Postgres + Node) | Transactional pattern works; RLS policy needs `NULLIF` wrapper; overhead becomes net positive at multi-query requests |
| 2 | AsyncLocalStorage propagation | **PASS WITH CONSTRAINTS** | Yes (real Node 22) | Propagates through every async path tested; worker threads expectedly do not |
| 3 | Agency → Tenant migration | **PASS WITH CONSTRAINTS** | Yes (real Postgres) | Backfill ran end-to-end; 0 orphan users; permission preservation invariant holds 10:10 |
| 4 | Reports isolation | **PASS WITH CONSTRAINTS** | Yes (real Postgres) | Mandatory `tenantColumn` + boot validator + parameterized + allowlisted = no leakage path |
| 5 | Storage signed URLs | **PASS WITH CONSTRAINTS** | Partial (offline SigV4) | Signing pattern works; cutover order corrected; emails must not embed signed URLs |
| 6 | Background-job tenant context | **PASS WITH CONSTRAINTS** | Yes (real Node simulation of BullMQ contract) | `TenantAwareJobProcessor` keeps context across concurrency / retry / delay / cron fanout |

**No spike returned FAIL.** Three spikes refuted previously feared risks (DB-3 perf, DB-4 leak, CTX-1 propagation). Ten new constraints have been added to ADRs.

---

## What Each Spike Validated and Invalidated

### Spike 1 (`docs/spikes/SPIKE-001-prisma-rls-validation.md`)

**Validated:**
- `SET LOCAL app.tenant_id = $1` correctly scopes RLS per transaction.
- `WITH CHECK` blocks cross-tenant inserts.
- Platform-admin role bypass policy works as designed.
- Connection reuse across mixed-tenant requests is leak-free under per-request transactions.
- Performance overhead is acceptable (-17% to +43% depending on queries-per-request).
- Savepoints preserve `SET LOCAL`.

**Invalidated / corrected:**
- `current_setting(...)::uuid` cast errors after a session-level RESET. Policies must use `NULLIF(...)`.
- Plain `SET` (without `LOCAL`) is dangerous under transaction-mode pooling — must be banned by lint.

### Spike 2 (`docs/spikes/SPIKE-002-als-context-validation.md`)

**Validated:**
- ALS propagates through `await`, `Promise.all`, `setTimeout`, `setImmediate`, `queueMicrotask`, EventEmitter, async iterators, error paths, detached timers.
- ALS overhead is below noise floor (+6 ns/call).

**Invalidated / corrected:**
- Worker threads do **not** propagate (expected, documented). `TenantAwareJobProcessor` re-enters ALS at the boundary.
- Module-load `setInterval` (current notifications scheduler pattern) has no ALS context — must move to BullMQ.

### Spike 3 (`docs/spikes/SPIKE-003-agency-tenant-dry-run.md`)

**Validated:**
- Reusing `Agency.id` as `Tenant.id` produces a clean backfill.
- Per-old-agency transactional reparenting is safe and idempotent (checkpoint table).
- Permission preservation: `pre_user_role_pairs == post_membership_role_pairs`.
- Pre-flight duplicate-email check is structurally enforced by today's schema.
- Per-tenant counts match pre-migration ground truth.

**Invalidated / corrected:**
- `users.agency_id NOT NULL` blocks system-user disposition; column must become nullable for legacy users (matches ADR-002 D-5).
- Reserved-word column names (`grant`) cause syntax errors; rename to `effect` or `is_grant`.

### Spike 4 (`docs/spikes/SPIKE-004-reports-isolation.md`)

**Validated:**
- Boot validator catches sources missing `tenantColumn`.
- Field allowlist prevents `tenant_id` from being a user-controllable filter target.
- Closed operator enum rejects `OR 1=1 --` and similar.
- Identifier quoting (`ident()`) rejects injection attempts.
- Adversarial values are safely parameterized (return 0 rows, no error).
- Tenant A and Tenant B query results have zero overlap.

### Spike 5 (`docs/spikes/SPIKE-005-storage-security-validation.md`)

**Validated:**
- AWS SigV4 presigned URL contains tenant-prefixed key; client cannot forge cross-tenant URL.
- TTL is enforced per issuance; signatures differ across TTLs.
- Cutover sequencing: rekey → frontend → ACL flip; metric-gated.

**Invalidated / corrected:**
- Original cutover order had ACL flip before frontend; reversed (architect review I-14 + this spike F-4).

### Spike 6 (`docs/spikes/SPIKE-006-job-isolation.md`)

**Validated:**
- 100 jobs across 3 tenants on concurrency 8: 0 leaks.
- Retry preserves `tenantId`: 50 jobs × ≤4 attempts × 30% crash rate, 0 mismatches.
- Cron fan-out: each tenant ran exactly N times across N ticks.

---

## Architectural Assumptions Validated

1. Shared DB + shared schema + `tenant_id` is implementable with acceptable overhead.
2. RLS as defense-in-depth is correct — application-layer guard is the primary filter; RLS catches mistakes.
3. AsyncLocalStorage is the right propagation mechanism for tenant context.
4. PgBouncer transaction-mode pooling is compatible with the chosen pattern.
5. The Agency → Tenant split (reusing IDs) is safe and reversible up to the deletion step.
6. Reports can be made structurally tenant-safe with discipline (no SQL string concatenation; boot validator).
7. Signed URLs replace public ACLs without breaking compatibility, given the corrected cutover order.
8. Background jobs preserve tenant context if and only if the base class re-enters ALS.

## Architectural Assumptions Invalidated (and updated)

1. ❌ "RLS policy `current_setting(...)::uuid` is sufficient" → **`NULLIF` wrap mandatory.**
2. ❌ "Per-query transactional overhead may be unacceptable" → **measured net positive at typical workloads.**
3. ❌ "ACL flip first, then frontend" → **reversed.**
4. ❌ "`agencyId NOT NULL` will hold post-migration" → **must become nullable for legacy users.**
5. ❌ "Workers inherit producer ALS" → **base class must re-enter; certain by node semantics.**

## Required ADR Changes

| ADR | Change |
|---|---|
| ADR-001 | Add the `NULLIF(current_setting('app.tenant_id', true), '')::uuid` template; ban session-level `SET`. |
| ADR-002 | Codify "`User.agencyId` becomes nullable" decision (already D-5; reinforced by SPIKE-003 F-6). |
| ADR-003 | Add a note that `MembershipPermissionOverride` column originally named `grant` must be renamed (`effect` or `is_grant`). |
| ADR-004 | Add `assertUuid()` requirement; ban plain `SET ` in `$executeRaw`; record measured overhead numbers. |
| ADR-005 | No change. |
| ADR-006 | Reaffirm cutover order (rekey → frontend → ACL flip) — the original §5 of ADR-006 already has this; cross-reference SPIKE-005 F-4. |
| ADR-007 | No change to substance; reference SPIKE-004 as the validation evidence; pin "boot validator must crash on missing `tenantColumn`". |

These updates are **edits**, not new ADRs, and can be done in a single follow-up PR after Phase 0 implementation begins (TKT-00).
