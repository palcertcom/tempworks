# Phase 2.53 — Audit-log Retention Enforcement (Soft-delete)

> Default-OFF, dry-run-first, soft-delete only. Apply requires
> THREE gates. Hard-delete is not implemented in this phase.

---

## 1. Strategy: soft-delete only

The enforcement script sets `audit_logs.deletedAt = now()` on rows
that match the retention selection. **No row is ever physically
removed.** Hard-delete (`prisma.auditLog.delete*`, `$executeRaw`,
SQL `DELETE FROM audit_logs`) is forbidden by source-level harness
assertion (case 14). Soft-delete is reversible by snapshot.

## 2. Apply gates (ALL three required)

| Variable | Default | Meaning |
|---|---|---|
| `AUDIT_LOG_RETENTION_ENABLED` | `false` | Master switch. |
| `AUDIT_LOG_RETENTION_APPLY` | `false` | Operator opt-in for this run. |
| (also) | runtime classification | Apply additionally requires `SAFE_CLONE` or `SAFE_STAGING`. UNSAFE_PRODUCTION / UNKNOWN ⇒ dry-run with `refusalReason`. |

If any gate is missing, the script silently falls back to dry-run
and records the `refusalReason` in the report.

## 3. Tenant scope options

| `AUDIT_LOG_RETENTION_SCOPE` | Behaviour |
|---|---|
| `tenant` (default) | Soft-delete only rows where `tenantId = AUDIT_LOG_RETENTION_TENANT_ID`. Apply refuses if `AUDIT_LOG_RETENTION_TENANT_ID` is unset. |
| `null-tenant` | Soft-delete only NULL-tenant legacy rows. |
| `all` | Soft-delete every eligible row regardless of `tenantId`. Use only with explicit operator approval. |

Default `tenant` is the safest choice; the script refuses to start
an apply against an entire database without an explicit operator
opt-in via `AUDIT_LOG_RETENTION_SCOPE=all`.

## 4. Cutoff calculation

```
cutoff = now() − AUDIT_LOG_RETENTION_DAYS days
```

`AUDIT_LOG_RETENTION_DAYS` defaults to **365**. Invalid or
non-positive values fall back to 365 (case 9 of the
retention-preview harness asserts the same fallback for the
preview helper).

## 5. Selection

Eligible row predicate (composed via parameterised SQL):

```sql
"deletedAt" IS NULL
  AND "createdAt" < <cutoff>
  AND <scope predicate>
```

Where `<scope predicate>` is one of:

| Scope | SQL |
|---|---|
| `tenant` | `"tenantId" = $tenantId` |
| `null-tenant` | `"tenantId" IS NULL` |
| `all` | `TRUE` |

## 6. Snapshot guidance (recommended pre-apply step)

The report emits a copy-pasteable SQL snippet:

```sql
SELECT id, "tenantId", "createdAt", "deletedAt"
FROM audit_logs
WHERE "createdAt" < '<cutoff-iso>'
  AND "deletedAt" IS NULL
  [AND "tenantId" = '<tenant>' | AND "tenantId" IS NULL]
```

Production rollout sequence:

1. Run dry-run; review counts.
2. `\copy (...) TO 'phase253_pre_apply_snapshot.csv' CSV` using the
   recommended SQL above.
3. Capture a `pg_dump` of `audit_logs` for safety.
4. Schedule maintenance window.
5. Operator-approved apply.
6. Verify `updatedRows == candidateRows`.
7. Optional: archive the soft-deleted rows to cold storage and
   plan a future hard-delete pass under a separate phase.

## 7. Idempotency

- Dry-run never writes.
- Apply UPDATE is idempotent: the WHERE clause filters
  `"deletedAt" IS NULL`. A second run finds zero candidates and
  writes zero rows (case 13 of the harness).

## 8. Production safety notes

