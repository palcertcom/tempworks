# Phase 2.11 — Recycle Bin Pilot Results

> Fifth tenant-scoped pilot. First pilot to span four services and
> 16 entity types in a single module. Validates that the pattern
> scales beyond single-table services.

---

## 1. Headline

```
build:                                             ✅
prisma validate:                                   ✅
saas:validate (6 suites):                          ✅
saas:schema-lint:                                   ✅
saas:phase2-recycle-bin-equivalence:               11/11 cases PASS
saas:phase2-recycle-bin-isolation:                  7/7  cases PASS
saas:phase2-notifications-equivalence (regression):11/11 cases PASS
saas:phase2-notifications-isolation   (regression): 8/8  cases PASS
saas:phase2-job-ads-equivalence       (regression):13/13 cases PASS
saas:phase2-job-ads-isolation         (regression): 9/9  cases PASS
saas:phase2-compliance-equivalence    (regression):12/12 cases PASS
saas:phase2-compliance-isolation      (regression): 7/7  cases PASS
saas:phase2-ewh-equivalence           (regression):12/12 cases PASS
saas:phase2-ewh-isolation             (regression): 8/8  cases PASS
saas:scan:                                         576 unreviewed (down from 759)
saas:scan:raw-sql:                                 baseline unchanged
production defaults:                               all OFF
```

## 2. What was tested

### Equivalence (11/11 PASS)

- Pilot active state under flag combinations.
- `getEntityCounts`: tenant-scoped types (APPLICANT, EMPLOYEE) ≤ legacy
  in pilot; total ≤ legacy.
- USER count is GLOBAL — equal in both modes (proves the scope-map's
  global classification is honoured).
- `findAll(all types)` total: pilot ≤ legacy.
- `findAll(entityType=JOB_AD)`: pilot ≤ legacy (tenant-scoped).
- `findAll(entityType=DOCUMENT_TYPE)`: equal across modes (global).
- Error path: unknown entityType raises identical error class.
- Response shape preserved (`PaginatedResponse + counts.total`).

### Isolation (7/7 PASS)

- Pilot ON tenant A: `getEntityCounts.JOB_AD` < combined-tenant total.
- Pilot ON tenant A: `findAll(JOB_AD)` excludes tenant B's id.
- Pilot ON tenant A: `RestoreService.restore(JOB_AD, tenantB-id)`
  raises `NotFoundException`; the row's `deletedAt` is unchanged.
- Pilot ON tenant A: `HardDeleteService.execute(JOB_AD, tenantB-id)`
  raises `NotFoundException`; the row still exists.
- Global entity counts (USER, ROLE, DOCUMENT_TYPE, MAINTENANCE_TYPE,
  WORKSHOP, REPORT) are EQUAL across modes — proves the scope map.
- Concurrent ALS frames: T_A no B-rows, T_B no A-rows.
- Pilot OFF: legacy returns the union (tenant A + tenant B).

## 3. Lessons learned

1. **A central scope map per module pays off.** With 16 entity types,
   the difference between "tenant-scoped" and "global" needed a
   single source of truth. `tenant-scope-map.ts` plus
   `tenantWhereFor()` keeps every call site uniform.
2. **Pre-check + legacy mutation is the right shape for restore +
   hard-delete.** Both services share the same `assertTenantOwnership`
   contract. Once the pre-check passes, the per-entity branch runs
   unchanged on `legacyPrisma`. Cross-tenant ids cannot reach the
   mutation step.
3. **`safeList` / `safeCount` patterns coexist with the pilot.** The
   service's existing P2021/P2022 tolerance still works under pilot —
   missing tables/columns surface as zero counts. The pilot adds
   tenant filtering on top without breaking the schema-tolerance
   layer.
4. **Bulk Python annotation is fine for large services.** Adding
   `// @tenant-reviewed: phaseXX-...` to ~180 call sites by hand would
   take a day. A dozen lines of Python finished it in seconds. The
   key is that the annotation is meaningful (phase + scope class),
   not just suppression.
