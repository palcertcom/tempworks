# Phase 2.1 — Reports Read-Equivalence

Generated: 2026-05-09T17:18:50.760Z
Tenant: `11111111-1111-1111-1111-111111111111`

- Total sources: 18
- READY: 17 (DISABLED: 1)
- Equivalent (legacy ≡ safe): **17**
- With deltas: 0
- Errors: 0
- Verdicts: PASS=17 WARN=0 FAIL=0 SKIPPED=1

| Source | Status | Verdict | Legacy n | Safe n | Joined L | Joined S | Equal | onlyLegacy | onlySafe | Pagination | Sort | Notes |
|--------|--------|:-------:|---------:|-------:|---------:|---------:|:-----:|-----------:|---------:|:----------:|:----:|-------|
| `employees` | READY | PASS | 16 | 16 | 16 | 16 | yes | 0 | 0 | yes | yes | |
| `applicants` | READY | PASS | 41 | 41 | 41 | 41 | yes | 0 | 0 | yes | yes | |
| `agencies` | READY | PASS | 1 | 1 | 1 | 1 | yes | 0 | 0 | yes | yes | |
| `documents` | READY | PASS | 28 | 28 | 28 | 28 | yes | 0 | 0 | yes | yes | |
| `compliance_alerts` | READY | PASS | 2 | 2 | 2 | 2 | yes | 0 | 0 | yes | yes | |
| `work_permits` | READY | PASS | 1 | 1 | 1 | 1 | yes | 0 | 0 | yes | yes | |
| `visas` | READY | PASS | 2 | 2 | 2 | 2 | yes | 0 | 0 | yes | yes | |
| `document_types` | DISABLED | SKIPPED | — | — | — | — | — | — | — | — | — | source not yet enabled in safe mode |
| `employees_documents` | READY | PASS | 16 | 16 | 28 | 28 | yes | 0 | 0 | yes | yes | |
| `employees_work_permits` | READY | PASS | 16 | 16 | 16 | 16 | yes | 0 | 0 | yes | yes | |
| `employees_compliance` | READY | PASS | 16 | 16 | 16 | 16 | yes | 0 | 0 | yes | yes | |
| `applicants_documents` | READY | PASS | 41 | 41 | 41 | 41 | yes | 0 | 0 | yes | yes | |
| `applicants_compliance` | READY | PASS | 41 | 41 | 41 | 41 | yes | 0 | 0 | yes | yes | |
| `employees_visas` | READY | PASS | 16 | 16 | 16 | 16 | yes | 0 | 0 | yes | yes | |
| `applicants_visas` | READY | PASS | 41 | 41 | 41 | 41 | yes | 0 | 0 | yes | yes | |
| `employees_agencies` | READY | PASS | 16 | 16 | 16 | 16 | yes | 0 | 0 | yes | yes | |
| `documents_with_type` | READY | PASS | 28 | 28 | 28 | 28 | yes | 0 | 0 | yes | yes | |
| `employees_documents_type` | READY | PASS | 16 | 16 | 28 | 28 | yes | 0 | 0 | yes | yes | |