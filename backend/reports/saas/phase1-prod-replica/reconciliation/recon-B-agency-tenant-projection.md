# Recon B — Agency → Tenant Projection

- **Mode:** `dry-run`
- **Status:** **OK**
- **Database:** `postgres://postgres@127.0.0.1/saas_phase1_fixture?sslmode=disable`
- **Started:** 2026-05-09T14:53:08.181Z
- **Duration:** 30 ms

## Metrics

| Key | Value | Note |
|-----|-------|------|
| `agencies.total` | 5 |  |
| `agencies.customer` | 4 |  |
| `agencies.system` | 1 |  |
| `projection.tenants` | 4 |  |
| `agencies.already-tenant-mapped` | 0 |  |

## Actions

| Kind | Applied | Proposed | Subject |
|------|---------|----------|---------|
| `projection.summary` | no | apply-as-is | {"sample":[{"agencyId":"11111111-1111-1111-1111-111111111111","name":"Acme HR","tenantId":"11111111-1111-1111-1111-111111111111","proposedSlug":"acme-hr","slugConflicts":[],"defaultAgencyId":"<assigne |

## Notes
- Tenant.id reuses Agency.id (ADR-003).
- Default Agency UUID is freshly generated at backfill time and recorded in agency_split_progress.
- Reserved-slug list size: 29. Update by editing this file + Phase 0 reserved-slugs constant.
