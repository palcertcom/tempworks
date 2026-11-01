# Phase 1 — Data Reconciliation Plan

> **Purpose.** Define the pre-cutover cleanup that ops + product must complete before the Phase 1 backfill can run. Every item below is gated by a corresponding finding in the preflight report.

---

## 1. Reconciliation queue

A new table `saas_reconciliation_queue` is created by the Phase 1 prep migration:

```sql
saas_reconciliation_queue(
  id BIGSERIAL,
  kind TEXT,             -- 'user.no-agency', 'employee.code-collision', ...
  subject JSONB,         -- the offending row(s)
  decision TEXT,         -- 'pending' | 'assign:<id>' | 'deactivate' | 'platform-admin' | ...
  decided_by TEXT,
  decided_at TIMESTAMPTZ,
  createdAt TIMESTAMPTZ
)
```

The audit scripts populate this table when run with `--queue-on-write` (off by default; product opt-in). Ops drains rows by setting `decision`. The backfill script reads `decision` to apply the decided action; `pending` rows abort the run.

---

## 2. Categories

### 2.1 Duplicate user emails (BLOCKER)

- **Detection:** `02-user-identity` audit; `users.duplicate-emails > 0`.
- **Today's reality:** the existing `users.email UNIQUE` constraint structurally prevents this. If detected, it indicates a recent constraint change or a data-load bug.
- **Resolution:** Reconcile manually (merge accounts, rename one, delete the duplicate). Do NOT proceed to backfill until count is 0.

### 2.2 NULL or invalid emails (BLOCKER)

- **Detection:** `02-user-identity` / `user.null-email`, `user.invalid-email`.
- **Resolution:** Per-row decision:
  - **Assign** a working email (preferred for active staff).
  - **Deactivate** (`status='INACTIVE', deletedAt=now()`).
- **Cutover:** the user **cannot** be migrated as a TenantMembership without a verified email; backfill blocks.

### 2.3 Users without an agency (BLOCKER)

- **Detection:** `02-user-identity` / `user.no-agency`.
- **Resolution:** Per-row decision recorded in queue:
  - `assign:<agencyId>` — re-attach to a customer agency (default if the user is operationally a member of one).
  - `platform-admin` — promote to PlatformAdmin (record `level`).
  - `deactivate` — soft-delete; do not migrate.
- **Volume estimate:** typically very low (production preflight expected to surface ≤ 5).

### 2.4 Employee email collisions across agencies (BLOCKER)

- **Detection:** `04-uniqueness-collisions` / `unique.employee-email`.
- **Why blocker:** Phase 2 introduces `@@unique([tenantId, email])` on `Employee`. If the same email is used in two agencies that become two tenants, the constraint will reject the second.
- **Resolution paths:** Per pair:
  - **Same human in two tenants:** legitimate. The user keeps two memberships under different emails on the *user* side, but for *Employee* records, accept duplication and add a `tenantId` discriminator (different tenants → different `(tenantId, email)` key — no collision). Confirm Product accepts that the constraint becomes scoped, not global.
  - **Stale duplicate:** soft-delete one.
  - **Data-entry error:** correct one.

### 2.5 Employee code collisions (BLOCKER)

- **Detection:** `04-uniqueness-collisions` / `unique.employee-code`.
- **Same shape as 2.4** with `(tenantId, employeeCode)` as the new constraint. Most legitimate cases are codes like `EMP-001` re-used at different agencies.
- **Resolution:** No change required for tenant-scoped constraint. Update the migration to `@@unique([tenantId, employeeCode])` rather than the legacy global key.

### 2.6 Identifier sequence rebuild (BLOCKER)

- **Detection:** `04-uniqueness-collisions` / `unique.identifier-sequences`.
- **Resolution:** Per the backfill algorithm §6, snapshot per-tenant max identifier into `saas_phase1_seq_snapshot`. The Phase 2 cutover deploys the new constraint and switches writers. **Cannot be skipped.**

### 2.7 Storage path inventory (WARN)

- **Detection:** `06-storage` audit.
- **Resolution:** Phase 1 takes no action; it only sizes the Phase 3 rekey job. No row-level reconciliation today.

### 2.8 NULL `agencyId` on domain rows (WARN, sometimes BLOCKER)

- **Detection:** `03-data-ownership` / `model.<table>.null-owner`.
- **Resolution:** Per row:
  - For `vehicles`: assign to a tenant via the queue, or hard-delete if scrap.
  - For `applicants` / `employees`: should not happen given current schema (FK to agencies). If detected, this is a data-corruption alert.

