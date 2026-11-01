# Phase 1 — Migration Validation Report

**Target environment:** `SAFE_CLONE` (`saas_phase1_fixture` on `127.0.0.1`).
**Migration applied:** `backend/prisma/migrations/saas_phase1_tenant_backfill_prepare/migration.sql` (Phase 0 foundations are idempotent within it).
**Tool:** `npm run saas:apply-migrations`.

---

## 1. Pre-application state

```
Database:           saas_phase1_fixture
PostgreSQL:         16
Existing tables:    agencies, users, employees, applicants, documents,
                    job_ads, attendance_records, attendance_locked_periods,
                    financial_records, workflows, reports, notifications,
                    vehicles, workshops, identifier_sequences, audit_logs,
                    employee_agency_access, agency_user_permission,
                    agency_permission_overrides, "Role", "Permission",
                    "RolePermission"
SaaS tables:        none
```

## 2. Application result

```
--- phase 0 → backend/prisma/migrations/saas_phase0_foundations/migration.sql ---
    OK
--- phase 1 → backend/prisma/migrations/saas_phase1_tenant_backfill_prepare/migration.sql ---
    OK

All requested migrations applied.
```

## 3. Post-application schema delta

### New tables (11)

```
tenants
tenant_memberships
membership_roles
agency_memberships
membership_permission_overrides
platform_admins
platform_audit_logs
tenant_domains
agency_split_progress
saas_reconciliation_queue
saas_phase1_seq_snapshot
```

### New columns on existing tables

| Table | Column | Type | Nullable | Default |
|---|---|---|---|---|
| `agencies` | `tenantId` | TEXT | YES | NULL |
| `agencies` | `isDefault` | BOOLEAN | NO | `false` |
| `agencies` | `parentId` | TEXT | YES | NULL |
| `applicants` | `tenantId` | TEXT | YES | NULL |
| `employees` | `tenantId` | TEXT | YES | NULL |
| `vehicles` | `tenantId` | TEXT | YES | NULL |

### New indexes (composite, tenant-leading)

- `agencies_tenantId_idx`
- `applicants_tenantId_idx`, `applicants_tenantId_status_createdAt_idx`
- `employees_tenantId_idx`, `employees_tenantId_status_idx`
- `vehicles_tenantId_idx`
- 12 indexes on the new SaaS tables (per ADR-001 / ADR-002 conventions)

### Constraints affected

> **None of the existing tables had any column, index, constraint, or default modified.**

Verification by `\d agencies`, `\d employees`, `\d applicants`, `\d vehicles` post-migration: all original columns + indexes + foreign keys remain. The only delta is the additive columns and the new index.

## 4. Idempotency verification

The migration was re-applied immediately after the first run:

```
--- phase 0 ---
NOTICE:  relation "tenants" already exists, skipping
NOTICE:  relation "tenant_memberships_userId_tenantId_key" already exists, skipping
... (similar notices for every CREATE)
    OK
--- phase 1 ---
NOTICE:  relation "saas_reconciliation_queue_kind_idx" already exists, skipping
... (similar)
    OK
```

Re-application produced **zero schema changes**. The `IF NOT EXISTS` guards hold across:

- enum types (`TenantStatus`, `MembershipStatus`, `AgencyMembershipScope`, `PlatformAdminLevel`)
- table creation
- index creation
- additive `ADD COLUMN IF NOT EXISTS`

Re-running is safe in all environments.

## 5. Rollback verification

Performed on a disposable copy of the fixture (no FK references yet):

```
$ npm run saas:rollback-migrations
--- phase 1 (rollback) → migration.down.sql ---
    OK
--- phase 0 (rollback) → migration.down.sql ---
    OK
```

After rollback:

```sql
SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename = ANY(
  ARRAY['tenants','tenant_memberships','membership_roles','agency_memberships',
        'membership_permission_overrides','platform_admins','platform_audit_logs',
        'tenant_domains','agency_split_progress','saas_reconciliation_queue',
        'saas_phase1_seq_snapshot']);
-- → 0
```

The `tenantId`, `isDefault`, `parentId` columns on `agencies` and `tenantId` on
`applicants`, `employees`, `vehicles` are also dropped by the down script.

**Constraint:** rollback is safe **only before** any rows have been written to
the new SaaS tables. With FK references in place (e.g. after backfill), the
down script's bare `DROP TABLE` will fail; recovery then requires snapshot
restore. This is documented in `SAAS_PHASE1_ROLLBACK_RUNBOOK.md` §B.

## 6. Behaviour against READONLY_REPLICA

Not exercised on this engagement (no read-only replica was available). The
expected behaviour is:

```
Classification: READONLY_REPLICA
Reason: Database reports default_transaction_read_only = on.

Permitted actions:
  readOnlyAudits       YES
  reconciliationApply  no
  tenantBackfillApply  no
  rollbackMigration    no
```

The migration applier connects via the same DB role as the audits; on a
true read-only replica, every `CREATE TABLE` would fail with
`SQLSTATE 25006 read-only transaction`. Operators inspecting a read-only
replica should run `npm run saas:phase1-preflight` only.

## 7. Behaviour against UNSAFE_PRODUCTION / UNKNOWN

Not exercised. The classifier returns exit code 3, and the orchestrator
refuses to run `--apply`. Migration applier itself does not check
classification (it is intended for staging cutover); operators must
NOT invoke `saas:apply-migrations` against production until TKT-P1-09
maintenance window.

## 8. Conclusion

Phase 1 prep migration is correct and idempotent on the available
SAFE_CLONE. The same migration is expected to land cleanly on a real
sanitized prod replica because:

- No existing column / constraint / index is referenced or modified.
- Every additive DDL uses `IF NOT EXISTS`.
- The migration runs inside a single transaction — partial failure
  rolls back atomically.

The remaining operational gate (real-replica run) is documented in
`SAAS_PHASE1_PROD_REPLICA_CHECKLIST.md`.
