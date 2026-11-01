# Agency → Tenant Split Strategy

**Problem:** The current `Agency` model conflates two concepts that the SaaS architecture must separate:
1. **Tenant** — a customer company (a SaaS workspace). Top-level data boundary.
2. **Agency / sub-agency** — a recruitment agency or sub-organization **inside** a tenant.

Today, `Agency.isSystem = true` denotes the Tempworks-internal "platform" agency, and `agencyId` is treated as the de-facto tenant boundary by services. This works only because there is exactly one customer per deployment.

**Goal:** Define a deterministic, reviewable split rule and a backfill that preserves all existing data and permissions.

---

## 1. Rules of the Split

### 1.1 Categorize every existing `Agency` row into exactly one bucket

| Bucket | Rule | Outcome |
|---|---|---|
| **A. Tempworks System Agency** | `isSystem = true` | **Deleted** as an Agency row. Its users become `PlatformAdmin` rows. |
| **B. Top-level customer agency** | `isSystem = false` AND **no parent agency** AND has its own users / employees / applicants | **Becomes a Tenant.** A new `Agency` row is also created **inside** that tenant as the "Default Agency" so existing `agencyId` references continue to resolve. (See §3.) |
| **C. Sub-agency** | `isSystem = false` AND has a parent (or is operationally a sub-org of a customer) | **Stays an Agency** but is reparented under the parent's Tenant. |

> **Critical assumption:** the current schema has no explicit `Agency.parentId`. Therefore, in practice, **all customer agencies are top-level**, and at the time of backfill **every customer Agency becomes a new Tenant + a Default Agency inside that Tenant**.
>
> If, in the future, a customer wants multiple agencies *under* their tenant, they will be created via the standard agency-create flow inside the tenant. The split strategy does not need to handle hierarchical agencies today.

### 1.2 What about the system agency?

- `Agency.isSystem = true` represents Tempworks staff who today see all data via the `agencyIsSystem` JWT bypass.
- After split:
  - **No tenant** is created for the system agency.
  - Each user under the system agency becomes a row in `PlatformAdmin` with `level = SUPER` (configurable; ops can downgrade later).
  - The `Agency` row itself is dropped from the database after migration completes (Phase 3).

### 1.3 What about users with `agencyId = null`?

- If any exist (rare; verify with a read-only audit query), they are **not** automatically migrated. They are flagged for manual review. Default disposition: deactivate.

---

## 2. Backfill Algorithm

Run as a one-time idempotent script under a Postgres advisory lock. **Read-only on first pass; then transactional write.** No production traffic during the write phase.

### 2.1 Pre-flight (read-only audit)

```sql
-- 1. Confirm system agency count = 1
SELECT id, name FROM "Agency" WHERE "isSystem" = true;

-- 2. Identify customer agencies
SELECT id, name FROM "Agency" WHERE "isSystem" = false ORDER BY "createdAt";

-- 3. User distribution
SELECT a."isSystem", COUNT(*) FROM "User" u JOIN "Agency" a ON a.id = u."agencyId" GROUP BY 1;

-- 4. Orphan users (agencyId NULL)
SELECT id, email FROM "User" WHERE "agencyId" IS NULL;

-- 5. Duplicate emails (will block global UNIQUE on User.email post-migration)
SELECT email, COUNT(*) FROM "User" GROUP BY email HAVING COUNT(*) > 1;
```

Block migration if (5) returns any rows. Reconcile with product before proceeding.

### 2.2 Tenant creation (per customer agency)

For each customer `Agency` row `A`:

```pseudo
slug   := slugify(A.name) || (collision ? "-" || shortHash(A.id) : "")
tenant := Tenant.create({
  id:           A.id,                        // REUSE Agency.id as Tenant.id
  slug:         slug,
  name:         A.name,
  status:       'ACTIVE',
  region:       'eu',                        // default
  branding:     null,
  createdAt:    A.createdAt,
})
```

**Why reuse `Agency.id` as `Tenant.id`?** It removes a layer of mapping. Every existing `agencyId` in domain tables is **also** the new `tenantId`. Backfill of `tenantId` becomes a literal copy of `agencyId` for all top-level rows. Composite indexing remains correct.

### 2.3 Default Agency creation (inside the new tenant)

For each new `Tenant`:

```pseudo
defaultAgency := Agency.create({
  id:        newUuid(),                      // NEW id (do NOT reuse)
  tenantId:  tenant.id,
  name:      tenant.name,                    // displayed identically to old behavior
  isDefault: true,                           // new flag (additive column)
})
```

Then **reparent** all rows whose `agencyId` matched the old `Agency.id` to the new `defaultAgency.id`:

