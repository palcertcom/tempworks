# SaaS Phase 3.10 — PlatformAdmin Cleanup + PlatformAuditLog Migration

Phase 3.10 closes out the Agency.isSystem retirement track by:
1. Removing the now-inert fallback flags from runtime source.
2. Adding the missing `platform_audit_logs` table migration to match
   the existing Prisma `PlatformAuditLog` model.
3. Documenting PlatformAuditLog emission as **deferred** — there is
   no runtime PlatformAdmin grant/revoke surface in the codebase
   yet to emit from.

## Cleanup summary

Source walk of `backend/src/**/*.ts` confirms:
- 0 references to `PLATFORM_ADMIN_DUAL_READ_ENABLED`.
- 0 references to `PLATFORM_ADMIN_LEGACY_AGENCY_FALLBACK`.
- 0 non-comment `agency.isSystem` reads outside the allow-list
  (`src/saas/platform-admin/`, `src/agencies/`, `src/auth/auth.service*`).
- Prisma schema no longer contains `Agency.isSystem`.

`PlatformAdminAccessService` was refactored in Phase 3.9 to read only
`platform_admins.userId`; this phase confirms the surface stays clean
and locks the invariant with a harness assertion.

The flag names may still appear in **docs** (historical record) and
in older harnesses' inline `process.env` setters where they were
explicitly noted as inert. Those setters are no-ops and documented.

## Removed flags (runtime)

| Flag | Status | Notes |
|---|---|---|
| `PLATFORM_ADMIN_DUAL_READ_ENABLED` | inert | not read by the access service after Phase 3.9; removed from runtime source in Phase 3.10 |
| `PLATFORM_ADMIN_LEGACY_AGENCY_FALLBACK` | inert | same as above |

Operators may continue to set these in environment files for one
release of backwards compatibility; the application ignores them.

## PlatformAuditLog migration

Files:
- `backend/prisma/migrations/saas_phase310_platform_audit_log/migration.sql`
- `backend/prisma/migrations/saas_phase310_platform_audit_log/migration.down.sql`

The UP migration creates the `platform_audit_logs` table to match the
Prisma model exactly:

```sql
CREATE TABLE IF NOT EXISTS "platform_audit_logs" (
  "id"        BIGSERIAL    PRIMARY KEY,
  "actorId"   text         NOT NULL,
  "tenantId"  text,
  "action"    text         NOT NULL,
  "reason"    text         NOT NULL,
  "target"    jsonb,
  "ip"        text,
  "userAgent" text,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "platform_audit_logs_actorId_createdAt_idx"
  ON "platform_audit_logs" ("actorId", "createdAt");
CREATE INDEX IF NOT EXISTS "platform_audit_logs_tenantId_createdAt_idx"
  ON "platform_audit_logs" ("tenantId", "createdAt");
```

`actorId` is plain `text` (no FK) so backfill / system actors
(e.g. `'phase350-backfill'`) can be recorded. Additive, idempotent
(`IF NOT EXISTS`), no data mutation.

DOWN migration:

```sql
DROP TABLE IF EXISTS "platform_audit_logs";
```

Safe in development. After Phase 3.10 is deployed, dropping the table
loses any captured audit rows (none today; emission is deferred).

## Emission status: DEFERRED

The harness walks `backend/src/**/*.ts` for any
`this.prisma.platformAdmin.create | delete | update` or equivalent
call and finds **none**. The only "grant" surface today is the Phase
3.5 backfill script. Phase 3.10 deliberately does **not** wire
emission:

- No runtime endpoint or service mutates `PlatformAdmin`.
- The backfill script is operator-run, gated by three flags, and
  already self-tags inserts via `grantedBy='phase350-backfill'`.

Adding runtime emission requires first introducing a
`PlatformAdminService.grant(userId, level, reason)` /
`.revoke(userId, reason)` surface — which is a product decision out
of scope for the Phase 3 retirement track. Tagged
`phase310-platform-audit-log-emission-deferred`.

## Harness results

