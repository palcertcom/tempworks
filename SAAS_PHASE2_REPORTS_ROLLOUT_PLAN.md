# Phase 2.1 / 2.3 / 2.4 — Reports Engine Rollout Plan

> Goal: enable `TENANT_SAFE_REPORTS_ENABLED=true` per environment, per source, with a clear rollback at every step.

---

## 1. Pre-rollout checklist (one-time)

- [ ] Phase 1 backfill applied on the target environment (`tenants` populated; `tenant_memberships` populated).
- [ ] `MULTI_TENANT_ENABLED=true` planned for the same environment (the safe path requires `TenantContext`).
- [ ] `TenantContextMiddleware` registered in `AppModule` (Phase 2.5 deliverable).
- [ ] `npm run saas:env-safety` returns `SAFE_CLONE` or `SAFE_STAGING`.
- [ ] `npm run saas:phase2-reports-equivalence` returns `PASS=N WARN=0 FAIL=0` for every READY source on this environment.
- [ ] `npm run saas:phase2-reports-isolation` returns `N/N sources isolated`, including 0 child-leak and 0 parent-leak counts.
- [ ] For every Phase 2.4 joined source, the registry's structuredOn renders cleanly (`saas:phase2-reports-validate` or in-process registry validation; see `SAAS_PHASE2_REPORTS_JOIN_SAFETY_DESIGN.md`).
- [ ] `phase24-extension.sql` is NOT applied on production (it adds fixture tables only — production already has them).
- [ ] **Phase 2.5 rehearsal:** `npm run saas:phase2-reports-rollout-rehearsal` reports `N/N steps PASS` on the same DB.
- [ ] Operator has read `SAAS_PHASE2_REPORTS_STAGING_ROLLOUT_RUNBOOK.md` and `SAAS_PHASE2_REPORTS_STAGING_OBSERVABILITY_CHECKLIST.md`.
- [ ] Reports team code-owner has signed off on `SAAS_PHASE2_REPORTS_SOURCE_STATUS.md`.

## 2. Per-environment rollout

```
dev   → CI    → staging-A → staging-B → production
```

Each step has a 24-hour observation window before the next.

### 2.1 dev (per-engineer local)

```sh
TENANT_SAFE_REPORTS_ENABLED=true \
MULTI_TENANT_ENABLED=true \
DATABASE_URL=postgres://localhost/.../?sslmode=disable \
npm start
```

Manual smoke: open the UI, run an `employees` report. Verify row counts match a legacy run.

### 2.2 CI (test pipeline)

The harnesses run nightly on CI's staging fixture. If `0 delta, 0 errors` regresses, an alert fires; the rollout to staging is blocked.

### 2.3 staging-A

```sh
# DevOps applies the env var via deploy config — not a code change.
TENANT_SAFE_REPORTS_ENABLED=true
MULTI_TENANT_ENABLED=true
```

Observation window: 24h. Acceptance:

- No regression in `reports.tenant_safe.errors` metric.
- No regression in p95 report-run latency.
- No regression in row counts on a curated set of 5 representative reports.

### 2.4 staging-B

Same as staging-A with a fresh DB clone. Verifies no environment drift.

### 2.5 production

Production is **per-tenant** before being global:

1. Pick a small pilot tenant.
2. Set `TENANT_SAFE_REPORTS_ENABLED=true` for that tenant only via a tenant-level override (`tenants.featureFlags.tenantSafeReports = true` — Phase 4 capability).

**Until Phase 4 ships per-tenant overrides**, production cutover is a single flip across all tenants. That's why we wait for staging-A + staging-B + the dual-claim window before flipping prod.

## 3. Rollback per phase

| Phase | Rollback action | RTO | Data impact |
|---|---|---|---|
| dev | unset env var | seconds | none |
| CI | revert PR | minutes | none |
| staging-A/B | redeploy with `TENANT_SAFE_REPORTS_ENABLED=false` | minutes | none |
| production | redeploy with flag off | minutes | none |
| (any) | revert this commit | minutes | none — Phase 0–1 schema is unaffected |

There is no data migration. Rollback is config / deploy only.

