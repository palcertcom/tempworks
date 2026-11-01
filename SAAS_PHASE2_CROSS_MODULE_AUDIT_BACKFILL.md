# Phase 2.51 — Cross-Module Audit-Row Tenant Backfill

> Generalises the Phase 2.50 single-entity backfill template across
> six already-piloted modules. Default-OFF; dry-run-first;
> double-gated apply.

---

## 1. Scope

Six target entities, all with a denormalised `tenantId` column on
the target table (Phase 2.3+):

| audit_logs.entity | Target table       | Direct tenantId? |
|---|---|---|
| `Document`        | `documents`        | ✅ |
| `FinancialRecord` | `financial_records`| ✅ |
| `WorkPermit`      | `work_permits`     | ✅ |
| `Visa`            | `visas`            | ✅ |
| `ComplianceAlert` | `compliance_alerts`| ✅ |
| `Notification`    | `notifications`    | ✅ |

Because every target table carries `tenantId` directly, no
employee/applicant fan-out is needed and no row is "ambiguous".
The skip bucket `skippedAmbiguous` is exposed in the report shape
for forward compatibility but always reports `0` for these six
entities.

## 2. Apply gate

Apply requires BOTH of:

| Variable | Default | Effect |
|---|---|---|
| `CROSS_MODULE_AUDIT_BACKFILL_APPLY` | `false` | Stay in dry-run regardless of classification. |
| (also) | runtime classification | Apply also requires `SAFE_CLONE` or `SAFE_STAGING`. UNSAFE_PRODUCTION / UNKNOWN ⇒ dry-run with `refusalReason`. |

If either gate is missing, the script silently downgrades to
dry-run and records the reason in the report.

## 3. Eligible / skipped row rules (per entity)

```sql
-- Per-entity UPDATE shape (parameter for entity name; table name
-- is whitelisted in TARGET_ENTITIES inside the script source).
UPDATE audit_logs al
SET "tenantId" = t."tenantId"
FROM "<table>" t
WHERE al.entity      = '<entity>'
  AND al."entityId"  = t.id
  AND al."tenantId"  IS NULL
  AND t."tenantId"   IS NOT NULL;
```

| Bucket | Predicate |
|---|---|
| **Updated** | `audit.tenantId IS NULL AND target.id = audit.entityId AND target.tenantId IS NOT NULL` |
| Skipped (already stamped) | `audit.tenantId IS NOT NULL` — **never overwritten** |
| Skipped (missing target) | no row in target table matches `audit.entityId` |
| Skipped (target without tenant) | joined `target.tenantId IS NULL` |
| Skipped (wrong entity) | `audit.entity` outside the six-entity allow-list |

The script enumerates `audit_logs.entity = <entity>` once per
target entity, so non-allow-listed entities (e.g., `User`) are
**never read or written**.

## 4. Report shape

```ts
{
  mode: 'dry-run' | 'apply',
  applied: boolean,
  safeClassification: 'SAFE_CLONE' | 'SAFE_STAGING' | ...,
  refusalReason?: string,
  totals: {
    candidateRows, updatedRows,
    skippedAlreadyTenantStamped, skippedMissingTarget,
    skippedTargetWithoutTenant, skippedWrongEntity, skippedAmbiguous
  },
  byEntity: {
    Document:        { candidateRows, updatedRows, ..., beforeNullTenantRows, afterNullTenantRows },
    FinancialRecord: { ... },
    WorkPermit:      { ... },
    Visa:            { ... },
    ComplianceAlert: { ... },
    Notification:    { ... }
  }
}
```

Files: `backend/reports/saas/phase2/cross-module-audit-backfill.{json,md}`.

## 5. Idempotency

Apply UPDATE is idempotent: the WHERE clause excludes already-stamped
rows. A second run finds zero candidates and writes zero rows.
`apply` runs inside a single transaction, so a failure mid-run leaves
the table unchanged.

## 6. Production safety notes

- **No schema migration.** Phase 2.51 is data-only.
- **No runtime change.** Service code is unchanged.
- **Allow-list constrained.** Only the six target entities are
  read or written.
- **Per-entity transaction.** Every entity's UPDATE participates
  in the same `BEGIN`/`COMMIT` so a failure in one rolls back all.
- **Apply gate is double-locked.** Flag + SAFE classification.

## 7. Harness — `cross-module-audit-backfill-harness` 20/20 PASS

```
[cross-module-audit-backfill-harness] 20/20 PASS
```

1. dry-run updates zero rows
2. dry-run reports candidates per entity
3. apply refused when `CROSS_MODULE_AUDIT_BACKFILL_APPLY=false`
4. apply refused outside SAFE_CLONE/SAFE_STAGING (source gate)
5–8. apply updates eligible Document / FinancialRecord /
    ComplianceAlert / Notification rows only
9. WorkPermit handled per schema (direct tenantId join)
10. Visa handled per schema (direct tenantId join)
11. already tenant-stamped rows not overwritten
12. missing target rows skipped
13. target rows with NULL tenantId skipped
14. wrong-entity / non-target rows not touched
15. non-allow-listed entity rows are not touched (User sentinel)
16. seeded candidates become tenant-stamped after apply
17. rerun apply is idempotent
18. per-entity updated counts cover all 6 target entities
19. scanner registers `phase251-cross-module-audit-backfill`
20. backfill module exports `runBackfill` and uses env+SAFE guards

## 8. Validation results

- `nest build` clean
- `npx prisma validate` clean
- `npm run saas:validate` 6/6 suites
- `npm run saas:schema-lint` 0 issues
- `npm run saas:scan:annotations` 0 findings
- `npm run saas:scan:raw-sql` 26 findings — **baseline unchanged**
  (cross-module SQL lives in `scripts/`, not `src/`)
- All Phase 2.47–2.50 harnesses green
- Full sentinel chain green

## 9. Rollback

**Configuration alone cannot revert applied data.** Production
rollback requires a pre-apply snapshot of every affected row, e.g.:

```sql
\copy (
  SELECT id, "tenantId" FROM audit_logs
  WHERE entity IN (
    'Document', 'FinancialRecord', 'WorkPermit',
    'Visa', 'ComplianceAlert', 'Notification'
  ) AND "tenantId" IS NULL
) TO 'phase251_pre_apply_snapshot.csv' CSV
```

Recommended production sequence:
1. Capture snapshot.
2. Capture full `pg_dump` of `audit_logs` for safety.
3. Run dry-run; review report.
4. Schedule maintenance window.
5. Run apply with operator approval.
6. Verify counts (`updatedRows` matches expected `candidateRows`).

## 10. Production behaviour change

**None.** No schema changes, no runtime service code changes, no
default behaviour change. Apply mode is opt-in via env flag and
classification gate.

## 11. Recommended next phase

**2.52 — Audit-log retention + tenant-scoped read API.** Now that
historic NULL-tenant rows have a derivable `tenantId` for the seven
core entities (attendance plus six this phase), the next obvious
step is a tenant-aware read service over `AuditLog` that: returns
per-tenant rows in pilot mode, exposes a soft-delete / retention
policy hook, and routes through `TenantAuditLogService` for both
emit and read.
