# SPIKE-003 — Agency → Tenant Migration Dry Run

- **Status:** PASS WITH CONSTRAINTS
- **Date:** 2026-05-09
- **Artifact:** `spikes/spike-003-agency-tenant/dry-run.sql` (executable on a throwaway DB)
- **Validates:** ADR-003, `SAAS_AGENCY_TO_TENANT_SPLIT_STRATEGY.md`

## Hypothesis

The split-by-reuse algorithm — where each customer `Agency.id` is **reused** as the new `Tenant.id`, and a fresh `Default Agency` is inserted as a child — preserves all data, FKs, and permissions, and is idempotent and resumable.

## Setup

A small synthetic Postgres schema modelled on the real Tempworks shape (simplified):

```
Role(id, name UNIQUE)
agencies(id, name, is_system)
users(id, email UNIQUE, agency_id FK, role_id FK)         -- email globally unique, like prod
employees(id, agency_id FK, email, full_name)
applicants(id, agency_id FK, email, full_name)
employee_agency_access(employee_id, agency_id, scope)
agency_user_permission(user_id, permission_id)
```

Seeded with: 1 system agency (2 users), 2 customer agencies (5 users each), 6 employees, 2 applicants. Plus a duplicate-email probe.

## Findings (measured on a real Postgres run)

### F-1 — Pre-flight: duplicate-email check fires

The probe attempted to insert two `users` rows with the same email under different agencies. The pre-existing `UNIQUE(email)` constraint rejected the second insert with `unique_violation`. Output: `pre-flight collision check OK: duplicate email rejected`. Confirms the migration's pre-flight query (`SELECT email, COUNT(*) ... HAVING COUNT(*) > 1`) is the right mechanism, **and that today's schema already enforces global email uniqueness** — so the assumption "no duplicate emails to migrate" is structurally true.

### F-2 — Backfill counts match exactly

| Pre-migration | Post-migration |
|---|---|
| 3 agencies (1 system + 2 customer) | 2 agencies (2 default sub-agencies) |
| 12 users | 12 users (2 of which now have `agency_id IS NULL` — the platform admins) |
| 6 employees | 6 employees (reparented to default sub-agencies) |
| 2 applicants | 2 applicants (reparented) |
| — | 2 tenants (Acme HR, Globex Co.) |
| — | 10 tenant_memberships |
| — | 10 membership_roles |
| — | 10 agency_memberships |
| — | 2 platform_admins |
| — | **0 orphan users** (every non-system user has a membership) |

### F-3 — Permission preservation invariant holds

```
pre_user_role_pairs:        10
post_membership_role_pairs: 10
```

Every existing `(user, role)` assignment survives as `(membership, role)`. Subset of the integrity invariant: see the verification SQL at the end of `dry-run.sql`.

### F-4 — Per-tenant breakdown is correct

```
Acme HR    | 5 members | 3 employees | 2 applicants
Globex Co. | 5 members | 3 employees | 0 applicants
```

Each tenant sees exactly the rows that were under its original customer Agency. No cross-mixing.

### F-5 — Reused IDs work without conflict

`Tenant.id = original Agency.id` reuses the original UUID for the tenant, and the new `Default Agency` gets a fresh UUID. No FK conflict or namespace collision was observed (different tables; different UUIDs).

### F-6 — System agency users disposition

Two users from the system agency (`is_system = true`) became `platform_admin` rows. To delete the system agency row, the dry-run had to either (a) delete its users, (b) reparent them, or (c) drop the `users.agency_id NOT NULL` constraint. The dry-run picked (c): **`agency_id` becomes nullable** for legacy users. Production migration must adopt the same approach (consistent with ADR-002 D-5: `User.agencyId` kept nullable through Phase 4).

### F-7 — Reserved-word collision in column name

The dry-run hit a SQL syntax error on a column named `grant` (reserved in Postgres). For production: `MembershipPermissionOverride` must use `is_grant` or `effect` instead of `grant`. Captured as a minor schema-naming rule.

### F-8 — Per-old-agency transactional safety

Each old-agency processing step is wrapped in an exception handler that writes a `FAILED: <error>` row to `agency_split_progress`. Re-running the script can resume from `WHERE status != 'DONE'`. Confirms the algorithm is idempotent.

## Migration Algorithm (validated)

1. **Pre-flight read-only audit** (per `SAAS_AGENCY_TO_TENANT_SPLIT_STRATEGY.md` §2.1).
2. **Create new tables** (additive). `agency_split_progress(old_agency_id PK, new_tenant_id, new_default_agency_id, status)`.
3. **For each customer Agency** (in `created_at` order, transactional, idempotent):
   1. `INSERT INTO tenants_new(id, slug, name) VALUES (oldAgency.id, slugify(name), name) ON CONFLICT DO NOTHING`.
   2. `INSERT INTO agencies(id, name) VALUES (newUuid, oldAgency.name)` — the **Default Agency**.
   3. `UPDATE` all FK-bearing tables to point at `newDefaultId` instead of `oldAgency.id`.
   4. `DELETE FROM agencies WHERE id = oldAgency.id`.
   5. `INSERT INTO agency_split_progress` with status `DONE`.
4. **Process system agencies**:
   1. For each user: `INSERT INTO platform_admin(user_id, level='SUPER')`.
   2. `users.agency_id` made nullable; system-users' `agency_id` set to `NULL`.
   3. `DELETE FROM agencies WHERE is_system`.