## 4. Per-source rollout (within an environment)

Sources move from DISABLED → READY one at a time. As of Phase 2.4,
17 of 18 sources are READY (the only DISABLED one is `document_types`,
which is intentionally reachable only via joined sources).

| Wave | Sources | Phase | Status |
|---|---|---|---|
| Wave A | `employees`, `applicants`, `agencies` | 2.1 | READY |
| Wave B | `documents`, `compliance_alerts`, `work_permits`, `visas` | 2.3 | READY |
| Wave C | `employees_documents`, `employees_work_permits`, `employees_compliance`, `applicants_documents`, `applicants_compliance`, `employees_visas`, `applicants_visas`, `employees_agencies`, `documents_with_type`, `employees_documents_type` | 2.4 | READY |
| Wave D | `document_types` direct exposure | TBD | DISABLED — pending product |

For each new READY source: equivalence harness must report `PASS`,
isolation harness must report `PASS` with `0` for child-leak and
parent-leak counts. Any FAIL blocks the source from rolling forward.

DISABLED sources still go through the legacy path during this period — there is **no behaviour regression**.

## 5. Monitoring

- `reports.path` — counter labelled `legacy` / `tenant_safe` per request.
- `reports.tenant_safe.errors` — counter labelled by error class:
  - `disabled_source`
  - `unknown_source`
  - `missing_tenant_context`
  - `builder_error`
- `reports.run_ms` — histogram, labelled by path.

Alert thresholds (production):

- `reports.tenant_safe.errors{class!~"disabled_source|unknown_source"}` > 5 / 5min → page.
- `reports.tenant_safe.run_ms.p95` > 1.5 × legacy.p95 for 30 min → warn.

## 6. Communications

- **Day 0 of staging cutover:** post in `#eng-saas` channel; record in change log.
- **Day 7:** post observation summary; if green, schedule production cutover.
- **Production cutover:** maintenance window booked; #eng-saas + #ops paged; runbook open.
- **Any rollback:** immediate post-mortem within 5 working days.

## 7. Acceptance for "Phase 2.1 complete in production"

- `TENANT_SAFE_REPORTS_ENABLED=true` in prod for ≥ 14 days.
- Zero `tenant_safe.errors` of class `missing_tenant_context` or `builder_error` in that window.
- Zero customer-reported reports incidents.
- Read-equivalence harness re-runs nightly with `0 delta, 0 errors` for every READY source.

When all four conditions hold, Phase 2.1 is "done in prod" and Phase 2.3 (entity-keyed denorm) can begin in earnest. The legacy reports engine is **not** removed until Phase 3.

## 8. Risks specific to rollout

| Risk | Mitigation |
|---|---|
| Operator enables `TENANT_SAFE_REPORTS_ENABLED` without `MULTI_TENANT_ENABLED` | Safe path fails loud (`REPORT.TENANT_CONTEXT_REQUIRED`); easy to recover by adding the second flag |
| A user opens a report that targets a DISABLED source | Legacy path runs; behaviour unchanged |
| Phase 1 backfill incomplete on a tenant (`tenantId` NULL on some rows) | Safe path filters those rows out (`tenantId = $1` filters NULL); user sees fewer rows. Equivalence harness flags this as a delta during pre-flight. |
| Operator forgets to run the equivalence/isolation harnesses pre-flip | The flip is a config change; we cannot prevent it. Mitigation: deploy gate + runbook step. |
| Long-running reports time out under the safe path | Same query plan as legacy + tenant filter; partition pruning means EXPLAIN cost is equal or lower. Monitor `run_ms` histogram. |

## 9. Files governing this rollout

- `SAAS_PHASE2_REPORTS_ENGINE_IMPLEMENTATION.md` — what was built
- `SAAS_PHASE2_REPORTS_SOURCE_STATUS.md` — current per-source readiness
- `SAAS_PHASE2_REPORTS_EQUIVALENCE_RESULTS.md` — pre-flight equivalence
- `SAAS_PHASE2_REPORTS_ISOLATION_RESULTS.md` — pre-flight isolation
- this file — rollout sequence
