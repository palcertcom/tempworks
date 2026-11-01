# Phase 2 — Test Strategy

> Goal: prove tenant isolation per module, prove behaviour parity per migration, prove the eventual flag flip doesn't surface regressions.

---

## 1. Test pyramid

```
                ┌────────────────────────────────────┐
                │  end-to-end: staging smoke         │  per flag flip
                └────────────────────────────────────┘
              ┌────────────────────────────────────────┐
              │  integration: per-module isolation     │  per migration PR
              │  read-equivalence diffs                 │
              └────────────────────────────────────────┘
            ┌────────────────────────────────────────────┐
            │  unit: SaaS scaffolding                    │  every PR
            │  (28 → growing)                             │
            └────────────────────────────────────────────┘
            ┌────────────────────────────────────────────┐
            │  static: scanners (raw SQL, direct prisma) │  every PR
            └────────────────────────────────────────────┘
```

## 2. Two-tenant isolation tests

For every P0/P1/P2 module migration PR, a test of this shape under `backend/src/saas/__validation__/<module>.check.ts`:

```ts
suite('module-X-isolation');

test('tenant A list does not contain tenant B rows', async () => {
  const A = makeTenantFixture('a');
  const B = makeTenantFixture('b');
  await seedFor(A); await seedFor(B);
  await runAs(A, async () => {
    const rows = await tenantPrisma.client.X.findMany();
    expect(rows.every(r => r.tenantId === A.tenant.id)).toBe(true);
  });
});

test('tenant A cannot fetch tenant B row by id', async () => { ... });
test('writes inherit tenantId from ALS', async () => { ... });
test('cross-tenant unique constraint accepts duplicates across tenants', async () => { ... });
```

The harness `two-tenant-harness.ts` already exists; per-module fixtures are added per migration.

## 3. Reports isolation tests

Per-source. For every entry in the new registry:

- A two-tenant fixture with the same record IDs in both tenants.
- Run the source under tenant A's context → expect ONLY tenant-A rows.
- Run the same source with adversarial filters (`tenant_id` field, `OR 1=1`, identifier injection) → expect rejection.
- `EXPLAIN` plan asserts the `<primaryAlias>.<tenantColumn> = $1` term is the leading WHERE clause for partition pruning.

The 17 tests already in `backend/src/saas/__validation__/reports.check.ts` are the **scaffolding boot tests**; per-source tests are added during the Phase 3 cutover.

## 4. Agency-scope tests

For every agency-scoped read endpoint:

- Caller has `AgencyMembership` for `agency-1` only.
- Tenant has rows in `agency-1`, `agency-2`, `agency-3`.
- Endpoint returns only `agency-1` rows.
- Caller with `AgencyMembership` for `agency-1` AND `agency-2` returns rows from both.
- Caller with no `AgencyMembership` (full-tenant scope) returns all.
- Negative: caller cannot fetch a `agency-2` row by id.

## 5. Backfill integrity tests

Already shipped as `verify-tenant-backfill.ts` (12 invariant checks). Phase 2 adds two more:

- After `TENANT_PRISMA_ENFORCEMENT=true`, every existing API endpoint that previously listed by `agencyId` produces the same row count as before for an agency-scoped membership.
- `audit_logs` count for tenant A increases monotonically per audited mutation; no audit row from tenant B leaks into tenant A's stream.

## 6. Read-equivalence tests

Per `SAAS_PHASE2_PRISMA_REFACTOR_STRATEGY.md` §5. Mechanical:

```
1. Capture: 50 representative requests per module (via curl from a recorded user session).
2. Replay against the legacy code path; serialise responses sorted by id.
3. Apply migration.
4. Replay again; serialise.
5. Diff. Acceptable deltas: re-ordering when no ORDER BY; new tenant-leading
   index changing default sort. Anything else fails the PR.
```

A small CLI runner ships in Phase 2.1: `npm run saas:phase2-read-equivalence -- --module <name>`.

## 7. Mutation safety tests

Every migrated mutation:

- Idempotent retry test: fire the same `POST` twice with the same Idempotency-Key header → second returns the first response, no double-write.
- Tenant-pin test: try to update a row whose `tenantId != ctx.tenantId` → expect 404 (NOT 403; do not leak existence).
- Audit log presence test: every successful mutation results in one `audit_logs` row tagged with the right `tenantId`.