`saas:phase310-platform-admin-cleanup-audit-log`: **18/18 PASS**

Coverage:
1-2. PlatformAdminAccessService source free of inert flag references.
3. src/ walk: 0 non-comment `agency.isSystem` reads outside allow-list.
4. Schema: no Agency.isSystem field.
5. Schema: PlatformAuditLog model present.
6-8. Migration SQL: CREATE TABLE only, single DROP TABLE in down, no UPDATE/DELETE.
9. Applied migration creates table in fixture.
10. Columns + indexes match Prisma model (9 columns, two composite indexes).
11. JWT output shape preserved (8 keys).
12-13. PlatformAdmin user → true, non-PA user → false.
14. Audit emission status: deferred (no runtime grant/revoke surface).
15-18. Phase 3.7B / 3.8 / 3.9 wiring intact; cumulative sentinel outputs present.

Cumulative regression: **1021/1021 PASS** (1003 + 18).

## Validation

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npx prisma validate` | clean |
| `npm run saas:schema-lint` | 0 issues |
| `npm run saas:scan:annotations` | 0 findings |
| `npm run saas:scan:raw-sql` | baseline unchanged |
| `saas:phase310-platform-admin-cleanup-audit-log` | 18/18 PASS |
| `saas:phase390-drop-agency-is-system` | 14/14 PASS |
| `saas:phase380-platform-admin-runtime-retirement` | 16/16 PASS |
| `saas:phase37b-platform-admin-jwt-bake-check` | 14/14 PASS |
| `saas:phase370-platform-admin-jwt-dual-read` | 15/15 PASS |
| `saas:phase360-platform-admin-dual-read-guard` | 14/14 PASS |
| `saas:phase350-platform-admin-backfill-harness` | 16/16 PASS |
| `saas:phase340-drop-employee-global-uniques` | 20/20 PASS |
| `saas:phase330-per-tenant-unique-constraints` | 19/19 PASS |
| `saas:phase320-duplicate-cleanup-harness` | 22/22 PASS |
| `saas:phase310-readiness-check` | 16/16 PASS |
| `saas:phase300-product-migration-readiness` | 13/13 PASS |
| `saas:phase263-workflow-config-isolation` | 19/19 PASS |
| `saas:phase262-pipeline-mutation-isolation` | 17/17 PASS |
| `saas:phase261-pipeline-isolation` | 12/12 PASS |
| `saas:phase261-pipeline-equivalence` | 12/12 PASS |

## Production behaviour

Unchanged at runtime. The cleanup is purely source-level (removing
the inert flag plumbing). The new `platform_audit_logs` table is
empty; nothing writes to it.

## Rollback

- Migration: `migration.down.sql` drops the new table.
- Code: revert Phase 3.10 commit to re-introduce the (no-op) flag
  references. No data state to undo.

Agency.isSystem rollback is **not** covered here; that belongs to
Phase 3.9's down migration and its data-loss caveat.

## Remaining blockers

- No runtime `PlatformAdmin.grant/revoke` surface exists. Until one is
  added, the new `platform_audit_logs` table receives no rows. Audit
  trail for platform-admin changes is currently the
  `grantedBy='phase350-backfill'` tag on the `platform_admins` rows
  themselves.

## Recommended next phase

**Phase 3.11 (optional) — PlatformAdmin grant/revoke service +
PlatformAuditLog emission.** Introduce `PlatformAdminService.grant`
and `.revoke` (tenant-admin-only, MFA-gated) backed by an `/
_platform/admin/grants` endpoint. Emit `PlatformAuditLog` rows for
every operation. Wire the existing `PlatformAdminGuard` to enforce
authority on the new endpoint.

---

## Phase 3.11 addendum

`PlatformAdminService` (grant / revoke / list) lands at
`src/saas/platform-admin/platform-admin.service.ts`. SUPER-only
authority gate; PlatformAuditLog emission for every operation. No
HTTP controller registered yet — service is module-only. See
SAAS_PHASE3_PLATFORM_ADMIN_GRANT_REVOKE.md.
