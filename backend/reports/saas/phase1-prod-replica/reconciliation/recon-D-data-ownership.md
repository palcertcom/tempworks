# Recon D — Data Ownership

- **Mode:** `dry-run`
- **Status:** **WARN**
- **Database:** `postgres://postgres@127.0.0.1/saas_phase1_fixture?sslmode=disable`
- **Started:** 2026-05-09T14:53:12.309Z
- **Duration:** 47 ms

## Metrics

| Key | Value | Note |
|-----|-------|------|
| `applicants.total` | 72 |  |
| `applicants.null-owner` | 0 |  |
| `applicants.orphan-owner` | 0 |  |
| `employees.total` | 29 |  |
| `employees.null-owner` | 0 |  |
| `employees.orphan-owner` | 0 |  |
| `vehicles.total` | 3 |  |
| `vehicles.null-owner` | 1 |  |
| `vehicles.orphan-owner` | 0 |  |
| `documents.total` | 52 |  |
| `documents.inferable-via-employees` | 52 |  |
| `documents.unresolved-parent` | 0 |  |
| `financial_records.total` | 1 |  |
| `financial_records.inferable-via-employees` | 1 |  |
| `financial_records.unresolved-parent` | 0 |  |
| `job_ads.total` | 3 |  |
| `workflows.total` | 3 |  |
| `workshops.total` | 1 |  |

## Actions

| Kind | Applied | Proposed | Subject |
|------|---------|----------|---------|
| `ownership.null.vehicles` | no | assign-tenant | hard-delete (after review) | {"id":"6228d8e0-1e82-40da-990d-9eea5f759728","table":"vehicles"} |
| `ownership.manual-decision-required` | no | product-decision: tenant-scope | system-template-with-clone | catalog | {"table":"job_ads"} |
| `ownership.manual-decision-required` | no | product-decision: tenant-scope | system-template-with-clone | catalog | {"table":"workflows"} |
| `ownership.manual-decision-required` | no | product-decision: tenant-scope | system-template-with-clone | catalog | {"table":"workshops"} |

## Notes
- For entity-keyed models (Document, FinancialRecord), tenantId is inferred from the parent entity AT BACKFILL — never silently assigned at recon time.
- Rows whose parent is missing entirely (`unresolved-parent`) are quarantined; ops decides delete vs ignore.
