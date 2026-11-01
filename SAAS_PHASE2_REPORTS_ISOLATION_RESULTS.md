# Phase 2.1 / 2.3 — Reports Isolation Test Results

**Run command:** `npm run saas:phase2-reports-isolation`
**Run target:** SAFE_CLONE staging fixture with 4 tenants populated.

---

## Headline (post Phase 2.5 rehearsal)

```
17/17 sources isolated.
```

Re-validated under the Phase 2.5 rollout rehearsal harness (env =
SAFE_CLONE, all four staging flags ON). The harness's full result:
`[rollout-rehearsal] 20/20 steps PASS`. No new isolation failure.

Plus, for every READY source:

- ✅ Cross-tenant filter rejected (caller cannot pass `tenantId` as a user filter).
- ✅ Forbidden operator rejected (`OR` not in the allow-list).
- ✅ All returned rows have `tenantId === tenantA.id`.
- ✅ **Phase 2.4: child rows do not leak through parent joins.** For
  every non-catalog joined alias, count of rows where the joined
  side's `tenantId` differs from tenant A is **0**.
- ✅ **Phase 2.4: parent rows cannot match B-tenant children.**
  Forcing tenant A's parent + tenant B's child via FK alone yields
  **0** rows — the join's tenant equality term refuses the match.
- ✅ **Phase 2.4: agency-scope reduces row count (or stays equal)**
  for every source that declares `agencyColumn`.
- ✅ **Phase 2.4: platform-admin bypass is audited.** No READY source
  currently declares `platformAdminOnly: true`. The harness logs the
  full list at the end of every run.
- ✅ **Phase 2.4: disabled sources fail closed** — the engine refuses
  any request for a DISABLED source.

For exact per-source rows-for-A, leak counts, agency-scope verdict,
and child/parent leak counts, see
`backend/reports/saas/phase2/reports-isolation-test.{json,md}`. Quick
view post-Phase 2.4:

| Group | Sources | Result |
|------|--------|--------|
| Phase 2.1 / 2.3 single-table | 7 sources | 7 × PASS (0 leaks) |
| Phase 2.4 joined (tenant-equality) | 8 sources (entity-keyed + employees_agencies) | 8 × PASS (0 leaks, 0 child-via-parent, 0 parent-via-child) |
| Phase 2.4 catalog-join | `documents_with_type`, `employees_documents_type` | 2 × PASS |
| DISABLED (engine refuses) | `document_types` | n/a |

## Methodology

For each READY source, the harness:

1. Picks the first two tenants alphabetically (A and B) from the `tenants` table.
2. Builds the safe WHERE for tenant A via the production builder (`buildTenantSafeWhere`).
3. Executes `SELECT id, tenantId FROM <primary> WHERE <safe-where>` against the live fixture.
4. Asserts every returned row's `tenantId` equals A's.
5. Also tries to attack the builder:
   - Pass `tenantId` as a user filter (would attempt cross-tenant access). Builder must throw `unknown field`.
   - Pass `OR` as an operator. Builder must throw `forbidden op`.

## Adversarial attempts logged

- Attempt: `filters = [{ field: 'tenantId', op: '=', value: <tenantB.id> }]` →  rejected (`unknown field`).
- Attempt: `filters = [{ field: 'email', op: 'OR' as any, value: 'x' }]` → rejected (`forbidden op`).
- Attempt: bind a SQL-laced UUID to `BuildContext.tenantId` → rejected (`Invalid UUID for BuildContext.tenantId`).

## Platform-admin path

Not exercised in this harness (no platform-admin source declares `platformAdminOnly: true` in the current registry). The contract is enforced in the unit tests:

```
test('platformAdminOnly source rejected for tenant member', PASS)
test('builder skips tenant filter only for platformAdmin && platformAdminOnly', PASS)
```

When a platform-admin-only source is added in Phase 3, this harness will pick it up automatically.

## Acceptance for cutover

Phase 3 per-source enablement requires N/N `PASS` against a sanitized prod clone. Post-Phase 2.4 the harness reports `17/17 sources isolated.` against the staging fixture with `phase24-extension.sql` applied. The fixture deliberately seeds same-shape rows in two tenants so the child-leak and parent-leak probes have something to attempt to violate; both stay at 0. Real-prod-clone re-run is the next operational gate.

## Negative-test catalogue (unit tests)

The 17 unit tests in `backend/src/saas/__validation__/reports.check.ts` cover the negative paths the integration harness can't exercise without a DB:

- registry rejects source missing `tenantColumn`
- registry rejects join without `tenant_id = tenant_id`
- builder forces `tenantId` as `$1`
- builder rejects invalid tenantId
- builder applies agency scope when `agencyIds` provided
- builder includes `deletedAt` filter for soft-delete sources
- builder rejects unknown field
- builder rejects forbidden op
- builder rejects adversarial string values
- `looksLikeUnsafeSql` catches comments and unions
- `platformAdminOnly` rejected for tenant member
- `ALLOWED_OPS` does NOT contain `OR`
- (+ 5 more)

All PASS. Run `npm run saas:validate` to reproduce.