```sql
UPDATE "User"            SET "agencyId" = $newDefaultAgencyId WHERE "agencyId" = $oldAgencyId;
UPDATE "Applicant"       SET "agencyId" = $newDefaultAgencyId WHERE "agencyId" = $oldAgencyId;
UPDATE "Employee"        SET "agencyId" = $newDefaultAgencyId WHERE "agencyId" = $oldAgencyId;
UPDATE "Vehicle"         SET "agencyId" = $newDefaultAgencyId WHERE "agencyId" = $oldAgencyId;
-- ... and EmployeeAgencyAccess.agencyId, AgencyPermissionOverride.agencyId, etc.
```

The original `Agency` row (the one whose id became `Tenant.id`) is then **deleted** at the end of the run, after all references have been moved. Its previous fields (`country`, `contactPerson`, `email`, `phone`, `managerId`) are copied onto the new `Default Agency` row.

> **Safety:** All UPDATEs run inside a single transaction per old agency. Use a checkpoint table `agency_split_progress(old_agency_id, new_tenant_id, new_default_agency_id, status)` to make the script idempotent and resumable.

### 2.4 `tenantId` denormalization on every domain row

After §2.3, every domain row's `agencyId` points at a tenant-scoped Agency. For each TENANT model:

```sql
-- Top-level entity (agencyId-bearing)
UPDATE "Employee" e
   SET "tenantId" = a."tenantId"
  FROM "Agency" a
 WHERE a.id = e."agencyId";
```

For derived entities (`Document`, `ComplianceAlert`, `FinancialRecord`, `Visa`):

```sql
-- Document → Employee/Applicant parent → Agency → tenantId
UPDATE "Document" d
   SET "tenantId" = COALESCE(
     (SELECT a."tenantId" FROM "Employee" e JOIN "Agency" a ON a.id = e."agencyId" WHERE e.id = d."entityId" AND d."entityType" = 'EMPLOYEE'),
     (SELECT a."tenantId" FROM "Applicant" p JOIN "Agency" a ON a.id = p."agencyId" WHERE p.id = d."entityId" AND d."entityType" = 'APPLICANT'),
     -- AGENCY entity: tenantId is the parent agency's tenantId
     (SELECT a."tenantId" FROM "Agency" a WHERE a.id = d."entityId" AND d."entityType" = 'AGENCY')
   );
```

Run in batches of 5,000 with `ANALYZE` between batches.

### 2.5 Membership backfill

For every non-system user `U` with `U.agencyId = G` (which now points at a tenant-scoped agency):

```pseudo
membership := TenantMembership.create({
  userId:    U.id,
  tenantId:  G.tenantId,
  status:    U.status === 'ACTIVE' ? 'ACTIVE' : 'SUSPENDED',
  joinedAt:  U.createdAt,
})
MembershipRole.create({ membershipId: membership.id, roleId: U.roleId })
AgencyMembership.create({ membershipId: membership.id, agencyId: G.id, scope: 'FULL' })
```

For `EmployeeAgencyAccess` rows that grant a user access to a *different* agency in the same tenant: create additional `AgencyMembership` rows.

For users in the system agency: create `PlatformAdmin` rows; do **not** create memberships.

For `AgencyUserPermission` rows (per-user fine-grained grants): repoint to `MembershipPermissionOverride.membershipId` (renamed table from §I-6 in the architect review).

### 2.6 Identifier-sequence backfill

For every `IdentifierSequence` row `S(prefix, year, month, value)`:

- Determine the tenant(s) that produced identifiers under this row by inspecting the maximum identifier per tenant in that period.
- Insert a new row per tenant with that tenant's max value. Old shared row remains until the contract step drops it.
- Acquire `pg_advisory_xact_lock(hashtext('idseq:' || tenant_id))` during the cutover write to prevent collisions.

### 2.7 Storage-key reparenting

Background job (server-side S3 copy) re-keys objects:

```
documents/<entityType>/<entityId>/<docTypeKey>/<docId>.<ext>
   → tenants/<tenantId>/documents/<entityType>/<entityId>/<docTypeKey>/<docId>.<ext>
```

`Document.storageKey` is updated. Old keys remain reachable until ACL flip + frontend cutover (see ADR-006).

---

## 3. Why Reusing `Agency.id` as `Tenant.id` is Safe

- IDs are UUIDs, not auto-increment.
- The new `Default Agency` gets a fresh UUID, so `Agency.id` and `Tenant.id` namespaces don't collide.
- All existing `agencyId` foreign keys keep pointing at *something*: but after §2.3 they point at the new Default Agency, not the old (now-deleted) row. The old row's identity is "promoted" to the Tenant.
- Result: every `tenantId` column equals what `agencyId` used to be at the row level — backfill simplifies to a pointer copy.

> **Trade-off:** Anyone debugging a historical log line that says `agencyId = X` may be confused if `X` is now a Tenant id. Document this in the runbook; add a UI tooltip in the platform-admin console: "If this id matches a tenant, it was the original customer agency before the migration."

---

## 4. Permission Preservation