### 2.9 Orphan `agencyId` (BLOCKER)

- **Detection:** `03-data-ownership` / `model.<table>.orphan-owner` — row references a non-existent agency.
- **Resolution:** Either restore the missing agency from a backup, or hard-delete the orphan row. No automatic fix.

### 2.10 EmployeeAgencyAccess provenance gaps (WARN)

- **Detection:** `eaa.unattributable-grant` queued.
- **Resolution:** For each grant whose granting user can't be inferred from `audit_logs`, decide:
  - Drop the grant (default; it represents historical noise).
  - Keep the grant; designate the *granting user* manually (e.g., the agency manager).

### 2.11 Reports name reconciliation (INFO)

- **Detection:** `04-uniqueness-collisions` / `unique.report-name`.
- **Resolution:** Today reports are globally unique; they will remain unique within a tenant after backfill. **No action required.** A subsequent (different) tenant could create a same-named report once the constraint changes — that is the intent.

### 2.12 Workshops, MaintenanceTypes, NotificationRules, DocumentTypes (catalog vs override)

- **Detection:** `03-data-ownership` callouts on these tables (they have no ownership column).
- **Resolution decision required from product (recorded as ADR addendum):**
  - **Catalog mode:** keep all current rows as global (`tenantId IS NULL`); tenants can override per-key.
  - **Replicate mode:** copy each row into every tenant.
- **Recommendation:** Catalog mode; supports tenant overrides without data duplication. Lock this in ADR-004 §6 (already proposed).

---

## 3. Email normalisation rules

Applied during the preflight + queue insertion:

- Lower-case for collision detection (`lower(email)`).
- Trim leading/trailing whitespace.
- Treat `+` aliases as the same identity? **No** — Tempworks domain is small enterprise; Acme's `hr+jobs@acme.com` is a different mailbox from `hr@acme.com`. Document this if Product disagrees.
- `gmail.com` dot-stripping? **No** — same reason.

---

## 4. Slug derivation rules

For each customer Agency promoted to a Tenant:

```text
slug = collisionSuffix(reservedFilter(slugify(agency.name)))

slugify(s) = lower(s) | strip-diacritics | replace [^a-z0-9-] with '-' | collapse '-+' to '-' | trim '-' | truncate 40
reservedFilter(s) = if RESERVED.has(s) then s + '-co' else s
collisionSuffix(s) = if uniqueSoFar(s) then s else s + '-' + first6(hash(agency.id))
```

`RESERVED` (codified in `backend/src/saas/tenancy/reserved-slugs.ts`):

```
api, app, admin, auth, www, root, system, support, ops, status, billing,
platform, tempworks, public, internal, dev, staging, test, sandbox,
help, docs, mail, smtp, ftp, db, pgadmin, pg, postgres, redis
```

Override: ops can manually set the slug per row in `saas_reconciliation_queue.subject.slug` before backfill runs.

---

## 5. Manual review queue — ops workflow

1. Run preflight on a fresh production replica (read-only).
2. Read `PHASE1_PREFLIGHT_SUMMARY.md`.
3. For each blocker / warn, populate `saas_reconciliation_queue` with proposed decisions.
4. Product / security review per decision (sign-off captured in `decided_by`).
5. Re-run preflight; status downgrades from BLOCKER as decisions land.
6. When `overall = OK` (or `WARN` with sign-off), schedule the maintenance window.

---

## 6. Sign-off checklist

Before the maintenance window opens, the following names must be present in `decided_by`:

- [ ] **Engineering lead** — preflight green; backfill script tested on staging twice.
- [ ] **Product owner** — slug list reviewed; reserved slugs accepted; catalog vs replicate decisions accepted.
- [ ] **Security** — PlatformAdmin grants confirmed; reconciliation-queue decisions accepted.
- [ ] **DevOps / SRE** — pre-migration snapshot exists and restore is rehearsed; advisory lock procedure documented.
- [ ] **Data steward** — `users.no-agency` dispositions confirmed; orphan rows deleted.

---

## 7. Audit trail

Every reconciliation decision (queue row update) is also written to `platform_audit_logs` with `action='saas.phase1.reconcile'`. The audit row references the `saas_reconciliation_queue.id`.

The `agency_split_progress` table itself is the per-agency audit of the backfill; rows persist after the migration as historical evidence.
