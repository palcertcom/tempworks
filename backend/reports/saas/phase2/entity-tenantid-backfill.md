# Phase 2.3 — Entity-Keyed `tenantId` Backfill

Generated: 2026-05-09T16:42:50.903Z
Mode: `apply`
Database: `postgres://postgres@127.0.0.1/saas_phase1_fixture?sslmode=disable`

- Models processed: 15
- Rows backfilled (apply): 56
- Rows still pending dry-run count: 0
- Rows quarantined (unresolved parent): 2
- Reconciliation queue rows inserted: 2
- Errors: 11

| Model | Parent path | Applied | Pending | Quarantined |
|-------|-------------|--------:|--------:|------------:|
| `documents` | documents.entityId → employees|applicants|agencies → tenantId | 52 | 0 | 0 |
| `work_permits` | work_permits.employeeId → employees.tenantId | 0 | 0 | 0 ⚠️ table not present (skipped) |
| `visas` | visas.entityId → employees|applicants → tenantId | 0 | 0 | 0 ⚠️ table not present (skipped) |
| `compliance_alerts` | compliance_alerts.entityId → employees|applicants → tenantId | 0 | 0 | 0 ⚠️ table not present (skipped) |
| `financial_records` | financial_records.entityId → employees|applicants → tenantId | 1 | 0 | 0 |
| `financial_record_attachments` | financial_record_attachments.financialRecordId → financial_records.tenantId | 0 | 0 | 0 ⚠️ table not present (skipped) |
| `financial_record_deductions` | financial_record_deductions.financialRecordId → financial_records.tenantId | 0 | 0 | 0 ⚠️ table not present (skipped) |
| `attendance_records` | attendance_records.employeeId → employees.tenantId | 0 | 0 | 0 |
| `notifications` | notifications.userId → users.agencyId → agencies.tenantId | 3 | 0 | 2 |
| `vehicle_documents` | vehicle_documents.vehicleId → vehicles.tenantId | 0 | 0 | 0 ⚠️ table not present (skipped) |
| `maintenance_records` | maintenance_records.vehicleId → vehicles.tenantId | 0 | 0 | 0 ⚠️ table not present (skipped) |
| `candidate_workflow_assignments` | candidate_workflow_assignments.candidateId → applicants.tenantId | 0 | 0 | 0 ⚠️ table not present (skipped) |
| `employee_workflow_assignments` | employee_workflow_assignments.employeeId → employees.tenantId | 0 | 0 | 0 ⚠️ table not present (skipped) |
| `employee_work_history` | employee_work_history.employeeId → employees.tenantId | 0 | 0 | 0 ⚠️ table not present (skipped) |
| `employee_work_history_attachments` | employee_work_history_attachments.workHistoryId → employee_work_history.tenantId | 0 | 0 | 0 ⚠️ table not present (skipped) |