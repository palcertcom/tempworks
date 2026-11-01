# Phase 2.54 — audit-log hard-delete

Generated: 2026-05-10T18:43:29.052Z
Mode: **dry-run**
Classification: SAFE_CLONE
Scope: tenant (tenantId=11111111-1111-1111-1111-111111111111)
Grace days: 90
Cutoff: 2026-02-09T18:43:29.029Z
Refusal reason: AUDIT_LOG_HARD_DELETE_ENABLED=false

| Field | Value |
|---|---:|
| eligibleRows | 1 |
| excludedNotSoftDeleted | 89 |
| excludedInsideGrace | 3 |
| excludedByScope | 92 |
| deletedRows | 0 |
| beforeTotalRows | 93 |
| afterTotalRows | 93 |
| applied | false |

## MANDATORY pre-apply snapshot — full rows

> id-only snapshots are NOT enough to roll back a hard-delete.

```sql
-- For ROLLBACK after hard-delete you MUST capture the full row, not just ids:
SELECT * FROM audit_logs WHERE "deletedAt" IS NOT NULL AND "deletedAt" < '2026-02-09T18:43:29.029Z' AND "tenantId" = '11111111-1111-1111-1111-111111111111'
```

## Identity-only audit (cheaper, but NOT a rollback source)

```sql
SELECT id, "tenantId", "createdAt", "deletedAt", entity, action FROM audit_logs WHERE "deletedAt" IS NOT NULL AND "deletedAt" < '2026-02-09T18:43:29.029Z' AND "tenantId" = '11111111-1111-1111-1111-111111111111'
```
