# Phase 2.30 — Cross-Module Audit Log Tenancy Pilot Results

> Consolidates audit-log emissions from finance, documents, workflow, and applicants
> behind a single shared `TenantAuditLogService`. Adds an additive nullable
> `AuditLog.tenantId` column gated by a new flag `TENANT_AUDIT_LOG_PILOT_ENABLED`
> (default `false`).

---

## 1. What changed

| Surface | Change |
|---------|--------|
| `prisma/schema.prisma` (`AuditLog`) | Additive `tenantId String?` + `@@index([tenantId])` + `@@index([tenantId, createdAt])` |
| `src/saas/feature-flags/flags.ts` + `feature-flags.service.ts` | New flag `TENANT_AUDIT_LOG_PILOT_ENABLED` (default `false`) |
| **NEW** `src/saas/audit/tenant-audit-log.service.ts` | Shared emitter — reads ALS, gates on flag + env, never throws |
| **NEW** `src/saas/audit/tenant-audit-log.module.ts` | Exports `TenantAuditLogService` |
| `src/finance/finance.service.ts` | Private `auditLog()` helper now delegates to `TenantAuditLogService` |
| `src/documents/documents.service.ts` | All 6 inline `legacyPrisma.auditLog.create` calls replaced with `tenantAuditLog.write(...)` |
| `src/workflow/workflow.service.ts` | All 4 inline calls replaced |
| `src/applicants/applicants.service.ts` | Private `auditLog()` helper now delegates to `TenantAuditLogService` |
| `src/{finance,documents,workflow,applicants}/*.module.ts` | Import `TenantAuditLogModule` |
| `scripts/scan-annotations.ts` | New tag `phase230-audit-log-pilot` covers the 4 piloted services + `src/saas/audit/` |
| `scripts/saas/phase2/audit-log-tenancy-harness.ts` | NEW 8-case harness on real Postgres |
| `package.json` | New script `saas:phase230-audit-log-harness` |
| All 5 modules' existing harnesses | Updated `new XService(...)` instantiations to pass the shared audit service |

Vehicles is unchanged — the module emits no audit rows (confirmed in
`SAAS_PHASE230_AUDIT_LOG_INVENTORY.md` §2).

## 2. What did not change

- No `auditLog` API/DTO/response shape change.
- No retention / cleanup logic change.
- No business logic, no mutation behaviour, no CRUD or lifecycle change.
- No backfill of historical rows. `tenantId` defaults to `NULL` for both
  pre-2.30 rows and any row written under the default flag.
- No ipAddress / userAgent capture change.
- Production behaviour with all flags OFF is byte-identical to pre-2.30.

## 3. Decision matrix (shared helper)

| `TENANT_AUDIT_LOG_PILOT_ENABLED` | Env classification | ALS frame | Explicit `tenantId` | Row written with |
|---|---|---|---|---|
| false | any | any | any | `tenantId = NULL` (legacy) |
| true | UNSAFE_PRODUCTION / UNKNOWN | any | any | `tenantId = NULL` (env-safety guard) |
| true | SAFE_CLONE / SAFE_STAGING | absent | absent | `tenantId = NULL` |
| true | SAFE_CLONE / SAFE_STAGING | present | absent | `tenantId = ALS.tenantId` |
| true | SAFE_CLONE / SAFE_STAGING | absent | present | `tenantId = explicit override` |
| true | SAFE_CLONE / SAFE_STAGING | present | present | `tenantId = explicit override` (wins) |

The shared helper never throws — a write failure is logged and
swallowed so the caller's main flow is preserved.

## 4. Pilot activation

```
TENANT_AUDIT_LOG_PILOT_ENABLED=true
NODE_ENV=staging
TenantContext.attach({ id: ... })
```

Independent of `TENANT_PRISMA_PILOT_ENABLED`. The audit-log pilot can
be rolled out separately from the per-module Prisma pilots.

## 5. Audit-log tenancy harness — 8/8 PASS (real Postgres 16)

```
[audit-log-tenancy-harness] 8/8 PASS
```

Covers:
1. Pilot OFF writes `tenantId = NULL`.
2. Pilot ON + ALS A writes `tenantId = A`.
3. Pilot ON + ALS B writes `tenantId = B`.
4. Pilot ON without ALS frame falls back to `tenantId = NULL`.
5. Explicit `tenantId` override wins even without ALS frame.
6. `decide()` reports inactive when flag is off.
7. `write()` swallows DB errors — never throws.
8. Source-level meta-assertion: zero remaining
   `legacyPrisma.auditLog.create` in finance / documents / workflow /
   applicants; every emit goes through `tenantAuditLog.write(...)`.

## 6. Regression sentinels — all green

Re-ran the four mutation-isolation harnesses after the refactor:

| Harness | Cases |
|---------|------:|
| `saas:phase2-finance-mutation-isolation`     | 16/16 |
| `saas:phase2-documents-mutation-isolation`   | 9/9   |
| `saas:phase2-workflow-mutation-isolation`    | 11/11 |
| `saas:phase2-applicants-mutation-isolation`  | 11/11 |

No mutation, lifecycle, or conversion behaviour regressed.

## 7. Production safety

- New flag defaults to `false`. With every prior flag also at default
  `false`, all five modules behave byte-identically to pre-2.30.
- The shared helper hard-fails the env safety check in production —
  even if `TENANT_AUDIT_LOG_PILOT_ENABLED` were accidentally toggled,
  the runtime classifier still returns `UNSAFE_PRODUCTION` and the
  helper writes legacy-shape rows.
- The schema change is additive and reversible
  (`ALTER TABLE audit_logs DROP COLUMN tenantId`).

## 8. Annotation tag

`phase230-audit-log-pilot` replaces the older per-module tags
(`phase216-audit-log`, `phase220-audit-log`, `phase226-audit-log`,
`phase228-audit-log`) at every site that now delegates to the shared
helper. The older tags remain in `scan-annotations.ts` because they
still apply to non-piloted modules (`employee-work-history`,
`compliance`).

## 9. Cumulative real-DB results

| Module | Cases |
|---|---:|
| Finance | 41 |
| Documents | 52 |
| Vehicles | 65 |
| Workflow | 44 |
| Applicants | 43 |
| **Audit-log tenancy (NEW)** | **8** |
| **Total** | **253/253** |

## 10. Rollback runbook

```sh
# Disable the new behaviour
export TENANT_AUDIT_LOG_PILOT_ENABLED=false

# (optional) Drop the schema additions if reverting the migration
ALTER TABLE audit_logs DROP COLUMN "tenantId";
DROP INDEX IF EXISTS audit_logs_tenantId_idx;
DROP INDEX IF EXISTS audit_logs_tenantId_createdAt_idx;
```

The schema change is additive; legacy code paths keep working with the
column present (it is simply ignored).

## 11. Why no `*-audit-log` tag for future modules

Phase 2.30 collapses all audit emission behind one helper. New
piloted modules (employees, compliance, attendance, agencies, …) call
`tenantAuditLog.write(...)` directly and inherit the
`phase230-audit-log-pilot` tag without needing their own
`phaseNNN-audit-log` annotation. This stops the per-phase audit-tag
drift identified in `SAAS_PHASE2_PRISMA_REFACTOR_STRATEGY.md`.
