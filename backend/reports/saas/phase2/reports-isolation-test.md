# Phase 2.1 — Reports Isolation Test

Generated: 2026-05-09T17:18:52.621Z
Tenant A: `11111111-1111-1111-1111-111111111111` (Acme HR)
Tenant B: `44444444-4444-4444-4444-444444444444` (Empty Co)

- Sources passed: **17** / 17
- Sources failed: 0
- Sources skipped (disabled): 1

| Source | Status | Rows for A | Leaks from B | Cross-tenant filter rejected | Child leak via parent | Parent leak via child | Agency scope | Result |
|--------|--------|-----------:|-------------:|:-----------------------------:|----------------------:|----------------------:|:------------:|:------:|
| `employees` | READY | 16 | 0 | yes | 0 | 0 | true | PASS |
| `applicants` | READY | 41 | 0 | yes | 0 | 0 | true | PASS |
| `agencies` | READY | 1 | 0 | yes | 0 | 0 | true | PASS |
| `documents` | READY | 28 | 0 | yes | 0 | 0 | n/a | PASS |
| `compliance_alerts` | READY | 2 | 0 | yes | 0 | 0 | n/a | PASS |
| `work_permits` | READY | 1 | 0 | yes | 0 | 0 | n/a | PASS |
| `visas` | READY | 2 | 0 | yes | 0 | 0 | n/a | PASS |
| `document_types` | DISABLED | — | — | — | — | — | — | — |
| `employees_documents` | READY | 28 | 0 | yes | 0 | 0 | true | PASS |
| `employees_work_permits` | READY | 16 | 0 | yes | 0 | 0 | true | PASS |
| `employees_compliance` | READY | 16 | 0 | yes | 0 | 0 | true | PASS |
| `applicants_documents` | READY | 41 | 0 | yes | 0 | 0 | true | PASS |
| `applicants_compliance` | READY | 41 | 0 | yes | 0 | 0 | true | PASS |
| `employees_visas` | READY | 16 | 0 | yes | 0 | 0 | true | PASS |
| `applicants_visas` | READY | 41 | 0 | yes | 0 | 0 | true | PASS |
| `employees_agencies` | READY | 16 | 0 | yes | 0 | 0 | true | PASS |
| `documents_with_type` | READY | 28 | 0 | yes | 0 | 0 | n/a | PASS |
| `employees_documents_type` | READY | 28 | 0 | yes | 0 | 0 | true | PASS |

## Notes
- **document_types**: source disabled in safe mode