| Today | After |
|---|---|
| `User.roleId → Role` | `MembershipRole(membership, role)` (cloned at backfill) |
| `AgencyUserPermission(userId, permissionId)` | `MembershipPermissionOverride(membershipId, permissionId)` |
| `AgencyPermissionOverride(agencyId, permissionId)` | `AgencyPermissionOverride(tenantId, agencyId, permissionId)` |
| `Role.name` global | `Role(tenantId NULL = system, key, name)` — system templates remain; tenants may clone |
| `agencyIsSystem` JWT bypass | `PlatformAdmin` row + audited `PlatformPrismaService` |

Effective permission set on each request after migration is **identical** to today's set, by construction:

- Same Role → cloned MembershipRole → same permissions
- Same agency-scope grants → same AgencyMembership rows
- Same overrides → same MembershipPermissionOverride rows

This is the correctness invariant the migration test must verify (see §6).

---

## 5. Replacing `agencyIsSystem` Without Breaking Login

Cutover order:

1. Provision `PlatformAdmin` rows for every user under the system agency (read-only, additive).
2. Update JWT issuer to also include `pa: true` for those users (and `pa: false` for everyone else). Existing claim `agencyIsSystem` is still emitted for one release cycle.
3. Update server-side checks to prefer `pa` over `agencyIsSystem` (`isPlatformAdmin = claims.pa || claims.agencyIsSystem` during transition).
4. After all clients have refreshed at least once (≥ 30 days), drop `agencyIsSystem` from new tokens.
5. Phase 3: remove `agencyIsSystem` from claims and from server checks; remove `Agency.isSystem` flag.

> **Safety:** at no point during this sequence is super-admin access lost, because either `pa` or `agencyIsSystem` is always honored.

---

## 6. Verification & Test Plan

### 6.1 Pre-migration assertions

- Every user has either `agencyId` or is flagged for manual review.
- No duplicate emails on `User`.
- Identifier-sequence rows are consistent with maximum referenced identifiers in each entity.

### 6.2 Post-migration assertions (per tenant)

- `count(User memberships) == count(non-system users in original agency)` ± flagged users.
- For each old Role assignment: the corresponding membership has at least one MembershipRole with the same role permissions.
- For each old AgencyUserPermission: corresponding MembershipPermissionOverride exists.
- For each domain row (sample 5,000): `row.tenantId == agency_to_tenant(row.agencyId)`.
- For each Document row: `tenantId` matches the parent entity's tenantId.
- All `EmployeeAgencyAccess` rows have `tenantId` set and `agencyId` resolves within the same tenant.

### 6.3 Functional smoke after cutover

- Each existing user can log in.
- Login redirects to the correct tenant subdomain (or single-membership flow without prompt).
- Role-gated routes still resolve.
- Reports run with identical row counts as pre-migration (within tolerance for newly written rows).
- Document downloads still resolve.

### 6.4 Cross-tenant negative tests

- A user from Tenant A cannot list any data from Tenant B (run for every TENANT-scoped model).
- A user from Tenant A cannot retrieve a document by id belonging to Tenant B (404, not 403).
- A platform admin can list across tenants but every action writes to `PlatformAuditLog`.

---

## 7. Risks Specific to the Split

| Risk | Mitigation |
|---|---|
| Data loss during reparenting (FK cascade or missed table) | Run on staging clone; checkpoint table; idempotent re-runs; full DB snapshot before write phase |
| Duplicate emails (`User.email` global unique) | Pre-flight blocks migration; reconcile manually |
| Role rename collisions when promoting to tenant-scoped | Tenant-scoped roles use `(tenantId, key)`; no collision possible across tenants |
| Identifier collision in cutover window | Advisory locks + dual-key writes |
| Hidden references to `Agency.isSystem` in service code | Audit pass before Phase 3 removal; codeowners review |
| Lost super-admin access | `pa` claim + dual-honor period; no single-step removal of `agencyIsSystem` |
| Storage objects orphaned after rekey | Daily reconciliation job: every `Document.storageKey` must `HEAD` successfully |

---

## 8. What is **out of scope** for the split

- Hierarchical agencies (sub-agencies of sub-agencies) — current schema has no parent linkage; punt.
- Cross-tenant identity merge (a user with two emails at two tenants discovering they're the same person) — handled in Phase 4 with email-merge UX.
- Tenant rename / merge / split operations after the fact — not Phase 0–3 scope.

---

## 9. Snapshot of the Intended End State

```
Tenant: Acme (id=A_ID)                          ← was: Agency "Acme" (isSystem=false)
├── Default Agency: "Acme" (id=newUuid_1)       ← new row; replaces old agency for FKs
│     └── Users (memberships): alice, bob       ← TenantMembership rows; AgencyMembership(agencyId=newUuid_1)
└── (future) Sub-Agency: "Acme HR" (id=newUuid_2)

Platform Admins (no tenant):                    ← were: users in isSystem=true agency
└── carol, dave (PlatformAdmin rows)
```
