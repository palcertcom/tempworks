# Phase 1 — Tenant Backfill Algorithm

> **Authoritative for the Phase 1 backfill script.**
> All steps are idempotent and resumable. No step is destructive against existing data **except** for the deletion of the original `agencies` row (step 5.4). Read [Rollback](#10-rollback) before running.

The algorithm operationalises ADR-003 ("split Agency into Tenant + sub-Agency") on the real Tempworks schema, conditioned on the issues surfaced by the Phase 1 preflight.

---

## 1. Inputs

- A clone of production data on staging (or the production primary, during the maintenance window).
- A green Phase 1 preflight report (`PHASE1_PREFLIGHT_SUMMARY.md` overall = `OK`, `INFO`, or product-signed `WARN`).
- Phase 1 schema migration applied (`saas_phase1_tenant_backfill_prepare/migration.sql`).
- A `BACKFILL_DRY_RUN=true` mode supported by the script — writes go to a dedicated schema `_saas_dryrun` and roll back at the end.

## 2. Pre-flight gate (script aborts on failure)

Re-run, in the same transaction as the backfill:

```sql
-- (a) duplicate emails
SELECT email FROM users WHERE email IS NOT NULL GROUP BY lower(email) HAVING count(*) > 1;
-- (b) NULL agency users not yet quarantined
SELECT id, email FROM users WHERE "agencyId" IS NULL;
-- (c) cross-agency uniqueness collisions
SELECT lower(email)        FROM employees GROUP BY lower(email)        HAVING count(DISTINCT "agencyId") > 1;
SELECT lower("employeeCode") FROM employees GROUP BY lower("employeeCode") HAVING count(DISTINCT "agencyId") > 1;
```

Any non-empty result with a corresponding `saas_reconciliation_queue` row in `decision='pending'` aborts the run.

## 3. Advisory lock & checkpoint

```sql
SELECT pg_advisory_lock(hashtext('saas-agency-tenant-split'));
-- Allow only one runner cluster-wide.
```

The `agency_split_progress` table is the resume key. Each iteration records `(old_agency_id, new_tenant_id, new_default_agency_id, status)` and skips rows already `DONE`.

## 4. Mapping rules (re-stated from ADR-003)

| Pre-migration bucket | Post-migration disposition |
|---|---|
| `agencies WHERE isSystem = true` | **Deleted.** Its users → `platform_admins`. The `agencies` row is dropped after users detach. |
| `agencies WHERE isSystem = false` | **Promoted to a Tenant** that **reuses the original `agencies.id` as its UUID**. A fresh `agencies` row (`isDefault = true`) is inserted under that Tenant; all FKs that pointed at the old row are reparented to it. |
| Future hierarchical sub-agencies | Out of Phase 1 scope (current schema has no `parentId`). |

Why reuse the id: every existing `agencyId` value can be used as `tenantId` directly during the Phase 2 row-level backfill (next milestone). No mapping table needed at the row level.

## 5. Per-old-customer-agency loop

For each row `A` of `agencies WHERE isSystem = false`:

```pseudo
BEGIN;
  IF EXISTS (agency_split_progress[old=A.id, status='DONE']) -> SKIP;

  -- 5.1 Tenant
  INSERT INTO tenants (id, slug, name, region, branding, status)
       VALUES (A.id, slugify(A.name) || collisionSuffix, A.name, 'eu', NULL, 'ACTIVE')
       ON CONFLICT (id) DO NOTHING;

  -- 5.2 Default sub-agency (fresh UUID, isDefault=true)
  defaultAgencyId := uuid();
  INSERT INTO agencies (id, name, country, email, phone, "managerId",
                        "tenantId", "isDefault", status, "isSystem", "createdAt")
       VALUES (defaultAgencyId, A.name, A.country, A.email, A.phone, A."managerId",
               A.id, true, A.status, false, A."createdAt");

  -- 5.3 Reparent every FK that points at A.id over to defaultAgencyId
  UPDATE users               SET "agencyId" = defaultAgencyId WHERE "agencyId" = A.id;
  UPDATE employees           SET "agencyId" = defaultAgencyId WHERE "agencyId" = A.id;
  UPDATE applicants          SET "agencyId" = defaultAgencyId WHERE "agencyId" = A.id;
  UPDATE vehicles            SET "agencyId" = defaultAgencyId WHERE "agencyId" = A.id;
  UPDATE employee_agency_access SET "agencyId" = defaultAgencyId WHERE "agencyId" = A.id;
  UPDATE agency_permission_overrides SET "agencyId" = defaultAgencyId WHERE "agencyId" = A.id;
  -- ApplicantAgencyHistory and any other agency-FK tables: same shape.

  -- 5.4 Delete the original agencies row (its identity has been promoted).
  --     Safe AFTER step 5.3; otherwise the FKs above would be invalidated.
  DELETE FROM agencies WHERE id = A.id;

  -- 5.5 Tenant id denorm on the "leading" tenant-scoped tables
  --     (Phase 1 prep migration added these columns nullable).
  UPDATE applicants          SET "tenantId" = A.id WHERE "agencyId" = defaultAgencyId AND "tenantId" IS NULL;
  UPDATE employees           SET "tenantId" = A.id WHERE "agencyId" = defaultAgencyId AND "tenantId" IS NULL;
  UPDATE vehicles            SET "tenantId" = A.id WHERE "agencyId" = defaultAgencyId AND "tenantId" IS NULL;
  UPDATE agencies            SET "tenantId" = A.id WHERE id = defaultAgencyId AND "tenantId" IS NULL;

  -- 5.6 Identifier sequences — initialise per-tenant counters from the GLOBAL row
  --     This is computed from real data so we don't reset counters mid-flight.
  --     IMPORTANT: PHASE 1 only INSERTs the new (tenantId, prefix, year, month) rows;
  --     it does not yet drop the old global UNIQUE constraint. Phase 2 cuts over.
  -- (See §6 below.)

  -- 5.7 Membership backfill
  INSERT INTO tenant_memberships (id, "userId", "tenantId", status, "joinedAt")
  SELECT uuid(), u.id::text, A.id, CASE WHEN u.status = 'ACTIVE' THEN 'ACTIVE' ELSE 'SUSPENDED' END, u."createdAt"
    FROM users u WHERE u."agencyId" = defaultAgencyId
    ON CONFLICT ("userId", "tenantId") DO NOTHING;

  INSERT INTO membership_roles ("membershipId", "roleId")
  SELECT m.id, u."roleId"::text
    FROM tenant_memberships m
    JOIN users u ON u.id::text = m."userId"
   WHERE m."tenantId" = A.id AND u."roleId" IS NOT NULL
    ON CONFLICT DO NOTHING;

  INSERT INTO agency_memberships (id, "membershipId", "agencyId", scope)
  SELECT uuid(), m.id, defaultAgencyId, 'FULL'
    FROM tenant_memberships m
   WHERE m."tenantId" = A.id
    ON CONFLICT ("membershipId", "agencyId") DO NOTHING;

  -- 5.8 EmployeeAgencyAccess — extra cross-agency grants → AgencyMembership
  --     For each grant where the employee's home agency is `defaultAgencyId`,
  --     and the grant target is also a tenant-internal agency, add a
  --     supplementary AgencyMembership for the granting user(s).
  --     (Provenance is reconstructed via the most recent audit log; if no
  --     audit log entry, the grant is queued in saas_reconciliation_queue.)

  -- 5.9 AgencyUserPermission → MembershipPermissionOverride (rename + repoint)
  INSERT INTO membership_permission_overrides (id, "membershipId", "permissionId", effect)
  SELECT uuid(), m.id, aup."permissionId"::text, true
    FROM agency_user_permission aup
    JOIN users u ON u.id = aup."userId"
    JOIN tenant_memberships m ON m."userId" = u.id::text AND m."tenantId" = A.id
    ON CONFLICT ("membershipId", "permissionId") DO NOTHING;

  -- 5.10 Checkpoint
  INSERT INTO agency_split_progress (old_agency_id, new_tenant_id, new_default_agency_id, status, finished_at)
       VALUES (A.id, A.id, defaultAgencyId, 'DONE', now())
  ON CONFLICT (old_agency_id) DO UPDATE
      SET new_tenant_id = EXCLUDED.new_tenant_id,
          new_default_agency_id = EXCLUDED.new_default_agency_id,
          status = 'DONE',
          finished_at = now();
COMMIT;
```

If any step inside the per-agency transaction throws, the whole transaction rolls back and `agency_split_progress` records `status = 'FAILED:<sqlstate>'`. The runner continues with the next agency. Re-run resumes from `WHERE status <> 'DONE'`.

## 6. Identifier-sequence cutover

Identifier sequences (`A-2025-…`, `E-2025-…`) are global today. Phase 1 prepares the new per-tenant rows but **does not yet drop the global UNIQUE**. The window is closed in Phase 2 (when application code begins writing to the new key).

**For each `(prefix, year, month)` global row:**

For each tenant `T` and entity table referencing this prefix (e.g. applicants for prefix `A`), compute the maximum identifier already issued under that tenant:

```sql
WITH per_tenant_max AS (
  SELECT a."tenantId" AS tid, max(substring(a."identifier" from 'A-\d+-\d+-(\d+)')::int) AS m
    FROM applicants a
    WHERE a."identifier" ~ ('^' || prefix || '-' || year || '-' || lpad(month::text, 2, '0') || '-')
   GROUP BY a."tenantId"
)
INSERT INTO identifier_sequences (id, prefix, year, month, value, "tenantId")
SELECT gen_random_uuid(), prefix, year, month, m, tid FROM per_tenant_max
  ON CONFLICT DO NOTHING;
```

The Phase 2 cutover then:
1. Adds `tenantId` to the existing constraint (`@@unique([tenantId, prefix, year, month])`).
2. Switches the application's `IdentifierSequence.upsert` call to include `tenantId`.
3. Drops the old global unique key.

**Note:** the column `"tenantId"` on `identifier_sequences` is added in Phase 2's migration, not Phase 1. Phase 1 only computes and stores the per-tenant max **into a staging table** (`saas_phase1_seq_snapshot`) so the Phase 2 migration can apply it deterministically.

## 7. System agency disposition

```pseudo
BEGIN;
  -- Provision PlatformAdmin rows for every user under any isSystem=true agency
  INSERT INTO platform_admins (id, "userId", level, "grantedAt")
  SELECT uuid(), u.id::text, 'SUPER', now()
    FROM users u
    JOIN agencies a ON a.id = u."agencyId"
   WHERE a."isSystem" = true
    ON CONFLICT ("userId") DO NOTHING;

  -- Detach: users.agencyId becomes NULL for those users.
  --   This requires users.agencyId to be NULLABLE (already true today; if a
  --   future migration tightens it, that is the moment to relax).
  UPDATE users SET "agencyId" = NULL
    FROM agencies a WHERE a.id = users."agencyId" AND a."isSystem" = true;

  -- Delete the system agency row LAST.
  DELETE FROM agencies WHERE "isSystem" = true;
COMMIT;
```

## 8. Quarantine: ambiguous rows

Cases the script must NOT auto-decide; instead inserts a row in `saas_reconciliation_queue` and does not move data:

| Kind | Trigger | Default proposed decision |
|---|---|---|
| `user.no-agency` | `users.agencyId IS NULL` and not platform-admin | `pending` (manual) |
| `user.duplicate-email` | preflight blocker repeats | abort |
| `employee.code-collision` | same `employeeCode` in 2+ agencies | `pending` |
| `employee.email-collision` | same `email` in 2+ agencies | `pending` |
| `vehicle.no-agency` | `vehicles.agencyId IS NULL` | `pending` |
| `eaa.unattributable-grant` | `EmployeeAgencyAccess` row whose granting user can't be inferred | `pending` |

Ops drains the queue manually before re-running the backfill.

## 9. Verification (post-run, in the same window)

The script writes a verification report to `backend/reports/saas/phase1/PHASE1_BACKFILL_VERIFICATION.md`:

- `count(tenants) == count(distinct old customer agencies)` ✅
- `count(users WHERE agencyId IS NOT NULL AND id NOT IN (SELECT userId FROM tenant_memberships)) == 0`
- `count(users WHERE agencyId IS NULL AND id NOT IN (SELECT userId FROM platform_admins)) == 0`
- For each tenant, `applicants.tenantId` and `employees.tenantId` populated for every reparented row
- `agency_split_progress.status = 'DONE'` for every customer agency
- `EmployeeAgencyAccess` rows have a corresponding `AgencyMembership` row OR a queue entry

Sample 100 random `applicants`/`employees`/`vehicles` rows: each row's `tenantId` matches the `agencies.tenantId` of its `agencyId`.

## 10. Rollback

Phase 1 backfill is **destructive at step 5.4** (deletes the original `agencies` row). Once committed, only snapshot restore reverses it.

| Failure point | Recovery |
|---|---|
| Pre-flight gate fails | No writes performed. Reconcile, re-run preflight, re-run backfill. |
| Mid-loop transaction fails | `agency_split_progress` records FAILED. Inspect SQL state; fix; re-run (idempotent). |
| Post-loop smoke test fails | **Restore from pre-migration snapshot.** Snapshot is mandatory; the runner refuses to start without confirmation. |
| Identifier-sequence step fails | Sequences are isolated; rerun the step alone. |

The migration's **down** SQL (`saas_phase1_tenant_backfill_prepare/migration.down.sql`) reverts only the additive schema; it does **not** undo backfilled data. That deletion is irreversible without a snapshot.

## 11. Idempotency invariants

- `INSERT ... ON CONFLICT DO NOTHING` everywhere a duplicate is possible.
- `UPDATE ... WHERE "tenantId" IS NULL` on every tenantId denorm.
- `DELETE FROM agencies WHERE id = A.id AND NOT EXISTS (...FK references...)` — refuses to delete if any FK still points (means step 5.3 was incomplete).
- Re-running the entire script changes nothing once `agency_split_progress` is fully `DONE`.

## 12. Operational checklist

- [ ] Preflight overall = `OK` or product-signed `WARN`.
- [ ] Reconciliation queue empty (or every row decided).
- [ ] Pre-migration snapshot taken; restore procedure rehearsed.
- [ ] Maintenance window scheduled.
- [ ] PlatformAdmin grant list reviewed by security.
- [ ] Slug list reviewed by product (final tenant slugs).
- [ ] Read-only `app_user` Postgres role granted on the new tables.
- [ ] Backfill script runs against staging clone first.
- [ ] Verification report attached to the change record.
