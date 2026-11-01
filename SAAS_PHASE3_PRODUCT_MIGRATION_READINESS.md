# SaaS Phase 3.0 — Product Migration Readiness

Entry point for Phase 3 product-level SaaS migrations. Phase 3.0
establishes the safety nets (duplicate detection, audit docs,
PlatformAdmin design) that the destructive migrations of Phase 3.1+
depend on.

## What this phase delivers

1. **Read-only duplicate detection** —
   `backend/scripts/saas/phase3/uniqueness-duplicate-report.ts` /
   `npm run saas:phase300-uniqueness-duplicate-report`. Wraps every
   query in `BEGIN READ ONLY`; contains no `INSERT/UPDATE/DELETE` SQL.
2. **Readiness harness** —
   `backend/scripts/saas/phase3/product-migration-readiness.ts` /
   `npm run saas:phase300-product-migration-readiness`. Seeds
   synthetic duplicates in the staging fixture (temporarily lifting
   global UNIQUE constraints so the seed can land), runs the
   read-only report against them, asserts the detector classifies
   them correctly, then deletes the seed rows and restores the
   constraints. Net effect: zero rows changed.
3. **Uniqueness audit** —
   `SAAS_PHASE3_UNIQUENESS_AUDIT.md` lists current vs. desired
   constraints with a four-stage migration order.
4. **PlatformAdmin foundation** —
   `SAAS_PHASE3_PLATFORM_ADMIN_FOUNDATION.md` documents how
   `Agency.isSystem` will be retired in favour of the already-present
   `PlatformAdmin` model.

## What this phase does NOT do

- Add any unique constraint.
- Touch login / session / auth.
- Backfill `PlatformAdmin` rows in production.
- Drop `Agency.isSystem`.
- Modify production data.
- Add any destructive migration.

## Validation

| Check                                | Result |
| ------------------------------------ | ------ |
| `nest build`                         | clean |
| `npx prisma validate`                | clean |
| `npm run saas:schema-lint`           | 0 issues |
| `npm run saas:scan:annotations`      | 0 findings |
| `saas:phase300-uniqueness-duplicate-report` | 0 blocking duplicates (fixture) |
| `saas:phase300-product-migration-readiness` | 13/13 PASS |
| `saas:phase263-workflow-config-isolation` | 19/19 PASS |
| `saas:phase262-pipeline-mutation-isolation` | 17/17 PASS |
| `saas:phase261-pipeline-isolation`   | 12/12 PASS |
| `saas:phase261-pipeline-equivalence` | 12/12 PASS |

Cumulative regression count: **837/837 PASS** (824 from Phase 2.63 + 13
new readiness cases).

## Rollback

Phase 3.0 makes no schema or data changes. Rollback = revert docs and
scripts.

## Production behaviour

Unchanged. No feature flag is flipped. Legacy `Agency.isSystem` paths
remain authoritative.

## Recommended next phase

**Phase 3.1 — Tenant backfill completion.** Re-run the duplicate
report against staging clones of production data. Backfill any
`tenantId IS NULL` rows on `Employee` and `Applicant`. Then plan
Phase 3.2 cleanup of the same-tenant duplicate set surfaced by the
report.

---

## Phase 3.1 addendum

Phase 3.1 lands the production-shaped readiness reports + 16-case
readiness harness (`saas:phase310-readiness-check`). Phase 3.0
remains 13/13. Cumulative regression: 853/853. See
SAAS_PHASE3_1_READINESS.md.

---

## Phase 3.2 addendum

Same-tenant duplicate cleanup planning + gated apply layer
shipped (dry-run-first; soft-delete only; three-gate apply).
Harness 22/22 PASS. Cumulative regression: 875/875.

---

## Phase 3.3 addendum

Additive per-tenant partial unique indexes landed via
`saas_phase33_per_tenant_uniques` migration. Globals retained.
Harness 19/19 PASS. Cumulative 894/894.

---

## Phase 3.4 addendum

Destructive migration `saas_phase34_drop_employee_global_uniques`
landed. Cross-tenant Employee identifier reuse now allowed.
Harness 20/20 PASS. Cumulative 914/914.

---

## Phase 3.5 addendum

PlatformAdmin backfill (dry-run-first, three-gate apply) landed.
Harness 16/16 PASS. Cumulative 930/930. Auth path still flows
through Agency.isSystem until Phase 3.6 dual-read guard.

---

## Phase 3.6 addendum

PlatformAdmin dual-read helper landed (`isPlatformAdmin(userId)`).
Default ON via `PLATFORM_ADMIN_DUAL_READ_ENABLED`. Not yet consumed
by any guard. Phase 3.7 will wire endpoints. Cumulative 944/944.

---

## Phase 3.7 addendum

JWT stamp routed through PlatformAdminAccessService. Downstream
consumers unchanged. Harness 15/15 PASS. Cumulative 959/959.
Phase 3.8 will drop Agency.isSystem.

---

## Phase 3.9 addendum

Destructive migration `saas_phase39_drop_agency_is_system` dropped
the `Agency.isSystem` column. PlatformAdmin is now the sole source
of platform authority. Harness 14/14 PASS. Cumulative 1003/1003.

---

## Phase 3.10 addendum

Inert flag references removed from runtime source. `platform_audit_logs`
table migration added (matches the existing Prisma `PlatformAuditLog`
model). PlatformAuditLog emission documented as **deferred** — there
is no runtime grant/revoke surface yet. See
SAAS_PHASE3_PLATFORM_ADMIN_CLEANUP_AUDIT_LOG.md.