## 8. Export / download tests

Reports + documents only:

- Export an Excel report; assert the row IDs match the JSON-mode output of the same report (parity).
- Download a document that belongs to tenant A while authenticated as tenant B → 404, no signed URL issued, audit row recorded.
- Download a soft-deleted document without `recycle-bin:read` → 410 Gone (NOT 404; we don't pretend it never existed for legitimate users).

## 9. Worker / scheduler tests

Per-tenant fan-out (Phase 2.2):

- Producer enqueues N jobs (N = active tenant count) per scheduler tick.
- Worker pulls a job, runs handler inside ALS; assert `TenantContext.current().id === job.data.tenantId`.
- Retry test: simulated handler crash → BullMQ re-runs → tenant context preserved.
- Concurrent tenants test: 100 jobs across 3 tenants, concurrency 8 → 0 ALS bleed.

(Already validated for `TenantAwareJobProcessor` in `jobs.check.ts`.)

## 10. Fixture design

A canonical multi-tenant fixture for integration tests:

```
TenantFixture
├── tenant: { id, slug, ... }
├── 3 agencies (default + 2 sub)
├── 5 users (1 admin + 4 staff)
├── 30 employees (10 per agency)
├── 50 applicants (20 per agency)
├── 100 documents (entity-keyed)
├── 25 vehicles (8/9/8 per agency)
└── 1 platform admin user (cross-fixture; tagged `platformAdmin: true`)
```

Two such fixtures (`A`, `B`) are seeded for every isolation test. Same shape; different ids; same scale.

The fixture is **deterministic** — every UUID is derived from the fixture label (`makeTenantFixture('a')` always produces the same ids). This makes diffs in read-equivalence tests trivial to read.

## 11. CI gating plan

| Phase | What CI blocks on |
|---|---|
| 2.0 | `nest build`, `prisma validate`, `saas:validate`, `saas:schema-lint` |
| 2.1 | + per-source reports isolation tests (after Wave A migrations) |
| 2.2 | + worker/scheduler tests |
| 2.4 | + per-module isolation tests (P0/P1/P2 modules) |
| 2.5 | + read-equivalence smoke (one per high-traffic module) |
| 2.6 | + raw-SQL scanner --strict for migrated modules |
| 3.0 | + raw-SQL scanner --strict everywhere |

CI does **not** require a Postgres instance for the unit suites — those are pure JS. Integration tests (per-module isolation, read-equivalence) require Postgres; they are wired into a separate workflow that runs on PRs touching `backend/src/`.

## 12. Local developer loop

```sh
# Fast inner loop
npm run saas:validate            # 28+ unit tests; sub-second
npm run saas:schema-lint         # 0 issues
npm run saas:scan                # advisory; expect 826 historical sites
npm run saas:scan:raw-sql        # advisory; ~26 historical sites

# Per-module test
npm run saas:test:<module>       # added per migration

# Pre-PR
npm run saas:phase2-runtime-inventory   # baseline for the PR
npm run saas:phase2-reports-validate    # if touching reports

# After Phase 1 backfill on a SAFE_CLONE
npm run saas:phase1-verify-backfill
npm run saas:phase1-backfill-dry-run
```

## 13. Data-loss safety

Tests that **prevent** Phase 2 from introducing data loss:

- The migration PR template requires a section "Effect on tenant-A row counts under flag OFF" with a screenshot or log.
- Read-equivalence tests are blocking in CI.
- Mutation-safety tests cover the new `findUnique → findFirst` rule (the most common silent regression).

## 14. Done definition

A module is considered **Phase-2-test-ready** when:

- 1 isolation test (two-tenant; targeted at the module's primary entity) PASSES.
- 1 mutation-safety test (idempotent + tenant-pin) PASSES.
- 1 read-equivalence diff against legacy is empty.
- The module's raw-SQL scanner output is `0` BLOCKER findings (or every site has `@tenant-reviewed: <reason>`).
- The module's `prisma.X.<op>` count drops to `0` direct (or every site has `@tenant-reviewed`).
