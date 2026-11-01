# Phase 3.5 — PlatformAdmin backfill

Generated: 2026-05-11T08:40:59.936Z
Classification: **SAFE_CLONE**
Mode: **apply** | Applied: **true**

## Counts
- eligible: **0**
- inserted this run: **0**
- before / after PlatformAdmin total: 1 → 1

## Skipped
- already PlatformAdmin: 0
- deleted or inactive user: 0
- missing user (orphan PlatformAdmin): 0
- non-system agency: 0 (not considered)
- multiple system agencies: 0
- ambiguous membership: 0

## PlatformAuditLog
Deferred. The `platform_audit_log` table is not present in the active
database (Prisma model exists; no migration creates it). Each inserted
PlatformAdmin row is tagged with `grantedBy='phase350-backfill'` for exact
rollback.

## Rollback
```sql
DELETE FROM platform_admins WHERE "grantedBy" = 'phase350-backfill';
```
