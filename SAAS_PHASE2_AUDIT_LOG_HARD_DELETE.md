# Phase 2.54 — Audit-log Hard-Delete (post-soft-delete grace)

> **Hard-delete is destructive and irreversible without a full-row
> snapshot or DB backup.** This script physically removes audit_logs
> rows that have ALREADY been soft-deleted and have aged past a
> configurable grace window.

---

## 1. Hard-delete is separate from soft-delete

Phase 2.53 introduced soft-delete (`audit_logs.deletedAt = now()`).
This phase introduces a **separate** one-shot script that physically
removes rows where:

```
deletedAt IS NOT NULL                         -- already soft-deleted
AND deletedAt < now() − GRACE_DAYS days       -- past grace window
AND <scope predicate>
```

Live rows (`deletedAt IS NULL`) and rows still inside the grace
window are NEVER eligible. The two scripts compose: an operator who
runs Phase 2.53 today sees those rows hard-delete-eligible only
after the grace window elapses.

## 2. Apply gates (ALL three required + scope)

| Variable | Default | Meaning |
|---|---|---|
| `AUDIT_LOG_HARD_DELETE_ENABLED` | `false` | Master switch. |
| `AUDIT_LOG_HARD_DELETE_APPLY` | `false` | Operator opt-in for this run. |
| (also) | runtime classification | Apply requires `SAFE_CLONE` / `SAFE_STAGING`. |
| `AUDIT_LOG_HARD_DELETE_TENANT_ID` | unset | Required when `scope=tenant`. |

Failing any gate ⇒ dry-run with `refusalReason` populated.

## 3. Scope (`AUDIT_LOG_HARD_DELETE_SCOPE`)

| Value | Effect |
|---|---|
| `tenant` (default) | Only `tenantId = AUDIT_LOG_HARD_DELETE_TENANT_ID`. Refuse if unset. |
| `null-tenant` | Only NULL-tenant legacy rows. |
| `all` | Every eligible row. Explicit operator opt-in. |

## 4. Grace period

```
cutoff = now() - AUDIT_LOG_HARD_DELETE_GRACE_DAYS days
```

Default `90`. Invalid or non-positive values fall back to `90`.

## 5. Eligibility rules

A row is **eligible** if and only if:
- `deletedAt IS NOT NULL`, AND
- `deletedAt < cutoff`, AND
- The active scope predicate is satisfied.

The dry-run report breaks the population into four buckets so
operators can see what's eligible vs excluded:

| Bucket | Definition |
|---|---|
| `eligibleRows` | rows that the apply UPDATE would physically remove |
| `excludedNotSoftDeleted` | `deletedAt IS NULL` (live rows) |
| `excludedInsideGrace` | `deletedAt IS NOT NULL AND deletedAt >= cutoff` |
| `excludedByScope` | rows that fail the scope predicate |

## 6. Snapshot SQL (mandatory before apply)

The report emits two snapshot SQL templates:

**For rollback (full row):**
```sql
SELECT * FROM audit_logs
WHERE "deletedAt" IS NOT NULL
  AND "deletedAt" < '<cutoff>'
  [AND scope predicate];
```

**Identity-only (auditing the operation, NOT for rollback):**
```sql
SELECT id, "tenantId", "createdAt", "deletedAt", entity, action
FROM audit_logs
WHERE "deletedAt" IS NOT NULL
  AND "deletedAt" < '<cutoff>'
  [AND scope predicate];
```

⚠️ **`SELECT id, ...` alone is NOT a rollback source.** Hard-delete
removes `changes`, `userEmail`, `userAgent`, `ipAddress`, etc. — the
identity-only export cannot reconstruct them.

## 7. Production safety checklist

Before any production apply:

- [ ] `pg_dump audit_logs` captured.
- [ ] Full-row snapshot CSV captured per the SQL above.
- [ ] Dry-run report reviewed; `eligibleRows` matches expectation.
- [ ] Operator approval recorded.
- [ ] Maintenance window scheduled.
- [ ] Apply executed.
- [ ] Verify `deletedRows == eligibleRows` from the dry-run.
- [ ] Verify `afterTotalRows == beforeTotalRows − deletedRows`.

## 8. Rollback

**Configuration alone cannot revert a hard-delete.** Rollback
requires either:

- Restore from `pg_dump audit_logs` (preferred for full integrity), OR
- Re-insert from a full-row snapshot CSV (only if every column was
  captured, including `changes` jsonb).

```sql
-- Re-insert from a full-row snapshot (only if captured BEFORE apply):
INSERT INTO audit_logs SELECT * FROM phase254_full_row_snapshot
ON CONFLICT (id) DO NOTHING;
```

## 9. Harness — `audit-log-hard-delete-harness` 17/17 PASS

```
[audit-log-hard-delete-harness] 17/17 PASS
```

1. dry-run deletes zero rows
2. dry-run reports correct eligible count
3. apply refused when `AUDIT_LOG_HARD_DELETE_ENABLED=false`
4. apply refused when `AUDIT_LOG_HARD_DELETE_APPLY=false`
5. apply refused outside SAFE_CLONE/SAFE_STAGING (source gate)
6. apply refuses tenant scope without tenant id
7. apply hard-deletes only already soft-deleted rows older than grace
7b. tenant A old eligible rows physically removed
8. apply does not delete rows where `deletedAt IS NULL`
9. apply does not delete soft-deleted rows inside grace window
10. tenant A hard-delete does not touch tenant B rows
11. tenant B hard-delete does not touch tenant A rows
12. null-tenant scope deletes only NULL-tenant eligible rows
13. all scope deletes all eligible rows only when explicitly requested
14. rerun apply is idempotent (zero deletes)
15. `DELETE FROM audit_logs` lives ONLY in `scripts/` plus the
    pre-existing `src/recycle-bin/database-cleanup.service.ts`
    System Admin path (tagged `phase211-excluded-platform`)
16. scanner registers `phase254-audit-log-hard-delete`

## 10. Validation results

- `nest build` clean
- `npx prisma validate` clean
- `npm run saas:validate` 6/6 suites
- `npm run saas:schema-lint` 0 issues
- `npm run saas:scan:annotations` 0 findings
- `npm run saas:scan:raw-sql` 26 findings (baseline unchanged —
  new SQL lives in `scripts/`, not `src/`)
- All Phase 2.47–2.53 attendance / backfill / read / preview /
  retention harnesses green
- Full sentinel chain green
- **Cumulative: 658/658**

## 11. Production behaviour change

**None.** With default flags the script is a no-op count helper.
Apply is opt-in via three gates AND a SAFE classification AND
(for scope=tenant) an explicit tenant id. Phase 2.54 introduces
no runtime hard-delete site.

## 12. Recommended next phase

**2.55 — Operator-facing retention runbook**: a CHECKLIST.md doc
that wires Phases 2.50 → 2.51 → 2.52 → 2.53 → 2.54 into a single
production rollout sequence with explicit go/no-go gates between
backfill, soft-delete, and hard-delete steps.

---

# Phase 2.55 cross-link — Operator runbook

A consolidated operator-facing rollout sequence is documented at
`docs/runbooks/audit-retention-rollout.md` (top-level pointer at
`AUDIT_LOG_RETENTION_RUNBOOK.md`). It stitches Phases 2.50–2.54
into a single production sequence with go/no-go gates, snapshot
guidance, and a sign-off table.
