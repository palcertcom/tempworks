# Phase 2.53 — audit-log retention enforcement

Generated: 2026-05-10T18:31:16.467Z
Mode: **dry-run**
Classification: SAFE_CLONE
Scope: tenant (tenantId=11111111-1111-1111-1111-111111111111)
Days: 365
Cutoff: 2025-05-10T18:31:16.447Z
Refusal reason: AUDIT_LOG_RETENTION_ENABLED=false

| Field | Value |
|---|---:|
| candidateRows | 3 |
| alreadyDeletedRows | 3 |
| excludedByCutoff | 77 |
| updatedRows | 0 |
| beforeAliveRows | 80 |
| afterAliveRows | 80 |
| applied | false |

## Recommended pre-apply snapshot

```sql
SELECT id, "tenantId", "createdAt", "deletedAt" FROM audit_logs WHERE "createdAt" < '2025-05-10T18:31:16.447Z' AND "deletedAt" IS NULL AND "tenantId" = '11111111-1111-1111-1111-111111111111'
```