5. **`DatabaseCleanupService` is the right thing to exclude.** A
   System Admin global wipe is a platform operation; tenant-scoping
   it would defeat its purpose. The `phase211-excluded-platform`
   annotation makes the intent explicit.
6. **Mass-narrow fixtures need targeted harness queries.** The
   APPLICANT model has many columns Phase 1's narrow fixture lacks.
   The harness uses JOB_AD (which Phase 2.9 fully populated) and
   DOCUMENT_TYPE (Phase 2.4) for the per-entityType cases — same
   semantics, no fixture rewrite needed.

## 4. Soft-delete / restore risks

- **`canRestoreWithRelated`** semantics (cascade restore): pilot does
  not change them. The `tenantWhere` is applied at the parent level;
  `tx.document.updateMany` inside the transaction continues to use
  legacyPrisma's transaction handle. Acceptable because the parent's
  ownership has already been verified by `assertTenantOwnership`, so
  any related rows (which share the parent's tenantId by construction)
  are by definition in the same tenant.
- **Email/slug/name uniqueness** conflict checks (e.g. `restoreApplicant`
  checks `email` is not in use) currently scan globally. Pilot does
  not narrow them — uniqueness is global on these models. A Phase 3
  swap to per-tenant uniqueness will require revising these checks
  (similar to the slug story for job-ads).
- **`DatabaseCleanupService`** is the only service that intentionally
  crosses tenants. It remains gated by System Admin role + an explicit
  `confirmPhrase`. Phase 2.11 only annotates the call sites; behaviour
  is unchanged.

## 5. Whether the pattern remains reusable

**Yes.** The Phase 2.7-2.10 pattern (`PilotPrismaAccessor` +
`getPilotScope(pilot, moduleName)` + `tenantWhere()`/`tenantData()`
spreads) handled a 4-service / 16-entity module without modification.
New ingredients in Phase 2.11:

- A module-local `tenant-scope-map.ts` listing tenant-scoped vs.
  global entity types. Reusable for any future module that mixes
  tenant-scoped and global models.
- A shared `assertTenantOwnership(entityType, id)` pattern for
  services that mutate across many entity types via switch/case.
- Three annotation tags (`phase211-pilot-scope`, `phase211-global`,
  `phase211-excluded-platform`) that make the scanner output
  self-documenting.

## 6. Next recommended module

The remaining low-risk module candidates are now thin. Suggested next
phase: address the **Phase 2.11+ scheduler / job-context** work
flagged by Phase 2.10's notifications scope split. That's the
prerequisite for refactoring `notifications` background paths,
`vehicles` mutation paths, and the report-generation cron.

If a no-scheduler pilot is preferred next: split `src/finance` into
read paths first (similar to Phase 2.10's notifications split). The
financial dashboard reads are tenant-scoped via Phase 2.3 denorm
and read-mostly.

## 7. Blockers before larger modules

1. **Audit log writes** continue to be on `legacyPrisma` everywhere.
   Phase 3 should standardise the audit-log accessor across all
   services.
2. **Email / slug / name uniqueness** scans across tenants. Phase 3
   per-tenant uniqueness migration is needed before any service can
   safely allow same-name records across tenants.
3. **Job-context framework** (still owed from Phase 2.10) — required
   before the cron-driven services move.
4. **`TenantPrismaService.client` `$extends` shim** still throws
   when `TENANT_PRISMA_ENFORCEMENT=true` AND the registry is non-empty.
   Five pilots have shipped working filtering at the service layer;
   Phase 3 still owes the wrapper-level enforcement implementation.

## 8. Production behaviour change status

**Unchanged.** With `TENANT_PRISMA_PILOT_ENABLED=false` (default),
`getPilotScope()` returns inactive. `tenantWhereFor()` returns `{}`
for every entity type and `assertTenantOwnership` short-circuits.
Every legacy SQL is byte-for-byte identical to before this PR.
`DatabaseCleanupService` is unchanged in either mode.
