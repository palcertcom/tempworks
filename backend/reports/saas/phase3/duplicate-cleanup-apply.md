# Phase 3.2 — Duplicate cleanup apply

Generated: 2026-05-11T08:41:14.157Z
Classification: **SAFE_CLONE**
Enabled: **true** | Apply: **true**
Dry-run: **false**

## Counts

- exact groups considered: 3
- rows soft-deleted this run: **0**
- rows already soft-deleted (idempotent): 3
- conflicting_active groups refused: 1
- null_tenant groups refused: 1
- cross_tenant observation groups refused: 1

## Active counts (before / after)

- employees: 18 → 18
- applicants: 5 → 5

Soft-delete only. No hard-delete. No tenantId mutation. Rollback via:

```sql
UPDATE employees   SET "deletedAt"=NULL, "deletedBy"=NULL, "deletionReason"=NULL WHERE "deletionReason"='phase320-duplicate-cleanup';
UPDATE applicants  SET "deletedAt"=NULL, "deletedBy"=NULL, "deletionReason"=NULL WHERE "deletionReason"='phase320-duplicate-cleanup';
```