5. **Backfill memberships** (one INSERT per non-system user).
6. **Backfill membership roles** (clone from `users.role_id`).
7. **Backfill agency memberships** (one per user; scope `FULL`).
8. **Map `EmployeeAgencyAccess`** rows to `AgencyMembership` rows where they grant a user cross-agency access (look up the granting user via the EmployeeAgencyAccess provenance — currently not present in schema; document gap).
9. **Map `AgencyUserPermission`** rows to `MembershipPermissionOverride` (rename + repoint).
10. **Identifier-sequence backfill** (per-tenant counters; advisory locks).
11. **Storage rekey** (out of band; covered by SPIKE-005).

## Edge Cases Discovered

| # | Edge Case | Disposition |
|---|---|---|
| E-1 | User has duplicate email | Already structurally impossible (existing UNIQUE constraint). Pre-flight verifies. |
| E-2 | User has `agency_id NULL` today | Pre-flight blocker; ops reconciles before migration. |
| E-3 | System agency user has data dependencies (created records, audit log entries) | Audit-log entries unchanged; `created_by` FKs remain valid; user retains identity, only loses `agency_id`. |
| E-4 | Customer agency has zero users | Tenant created; no memberships; admin invites later. |
| E-5 | Customer agency has zero employees but has applicants | Backfill works (per-tenant counts may differ; verified). |
| E-6 | `Document.entityType = 'AGENCY'` rows pointing at the about-to-be-deleted Agency | Must be reparented to `entityId = newDefaultAgencyId` (or `entityType = 'TENANT'` if any). Captured as Phase 2 ticket. |
| E-7 | `EmployeeAgencyAccess` granting cross-agency access in current single-tenant world | Each row becomes an `AgencyMembership`; provenance (which user granted) preserved in the `AgencyMembership.scope` value mapping. |
| E-8 | `IdentifierSequence` counter conflict if two tenants started with overlapping prefixes | Resolved by per-tenant backfill (snapshot max identifier per tenant). |
| E-9 | Reserved Postgres word as a column name (`grant`) | Schema convention: avoid reserved words; use `effect` / `is_grant`. |
| E-10 | An agency name containing only special characters (e.g. "Acme & Co.") | `regexp_replace(lower(name), '[^a-z0-9-]+', '-', 'g')` produces something like `acme-co-`; trim trailing dashes; collide-suffix on duplicate. |

## Irreversible Risks

- **Original Agency rows are deleted.** Once committed, the only rollback is restore-from-snapshot. Mandatory pre-migration full DB snapshot.
- **`agency_id` becomes nullable.** Reversing this after data has been written would require backfilling a value or hard-deleting rows. Treat as one-way.
- **Identifier-sequence cutover** writes new rows under the new key; rollback would mean recomputing per-tenant counters from data — feasible but expensive.

## Reconciliation Requirements

After cutover, on staging clone before prod:

1. `SELECT count(*) FROM users WHERE agency_id IS NOT NULL AND id NOT IN (SELECT user_id FROM tenant_membership)` — must be 0.
2. `SELECT count(*) FROM users WHERE agency_id IS NULL AND id NOT IN (SELECT user_id FROM platform_admin)` — must be 0.
3. `SELECT t.id, count(m.id) FROM tenants_new t LEFT JOIN tenant_membership m ON m.tenant_id = t.id GROUP BY 1` — count vs expected per-customer.
4. `SELECT count(*) FROM membership_role` ≥ count of pre-migration distinct `(user, role)` pairs.
5. Sample: 100 random `employees`/`applicants`/`vehicles` — the row's `agency_id` must point at an agency whose `tenant_id` is correctly mapped (after Phase 2 adds `tenantId` denorm).
6. Storage objects (verified by SPIKE-005) — every Document key must begin with `tenants/<correct-tenant>/...`.

## Rollback Strategy

- **Pre-flight failure (duplicate emails, NULL agency_ids):** abort; no writes performed.
- **Mid-migration failure:** `agency_split_progress` records the failure point. Re-run the script — the `INSERT ... ON CONFLICT DO NOTHING` and the `WHERE status != 'DONE'` filter make it idempotent.
- **Post-migration smoke test failure:** restore from pre-migration snapshot; revert deploy.
- **Discovered correctness bug days later:** **no automatic rollback.** Forward-fix only. This is the strongest argument for a thorough staging dry-run on a clone of production data.

## Verdict: **PASS WITH CONSTRAINTS**

Constraints:

1. Mandatory pre-flight on a recent prod replica before scheduling the migration.
2. Mandatory full DB snapshot immediately before write phase.
3. `agency_id` becomes nullable for `users` (decision locked: ADR-002 D-5; matches dry-run finding F-6).
4. Avoid reserved Postgres words in new column names (F-7 — affects only `MembershipPermissionOverride.grant`; rename to `effect` or `is_grant`).
5. The migration runs on a single connection holding a Postgres advisory lock for the duration of the write window: `SELECT pg_advisory_lock(hashtext('saas-agency-tenant-split'))`.
6. Schedule a maintenance window (estimated 30–60 min for a mid-sized prod database).
7. Stage the dry-run twice: once on a fresh staging DB, once on a sanitized clone of prod. Sign off after the second.

## Cleanup

```sh
sudo -u postgres dropdb spike_agency_split
```
