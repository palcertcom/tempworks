# Phase 2.5 — Reports Staging Observability Checklist

> What to watch when `TENANT_SAFE_REPORTS_ENABLED=true` is in effect on
> a staging-classified host. Every entry has an expected steady-state
> value and a rollback trigger.

---

## 1. Logs

| Pattern | Expected | Action if seen |
|---|---|---|
| `[FeatureFlags] Phase 0 feature flags: MULTI_TENANT_ENABLED=true ... TENANT_SAFE_REPORTS_ENABLED=true ...` | once at boot, with the rehearsal flag profile | none — confirms intended state |
| `[TenantContextMiddleware] [ACTIVE] MULTI_TENANT_ENABLED=true, env=SAFE_CLONE\|SAFE_STAGING` | once at boot | none |
| `[TenantContextMiddleware] [FAIL-FAST] MULTI_TENANT_ENABLED=true outside staging` | NEVER | **immediate rollback** — set `MULTI_TENANT_ENABLED=false` and redeploy; the env classifier disagrees with the operator |
| `code: 'REPORT.TENANT_CONTEXT_REQUIRED'` | rare; only when a caller hits the safe route without an attached tenant | investigate caller; do not roll back unless rate > 1% |
| `code: 'REPORT.TENANT_SAFE_SOURCE_DISABLED'` | only when a caller asks for a DISABLED source under safe mode | confirm registry intent; benign if frontend has the source allow-listed |
| Stack traces from `@tenant-reviewed: tenant-safe-report-runtime` lines | NEVER | rollback — the safe SQL is failing at runtime |

## 2. Metrics

| Metric | Expected | Rollback trigger |
|---|---|---|
| `reports.path{path="legacy"}` | drops from 100% to < 100% as flag flips on | n/a |
| `reports.path{path="tenant_safe"}` | rises after flag on | n/a |
| `reports.path{path="legacy_fallback"}` | only when `TENANT_CONTEXT_REQUIRED_FOR_SAFE_REPORTS=false`; should be near 0 once context middleware is up | sustained >2% for 30 min after `…REQUIRED=true` flipped |
| `reports.errors.tenant_context_required` | < 0.1% of reports requests | sustained >1% for 15 min |
| `reports.errors.disabled_source` | proportional to UI exposure of DISABLED keys | unexpected spike |
| `reports.duration.p95` | within 1.5× legacy p95 (the safe path adds one WHERE term, no joins beyond the registered ones) | safe-path p95 > 2× legacy for 15 min |
| `db.query_count_per_request` | unchanged (one main + one count) | doubling sustained |
| `process.uptime_seconds` | rises monotonically | restart loop = rollback |

## 3. Error codes (fail-loud surface)

| Code | Source | Meaning | Action |
|------|--------|---------|--------|
| `REPORT.TENANT_CONTEXT_REQUIRED` | `ReportsService.executeReportTenantSafe` | flag ON, no tenant in ALS | check middleware wiring; possibly resolve via legacy fallback by setting `TENANT_CONTEXT_REQUIRED_FOR_SAFE_REPORTS=false` |
| `REPORT.TENANT_SAFE_SOURCE_DISABLED` | same | source not READY in safe registry | confirm intent; if accidental, flip in registry |
| `bad identifier`, `bad alias`, `bad column` | `sql-guards.ts` | registry contains non-identifier strings | block release; never reaches prod with the boot validator |
| `forbidden op`, `refusing unsafe value` | `where-builder.ts` | adversarial filter request | rate-limit the offending caller; investigate UI source |

## 4. Slow query indicators

The safe path generates SQL of the form

```
SELECT … FROM <primary> [<join> …] WHERE <primary>.tenantId=$1 [AND <agency> IN …] [AND deletedAt IS NULL] [<filters>] [ORDER BY] LIMIT … OFFSET …
```

Watch for:

- Sequential scan on `<primary>` (Phase 1 added the `tenantId` index; missing index = ops bug).
- LEFT JOIN on `documents` without using `documents_tenantId_idx`.
- `OFFSET >> 10_000` — the composer caps `limit` at 10_000; if `OFFSET` outpaces the page index, the page is too deep — refactor to keyset pagination.

## 5. Tenant-context-missing events

A request with `MULTI_TENANT_ENABLED=true` MUST carry a tenant context.
Causes when the count is non-zero:

1. Missing `X-Tenant-Id` header from a non-platform-admin caller.
2. JWT did not resolve to a tenant via the resolver chain.
3. Cron / background job invoked the reports surface — those need
   `withRequestContext({ requestId, ... })` and an explicit `TenantContext.attach`.

Threshold: any single request producing this for a logged-in user is a
bug; > 1% over 15 min triggers rollback.

## 6. Disabled-source events

The registry's DISABLED list as of Phase 2.4 contains exactly:

- `document_types`

A spike in `REPORT.TENANT_SAFE_SOURCE_DISABLED` for any other source
indicates registry drift between code and runtime — block the release
until both agree.

## 7. Isolation-alert events

The isolation harness ships a CI-time check, not a runtime one. The
runtime equivalent is:

- Every safe-path query starts with `<primaryAlias>.<tenantColumn> = $1`.
  A unit-test of the composer asserts this. A runtime check would be
  redundant and costly.
- Every join in the registry has `tenant_id = tenant_id` enforced at
  boot. A runtime divergence is impossible without a code change.

If a security review wants runtime confirmation: enable Postgres
`pg_stat_statements` and grep for queries lacking a `tenantId =` filter
on a tenant-scoped table. Out of scope for this rehearsal.

## 8. Rollback trigger thresholds (consolidated)

| Trigger | Action |
|---|---|
| `[FAIL-FAST]` log line in any environment | **rollback now**: deploy `MULTI_TENANT_ENABLED=false` |
| `reports.errors.tenant_context_required` > 1% for 15 min | rollback `TENANT_SAFE_REPORTS_ENABLED=false` |
| Safe-path p95 > 2× legacy p95 for 15 min | rollback; investigate query plans |
| Process restart loop attributable to safe runtime | rollback |
| Any mismatch in equivalence-harness re-run on prod-clone | block flag flip; do not roll forward |
| Cross-tenant data sighting in QA | rollback + incident |

## 9. Sign-off gate

A rehearsal is "green" when:

- `npm run saas:phase2-reports-rollout-rehearsal` returns 20/20 PASS
  on the SAFE_CLONE / SAFE_STAGING DB.
- All log expectations above match the actual log output.
- No metric is in its rollback range.
- The on-call has the rollback command in their pager runbook.

The rollback command is:

```sh
# On the staging host
export TENANT_SAFE_REPORTS_ENABLED=false
# Redeploy / restart the process. The legacy engine takes over
# transparently within seconds.
```
