# Phase 2.30 — Audit Log Schema Decision

> Additive, nullable `tenantId` on `AuditLog`. No backfill. No behaviour change with flags off.

---

## 1. Current state (pre-2.30)

The `AuditLog` model (`backend/prisma/schema.prisma:878`) has no `tenantId`
column. Every audit emission across the five piloted modules (finance,
documents, vehicles, workflow, applicants) writes to `audit_logs` with no
tenant attribution. Reads (`finance.getHistory`, etc.) join on
`entity + entityId` and inherit tenant scope from the parent gate of the
caller.

## 2. Decision

Add a single additive, nullable column + two indexes to `AuditLog`:

```prisma
model AuditLog {
  …existing fields…
  tenantId       String?

  @@index([tenantId])
  @@index([tenantId, createdAt])
  @@map("audit_logs")
}
```

Properties:
- **Nullable.** Pre-existing rows stay legacy (`tenantId IS NULL`).
- **No FK.** Matches the pattern used by other piloted tables (`Document.tenantId`,
  `Vehicle.tenantId`, etc.) — kept loose so cross-tenant audit-log reads stay
  cheap and so deletion of a tenant doesn't cascade into immutable history.
- **Two indexes.** `(tenantId)` for tenant-narrowed scans;
  `(tenantId, createdAt)` for time-ordered tenant-scoped reads (the natural
  pagination for an audit trail).

## 3. Backfill — explicitly NONE in Phase 2.30

This phase does **not** backfill `tenantId` for existing rows.

Reasoning:
- Audit rows are append-only history; rewriting historical attribution is a
  compliance-sensitive operation that needs an explicit dry-run plan and
  signoff (Phase 3 product question).
- The pilot does not need backfill: legacy reads continue to work because
  every audit-read is gated by a tenant-scoped parent lookup that filters
  by `entity + entityId`, and the parent already carries tenancy.
- New rows written under `TENANT_AUDIT_LOG_PILOT_ENABLED=true` will carry
  `tenantId` going forward; older rows stay `NULL` and remain readable via
  the legacy join path.

If/when backfill is attempted, it MUST:
1. Run as a SAFE_STAGING dry-run script with explicit row-count reconciliation
   per `entity` against the parent tenancy table.
2. Be reversible (keep the prior NULL state recoverable via
   `tenantId IS NULL` selector).
3. Land in its own phase doc (`SAAS_PHASE231_AUDIT_LOG_BACKFILL.md`).

## 4. Production behaviour with flags OFF

- `tenantId` defaults to `NULL` for every write when
  `TENANT_AUDIT_LOG_PILOT_ENABLED=false`.
- The new indexes are NULL-tolerant and have negligible impact on writes
  (one index is a partial lookup on a small set of NULLs initially).
- No read path is rewritten in Phase 2.30. `finance.getHistory` and
  similar readers continue to filter by `entity + entityId`.

## 5. Migration mechanics

Apply via `npx prisma db push` to the local SAFE_CLONE
(`saas_phase1_fixture`). No data migration. Rollback is `ALTER TABLE
audit_logs DROP COLUMN tenantId` + drop the two indexes — instant, no data
loss because `tenantId` is purely additive.

## 6. Risk / blast radius

| Risk | Mitigation |
|------|------------|
| Index bloat on huge audit tables | Two narrow indexes on a single nullable text column; bounded |
| Accidental cross-tenant write | Pilot helper writes `tenantId` only when ALS frame present AND `TENANT_AUDIT_LOG_PILOT_ENABLED=true` AND env is SAFE_CLONE/SAFE_STAGING |
| Read regression | None — Phase 2.30 does not change any read path |
| Backfill drift | Out of scope — explicitly deferred |

## 7. Schema diff summary

```
+ tenantId       String?
+ @@index([tenantId])
+ @@index([tenantId, createdAt])
```

Three additive lines. No removals, no type changes, no constraint changes.