- **No schema migration.** Phase 2.53 is data-only.
- **No runtime change.** Service code is unchanged. Audit emission
  continues to flow through `TenantAuditLogService.write`.
- **No hard-delete.** Source-level assertion enforces this.
- **Triple-gated apply.** ENABLED + APPLY + SAFE classification.
- **Tenant default.** Scope=`tenant` requires an explicit tenant id.

## 9. Harness — `audit-log-retention-enforce-harness` 17/17 PASS

```
[audit-log-retention-enforce-harness] 17/17 PASS
```

1. dry-run updates zero rows
2. dry-run reports correct candidate count for tenant A
3. apply refused when `AUDIT_LOG_RETENTION_ENABLED=false`
4. apply refused when `AUDIT_LOG_RETENTION_APPLY=false`
5. apply refused outside SAFE_CLONE/SAFE_STAGING (source gate)
6. apply soft-deletes only rows older than cutoff
6b. tenant A old rows now soft-deleted
7. apply does not touch newer rows
8. apply does not touch already soft-deleted rows
9. tenant A retention does not touch tenant B rows
10. tenant B retention does not touch tenant A rows
11. null-tenant scope affects only NULL-tenant rows when explicitly requested
12. all scope soft-deletes every eligible old row
13. rerun apply is idempotent (zero updates after all-scope)
14. no hard-delete calls exist in source
15. enforce module exports `runRetentionEnforce` + uses gates
16. scanner registers `phase253-audit-log-retention-enforce`

## 10. Validation results

- `nest build` clean
- `npx prisma validate` clean
- `npm run saas:validate` 6/6 suites
- `npm run saas:schema-lint` 0 issues
- `npm run saas:scan:annotations` 0 findings
- `npm run saas:scan:raw-sql` 26 findings (baseline unchanged)
- All Phase 2.47–2.52 attendance / backfill / read / preview
  harnesses green
- Full sentinel chain green
- **Cumulative: 641/641**

## 11. Production behaviour change

**None.** With default flags, the script is a no-op count helper
and the database is not modified. Apply mode is opt-in via three
gates AND a SAFE classification.

## 12. Rollback

Soft-delete is reversible if a pre-apply snapshot exists.
Configuration alone cannot revert applied data.

```sh
# 1. Capture snapshot BEFORE applying:
psql ... -c "\copy (
  SELECT id, \"deletedAt\" FROM audit_logs
  WHERE \"createdAt\" < '<cutoff>' AND \"deletedAt\" IS NULL
  [AND tenant predicate]
) TO 'phase253_pre_apply_snapshot.csv' CSV"

# 2. After apply, to roll back:
UPDATE audit_logs SET "deletedAt" = NULL
WHERE id IN (SELECT id FROM phase253_pre_apply_snapshot);
```

For production: never apply without (a) a snapshot and (b) a
`pg_dump audit_logs` and (c) operator approval.

## 13. Recommended next phase

**2.54 — Hard-delete pass for already soft-deleted rows.** A
separate, narrower script that physically deletes only rows where
`deletedAt < now() − HARD_DELETE_GRACE_DAYS`, gated by additional
flags, with a snapshot capture step and explicit operator
approval. Out of scope for Phase 2.53.

---

# Phase 2.54 cross-link — Hard-delete grace pass

Hard-delete (Phase 2.54) consumes Phase 2.53's output: only rows
where `deletedAt IS NOT NULL AND deletedAt < now() − grace_days`
are eligible. The two scripts are intentionally separate; an
operator who runs Phase 2.53 today sees rows hard-delete-eligible
only after the grace window elapses. See
`SAAS_PHASE2_AUDIT_LOG_HARD_DELETE.md`.

---

# Phase 2.55 cross-link — Operator runbook

See `docs/runbooks/audit-retention-rollout.md` for the consolidated
production rollout sequence (backfill → read validation →
soft-delete → grace-window wait → hard-delete) with go/no-go
gates and operator sign-off table.
