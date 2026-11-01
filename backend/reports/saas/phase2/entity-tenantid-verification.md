# Phase 2.3 — Entity-Keyed `tenantId` Verification

Generated: 2026-05-09T17:05:22.199Z
Database: `postgres://postgres@127.0.0.1/saas_phase1_fixture?sslmode=disable`

- Models verified: 15
- Models PASSED: **7**
- Models FAILED: 8
- Mismatched rows (tenantId ≠ parent): 0
- Rows with tenantId set: 61
- Rows with tenantId NULL: 2
- Unexplained NULLs (parent has tenantId but row does not): 0

| Model | Result | Mismatch | With tid | Without tid | Without parent tid | Unexplained NULLs |
|-------|--------|---------:|---------:|------------:|-------------------:|------------------:|
| `documents` | PASS | 0 | 52 | 0 | 0 | 0 |
| `work_permits` | PASS | 0 | 1 | 0 | 0 | 0 |
| `visas` | PASS | 0 | 2 | 0 | 0 | 0 |
| `compliance_alerts` | PASS | 0 | 2 | 0 | 0 | 0 |
| `financial_records` | PASS | 0 | 1 | 0 | 0 | 0 |
| `financial_record_attachments` | **ERROR** | 0 | 0 | 0 | 0 | 0 — relation "financial_record_attachments" does not exist |
| `financial_record_deductions` | **ERROR** | 0 | 0 | 0 | 0 | 0 — relation "financial_record_deductions" does not exist |
| `attendance_records` | PASS | 0 | 0 | 0 | 0 | 0 |
| `notifications` | PASS | 0 | 3 | 2 | 2 | 0 |
| `vehicle_documents` | **ERROR** | 0 | 0 | 0 | 0 | 0 — relation "vehicle_documents" does not exist |
| `maintenance_records` | **ERROR** | 0 | 0 | 0 | 0 | 0 — relation "maintenance_records" does not exist |
| `candidate_workflow_assignments` | **ERROR** | 0 | 0 | 0 | 0 | 0 — relation "candidate_workflow_assignments" does not exist |
| `employee_workflow_assignments` | **ERROR** | 0 | 0 | 0 | 0 | 0 — relation "employee_workflow_assignments" does not exist |
| `employee_work_history` | **ERROR** | 0 | 0 | 0 | 0 | 0 — relation "employee_work_history" does not exist |
| `employee_work_history_attachments` | **ERROR** | 0 | 0 | 0 | 0 | 0 — relation "employee_work_history_attachments" does not exist |