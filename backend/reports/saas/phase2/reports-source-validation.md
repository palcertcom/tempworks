# Phase 2 — Reports Source Validation (machine output)

Generated: 2026-05-09T16:46:05.009Z

- Total sources scanned: **18**
- READY: 0
- NEEDS_DECISION: 8
- BLOCKED: 10

## Per-source

| Source | Primary | Joins | Joins w/ tenant=tenant | Fields | tenantId? | agencyId? | Status | Proposed tenantColumn | Proposed agencyColumn |
|--------|---------|------:|-----------------------:|-------:|-----------|-----------|--------|-----------------------|-----------------------|
| `employees` | `employees` (e) | 0 | 0 | 14 | no | no | **NEEDS_DECISION** | `tenantId` | `—` |
| `applicants` | `applicants` (ap) | 0 | 0 | 13 | no | no | **NEEDS_DECISION** | `tenantId` | `—` |
| `documents` | `documents` (doc) | 0 | 0 | 10 | no | no | **NEEDS_DECISION** | `tenantId` | `—` |
| `compliance_alerts` | `compliance_alerts` (ca) | 0 | 0 | 8 | no | no | **NEEDS_DECISION** | `tenantId` | `—` |
| `agencies` | `agencies` (ag) | 0 | 0 | 8 | no | no | **NEEDS_DECISION** | `tenantId` | `—` |
| `work_permits` | `work_permits` (wp) | 0 | 0 | 8 | no | no | **NEEDS_DECISION** | `tenantId` | `—` |
| `employees_documents` | `employees` (e) | 1 | 0 | 14 | no | no | **BLOCKED** | `tenantId` | `—` |
| `employees_work_permits` | `employees` (e) | 1 | 0 | 13 | no | no | **BLOCKED** | `tenantId` | `—` |
| `employees_compliance` | `employees` (e) | 1 | 0 | 12 | no | no | **BLOCKED** | `tenantId` | `—` |
| `applicants_documents` | `applicants` (ap) | 1 | 0 | 13 | no | no | **BLOCKED** | `tenantId` | `—` |
| `employees_agencies` | `employees` (e) | 1 | 0 | 13 | no | no | **BLOCKED** | `tenantId` | `—` |
| `applicants_compliance` | `applicants` (ap) | 1 | 0 | 11 | no | no | **BLOCKED** | `tenantId` | `—` |
| `document_types` | `document_types` (dt) | 0 | 0 | 9 | no | no | **NEEDS_DECISION** | `tenantId` | `—` |
| `visas` | `visas` (v) | 0 | 0 | 12 | no | no | **NEEDS_DECISION** | `tenantId` | `—` |
| `documents_with_type` | `documents` (doc) | 1 | 0 | 15 | no | no | **BLOCKED** | `tenantId` | `—` |
| `employees_visas` | `employees` (e) | 1 | 0 | 14 | no | no | **BLOCKED** | `tenantId` | `—` |
| `applicants_visas` | `applicants` (ap) | 1 | 0 | 14 | no | no | **BLOCKED** | `tenantId` | `—` |
| `employees_documents_type` | `employees` (e) | 2 | 0 | 14 | no | no | **BLOCKED** | `tenantId` | `—` |

## Notes per source

- **`employees`**
  - No tenantId / agencyId field exposed; Phase 2 backfill must add the denorm before this source is migrated.
- **`applicants`**
  - No tenantId / agencyId field exposed; Phase 2 backfill must add the denorm before this source is migrated.
- **`documents`**
  - No tenantId / agencyId field exposed; Phase 2 backfill must add the denorm before this source is migrated.
- **`compliance_alerts`**
  - No tenantId / agencyId field exposed; Phase 2 backfill must add the denorm before this source is migrated.
- **`agencies`**
  - No tenantId / agencyId field exposed; Phase 2 backfill must add the denorm before this source is migrated.
- **`work_permits`**
  - No tenantId / agencyId field exposed; Phase 2 backfill must add the denorm before this source is migrated.
- **`employees_documents`**
  - 1 join(s) lack tenant_id equality.
  - No tenantId / agencyId field exposed; Phase 2 backfill must add the denorm before this source is migrated.
- **`employees_work_permits`**
  - 1 join(s) lack tenant_id equality.
  - No tenantId / agencyId field exposed; Phase 2 backfill must add the denorm before this source is migrated.
- **`employees_compliance`**
  - 1 join(s) lack tenant_id equality.
  - No tenantId / agencyId field exposed; Phase 2 backfill must add the denorm before this source is migrated.
- **`applicants_documents`**
  - 1 join(s) lack tenant_id equality.
  - No tenantId / agencyId field exposed; Phase 2 backfill must add the denorm before this source is migrated.
- **`employees_agencies`**
  - 1 join(s) lack tenant_id equality.
  - No tenantId / agencyId field exposed; Phase 2 backfill must add the denorm before this source is migrated.
- **`applicants_compliance`**
  - 1 join(s) lack tenant_id equality.
  - No tenantId / agencyId field exposed; Phase 2 backfill must add the denorm before this source is migrated.
- **`document_types`**
  - No tenantId / agencyId field exposed; Phase 2 backfill must add the denorm before this source is migrated.
- **`visas`**
  - No tenantId / agencyId field exposed; Phase 2 backfill must add the denorm before this source is migrated.
- **`documents_with_type`**
  - 1 join(s) lack tenant_id equality.
  - No tenantId / agencyId field exposed; Phase 2 backfill must add the denorm before this source is migrated.
- **`employees_visas`**
  - 1 join(s) lack tenant_id equality.
  - No tenantId / agencyId field exposed; Phase 2 backfill must add the denorm before this source is migrated.
- **`applicants_visas`**
  - 1 join(s) lack tenant_id equality.
  - No tenantId / agencyId field exposed; Phase 2 backfill must add the denorm before this source is migrated.
- **`employees_documents_type`**
  - 2 join(s) lack tenant_id equality.
  - No tenantId / agencyId field exposed; Phase 2 backfill must add the denorm before this source is migrated.