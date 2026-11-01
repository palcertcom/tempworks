# Phase 2.5 — Reports Staging Rollout Rehearsal

Generated: 2026-05-09T17:18:53.279Z
Aborted: no

- Steps PASS: **20** / 20
- Steps FAIL: 0

| # | Step | Result | Detail | Duration ms |
|--:|------|:------:|--------|------------:|
| 1 | environment classified safe (SAFE_CLONE or SAFE_STAGING) | PASS | classification=SAFE_CLONE, reason=localhost + fixture pattern (db=saas_phase1_fixture), host=127.0.0.1, db=saas_phase1_fixture, nodeEnv=unset | — |
| 2 | flag MULTI_TENANT_ENABLED = true | PASS | expected=true, got="true" | — |
| 3 | flag TENANT_SAFE_REPORTS_ENABLED = true | PASS | expected=true, got="true" | — |
| 4 | flag TENANT_CONTEXT_REQUIRED_FOR_SAFE_REPORTS = true | PASS | expected=true, got="true" | — |
| 5 | flag TENANT_CONTEXT_STAGING_ONLY = true | PASS | expected=true, got="true" | — |
| 6 | flag TENANT_PRISMA_ENFORCEMENT stays false | PASS | expected=false, got="(unset, defaults false)" | — |
| 7 | flag RLS_ENFORCEMENT stays false | PASS | expected=false, got="(unset, defaults false)" | — |
| 8 | context smoke (7 in-process cases) | PASS | context-smoke: 7/7 cases PASS | 3077 |
| 9 | reports equivalence (legacy ≡ safe) | PASS | reports-read-equivalence: PASS=17 WARN=0 FAIL=0 SKIPPED=1 (of 17 READY) | 1808 |
| 10 | reports isolation (N/N + 0 leaks) | PASS | reports-isolation-test: 17/17 sources isolated. | 1859 |
| 11 | integration: tenant resolvable | PASS | tenant=11111111-1111-1111-1111-111111111111 | — |
| 12 | integration: flag OFF means tenantSafeReportsEnabled() false | PASS | tenantSafeReportsEnabled=false | — |
| 13 | integration: flag ON + missing tenantId → rejected | PASS | composer rejected empty tenantId | — |
| 14 | integration: DISABLED source fails closed | PASS | document_types.status=DISABLED reason=Phase 2.4 — global catalog; reachable via joined sources (documents_with_type, employees_documents_type) using kind=catalog. Direct exposure pending product decision. | — |
| 15 | integration: READY source executes for valid tenant | PASS | rows=5, columns=1, params[0]=11111111-1111-1111-1111-111111111111 | — |
| 16 | integration: output shape compatible with legacy consumer ({columns, rows, total, page, limit}) | PASS | column[0]={"key":"id","label":"ID","type":"uuid"} | — |
| 17 | integration: concurrent ALS frames isolated | PASS | seen=["99999999-9999-9999-9999-999999999999","11111111-1111-1111-1111-111111111111"] | — |
| 18 | rollback: flags off → safe path disabled | PASS | safeReports=false multiTenant=false | — |
| 19 | rollback: legacy query still reads employees without tenant filter | PASS | count=29 | — |
| 20 | rollback: row counts unchanged (no mutation during rehearsal) | PASS | before={"tenants":"4","employees":"29","applicants":"72","documents":"52","agencies":"4"} after={"tenants":"4","employees":"29","applicants":"72","documents":"52","agencies":"4"} | — |