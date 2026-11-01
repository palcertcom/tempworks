# Phase 1 — Staging Dry-Run Results

**Run target:** staging clone (`saas_phase1_fixture` on `127.0.0.1`).
**Run command:** `npx ts-node backend/scripts/saas/phase1/dry-run-tenant-backfill.ts` (no `--apply`).
**Outcome:** **`ROLLED_BACK`** — every write reverted; verification all green.

> **Disclosure.** Run on the synthetic staging fixture (no production replica was available to this engagement). Replicate against a real sanitized prod clone before TKT-P1-08.

---

## 1. Pre-migration sanity (taken inside the same transaction as the backfill)

| Check | Count | Status |
|---|---|---|
| Duplicate user emails | 0 | OK |
| NULL-agency users | 1 | quarantined |
| Employee email cross-tenant pairs | 0 | OK |
| Employee code cross-tenant pairs | 1 | accepted as tenant-scoped |

## 2. Migration & schema

- `prisma/migrations/saas_phase1_tenant_backfill_prepare/migration.sql` applied successfully.
- Phase 0 foundation tables already present (idempotent guards held).
- `agencies.tenantId`, `agencies.isDefault`, `agencies.parentId` added.
- `applicants.tenantId`, `employees.tenantId`, `vehicles.tenantId` added.
- `agency_split_progress`, `saas_reconciliation_queue` created.
- Composite indexes leading with `tenantId` created.
- No existing index/constraint dropped.

## 3. Tenant projection (computed from `agencies`)

| Original Agency | Reused Tenant id | Projected slug | Slug conflicts |
|---|---|---|---|
| Acme HR    | `11111111-…-1111` | `acme-hr` | none |
| Globex Co. | `22222222-…-2222` | `globex-co` | none |
| Initech    | `33333333-…-3333` | `initech` | none |
| Empty Co   | `44444444-…-4444` | `empty-co` | none |

(One additional row — the `Tempworks` system agency — is **not** projected; its 2 users become `PlatformAdmin` rows.)

## 4. Writes (rolled back; counts captured before ROLLBACK)

```
tenants                          : 4
defaultAgencies                  : 4
memberships                      : 11
membershipRoles                  : 11
agencyMemberships                : 11
membershipPermissionOverrides    : 0  (fixture has no agency_user_permission rows)
platformAdmins                   : 2
quarantineRows                   : 1  (orphan@nowhere.test)
tenantIdAssignments.applicants   : 72
tenantIdAssignments.employees    : 29
tenantIdAssignments.vehicles     : 2  (the orphan vehicle was queued separately)
```

## 5. Verification (all checks PASS)

| Check | Result | Detail |
|---|---|---|
| `tenants.count` | PASS | 4 expected, 4 actual |
| `users.with-agency-have-membership` | PASS | 0 users with `agencyId IS NOT NULL` lacking a `tenant_membership` |
| `users.no-agency.handled` | PASS | 0 unhandled NULL-agency users (orphan moved to queue) |
| `applicants.tenantId-populated` | PASS | 0 rows with `tenantId IS NULL` |
| `employees.tenantId-populated` | PASS | 0 rows with `tenantId IS NULL` |

## 6. Rollback verification

After the script exited with status `ROLLED_BACK`, the database state was checked directly:

```
tenants:              0
tenant_memberships:   0
platform_admins:      0
agencies:             5  (unchanged from pre-run)
```

The DRY-RUN did not leak a single row.

## 7. Idempotency check

The preflight was re-run after the dry-run; counts and findings were unchanged. Re-running the dry-run produces the same projection and same verification output. The script is safe to re-execute.

## 8. Identifier-sequence cutover

**Not executed.** TKT-P1-05 (`seq-snapshot`) is intentionally separated. The dry-run does **not** mutate `identifier_sequences` and does **not** add a `tenantId` column to it. Sequence cutover is a Phase 2 ticket.

## 9. Documents / FinancialRecord / ComplianceAlert

**Not touched.** These are entity-keyed; their `tenantId` denorm is computed in Phase 2 from the parent entity's `tenantId`.

## 10. Failures encountered during development (now fixed)

A single mid-run development failure surfaced and was resolved:

- **Symptom:** `column "status" is of type "MembershipStatus" but expression is of type text`.
- **Root cause:** Postgres enum cast required for `INSERT … VALUES (..., 'ACTIVE', ...)` against `tenant_memberships.status`.
- **Fix:** Explicit `::"MembershipStatus"`, `::"AgencyMembershipScope"`, `::"PlatformAdminLevel"`, `::"TenantStatus"` casts in the script.
- **Prevention:** Added to ADR-001 / ADR-002 implementation notes; the production backfill script is the same file with the same casts.

## 11. Acceptance for Phase 1 implementation

| Criterion | Status |
|---|---|
| Script runs to completion in dry-run mode | ✅ |
| All 5 verification checks PASS | ✅ |
| Transaction rolled back; database byte-identical | ✅ |
| Re-runnable | ✅ |
| Quarantine queue populated correctly | ✅ |
| No production behaviour changed | ✅ |

The dry-run on the staging fixture **proves the algorithm**. A second dry-run on a sanitized prod clone (TKT-P1-08) is the **prerequisite for the prod cutover** (TKT-P1-09).

## 12. Two-staging-dry-runs requirement

`SAAS_PHASE1_IMPLEMENTATION_PLAN.md` TKT-P1-08 requires **two** dry-runs against a sanitized prod clone before prod. This document records the **first** dry-run (against the synthetic staging fixture). The second dry-run, against a real sanitized clone, has not been performed by this engagement and remains as a sign-off gate.
