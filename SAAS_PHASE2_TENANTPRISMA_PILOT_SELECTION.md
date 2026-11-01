# Phase 2.6 — TenantPrisma Pilot Module Selection

> Teach one small room to obey tenant boundaries before renovating the whole castle.

---

## 1. Selected module

**`src/roles`** — the `RolesService` + `RolesController` + `RolesModule`.

## 2. Why selected

| Property | Value |
|---|---|
| Lines of code (service) | 137 |
| `this.prisma.*` call sites | 11 |
| Module size (controller + service + module) | 204 lines |
| Public API surface | 7 endpoints (`findAll`, `findOne`, `create`, `update`, `remove`, `getPermissions`, `getPermissionsMatrix`) |
| Risk tier | **P3 — low** (small module, system-config data, low mutation rate) |
| Data ownership model | **GLOBAL** — `Role`, `Permission`, `RolePermission` all live in `GLOBAL_MODELS` (`src/saas/prisma/tenant-scoped-models.ts`); none has a `tenantId` column |
| Expected tenant filter field | **none** — these are global tables |
| Agency-scope implications | none |
| Touched by other refactors | no — sits behind a boundary that only `users` references |
| Existing tests | none in the unit suite (pilot harness becomes the regression bar) |
| Rollback cost | flip flag, redeploy — RTO < 1 min |

The module hits every condition for a "low-risk pilot":

- Few call sites (11) → compact diff, easy review.
- Tables are GLOBAL → the pilot proves the **pass-through** path of
  `TenantPrismaService.client`. No production rows are filtered or
  hidden under any flag combination.
- Has full CRUD → exercises both reads and writes.
- Has both single-table and multi-table reads (`findOne` joins
  `permissions` via `permissions: { include: { permission: true } }`).
- Already part of the SaaS Phase 0 GLOBAL classification — the pilot
  validates the existing classifier rather than introducing new
  tenant-scope claims that would need a separate review.

## 3. What the pilot proves

- The injection pattern works: a service can take `PilotPrismaAccessor`
  as a dependency and route reads/writes through it without changing
  the call sites.
- With `TENANT_PRISMA_PILOT_ENABLED=false` (production default), the
  accessor returns `PrismaService` directly — byte-for-byte identical
  to legacy.
- With the flag ON in a SAFE_CLONE / SAFE_STAGING environment, the
  accessor returns `TenantPrismaService.client`. Today (with
  `TENANT_PRISMA_ENFORCEMENT=false`), that is also a pass-through; in
  Phase 3 it becomes a `$extends`-wrapped client that intercepts
  tenant-scoped models. Roles are GLOBAL, so the wrapper will pass
  them through unchanged — exactly the contract we want for global
  tables.
- The pilot accessor refuses to engage outside SAFE_CLONE /
  SAFE_STAGING even with the flag set — proven by the isolation
  harness's "NODE_ENV=production override" case.

## 4. Why other candidates were rejected

| Candidate | Reason rejected |
|---|---|
| `src/applicants`, `src/employees`, `src/reports`, `src/finance`, `src/documents`, `src/workflow`, `src/attendance`, `src/notifications` | Listed in the avoid set — too high-risk for a pilot. |
| `src/agencies` | Tenant-scoped, but every other service depends on it. A pilot here would require coordinated changes across the codebase. |
| `src/vehicles` | 51 prisma calls, mixed agencyId/tenantId fields, broad mutation surface. Saved for a later wave. |
| `src/settings` | Excellent fit for "global pass-through" but mixes SystemSetting + JobType + DocumentType + NotificationRule into one service (614 lines). Larger pilot diff than warranted. |
| `src/employee-work-history` | Tenant-scoped via Phase 2.3 denorm. Could be a follow-up pilot, but the per-employee semantics make the equivalence harness more involved (we'd need a tenant fixture set up correctly). Roles is simpler. |
| `src/roles` (selected) | Smallest, safest, most-global. ✓ |
| `src/application-drafts` | 14 prisma calls, but the service handles draft persistence with side effects (storage + fingerprinting); too much surface for a pilot. |
| `src/job-ads` | 0 services / unused — would prove nothing. |
| `src/email`, `src/common`, `src/saas` | Infrastructure; not Prisma consumers. |

## 5. Pilot success criteria

The pilot is "green" when:

- `npm run saas:phase2-tenantprisma-pilot-equivalence` returns N/N PASS
  with the harness running both legacy and pilot paths back-to-back on
  the same DB.
- `npm run saas:phase2-tenantprisma-pilot-isolation` returns N/N PASS,
  including the "pilot ON + NODE_ENV=production → refuses to engage"
  step.
- `npm run build`, `npm run saas:validate`, `npm run saas:schema-lint`
  all green.
- No raw-SQL scanner regression.
- `RolesService` produces byte-identical responses with the flag OFF
  vs. the flag ON in a safe env.

## 6. Out of scope for this pilot

- Tenant-scoped models. Roles is intentionally GLOBAL — the pilot does
  not (and must not) introduce a `tenantId` filter on roles.
- `TENANT_PRISMA_ENFORCEMENT=true`. The pilot operates with the
  enforcement flag OFF; Phase 3 turns it on.
- Other modules. The accessor is reusable, but this PR refactors
  exactly one module.
