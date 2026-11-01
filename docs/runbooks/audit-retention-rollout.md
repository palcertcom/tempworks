# Audit-log Retention Rollout — Operator Runbook

> **Read this entire document before executing any apply step.**
> The Phase 2.50–2.54 toolchain is dry-run-first by default and
> nothing is destructive without explicit env flags PLUS a SAFE
> runtime classification. Every apply step in this runbook
> requires a captured snapshot and operator approval.

---

## A. Purpose and scope

This runbook stitches Phases 2.50 through 2.54 into a single
production rollout sequence:

1. **Phase 2.50** — historic Attendance audit-log tenant backfill.
2. **Phase 2.51** — cross-module audit-log tenant backfill
   (`Document`, `FinancialRecord`, `WorkPermit`, `Visa`,
   `ComplianceAlert`, `Notification`).
3. **Phase 2.52** — tenant-scoped audit read API + retention preview
   (read-only; never modifies data).
4. **Phase 2.53** — audit retention soft-delete enforcement
   (`deletedAt = now()`).
5. **Grace-period wait** (`AUDIT_LOG_HARD_DELETE_GRACE_DAYS`).
6. **Phase 2.54** — hard-delete of rows already soft-deleted past
   the grace window.

Steps 1–4 can be run in any order with no data loss; step 6 is
irreversible without a full-row snapshot or `pg_dump` restore.

## B. Required operator roles

Sign-off is required from each role at the gates documented in
section H.

| Role | Responsibility |
|---|---|
| Backend lead | Approves code freeze, harness pass criteria, dry-run review. |
| Database administrator | Captures `pg_dump` and full-row snapshots, owns rollback. |
| Product / Compliance owner | Confirms retention window, regulatory posture. |
| Operations lead | Maintenance window scheduling, monitoring, on-call escalation. |

## C. Environment safety checks

```sh
# Confirm DATABASE_URL host/db without printing credentials:
psql "$DATABASE_URL" -c "SELECT current_database(), inet_server_addr();"

# Verify SAFE classification (the scripts refuse apply otherwise):
node -e 'console.log(require("./backend/dist/saas/tenancy/env-safety").classifyRuntimeEnv())'
```

Refuse to proceed unless:

- DATABASE_URL points to the intended environment (production,
  staging, or fixture).
- `classifyRuntimeEnv()` returns `SAFE_CLONE` or `SAFE_STAGING` for
  any apply step.
- Feature flags are explicitly set in the environment (no implicit
  defaults).
- `pg_dump audit_logs` exists (for any apply step beyond preview).

**Production rule:** never run apply steps without a recent
`pg_dump audit_logs` and operator approval recorded in section L.

## D. Backfill sequence

### D.1 Phase 2.50 — Attendance audit backfill

```sh
# Dry-run (default; never writes):
npm run saas:phase250-attendance-audit-backfill

# Apply (requires staging classification):
ATTENDANCE_AUDIT_BACKFILL_APPLY=true \
  npm run saas:phase250-attendance-audit-backfill
```

Reports written to:

- `backend/reports/saas/phase2/attendance-audit-backfill.json`
- `backend/reports/saas/phase2/attendance-audit-backfill.md`

Verification:

```sh
psql "$DATABASE_URL" -c \
  "SELECT COUNT(*) FROM audit_logs WHERE entity = 'AttendanceRecord' AND \"tenantId\" IS NULL;"
```

⚠ Rollback requires the pre-apply snapshot of affected
`audit_logs.id`. See section K.

### D.2 Phase 2.51 — Cross-module audit backfill

```sh
# Dry-run:
npm run saas:phase251-cross-module-audit-backfill

# Apply:
CROSS_MODULE_AUDIT_BACKFILL_APPLY=true \
  npm run saas:phase251-cross-module-audit-backfill
```

Reports: `backend/reports/saas/phase2/cross-module-audit-backfill.{json,md}`.

Per-entity breakdown is in the report's `byEntity` block.

## E. Audit read validation

These commands never modify data. Run them after each backfill
step and before retention.

```sh
npm run saas:phase252-audit-log-read-equivalence
npm run saas:phase252-audit-log-read-isolation
npm run saas:phase252-audit-log-retention-preview
```

All three must exit 0 (PASS). Reports:

- `backend/reports/saas/phase2/audit-log-read-equivalence.{json,md}`
- `backend/reports/saas/phase2/audit-log-read-isolation.{json,md}`
- `backend/reports/saas/phase2/audit-log-retention-preview.{json,md}`

## F. Soft-delete retention sequence (Phase 2.53)

### F.1 Tenant scope (default; safest)

```sh
# Dry-run:
AUDIT_LOG_RETENTION_TENANT_ID=<tenant-id> \
  npm run saas:phase253-audit-log-retention-enforce

# Capture snapshot BEFORE applying:
psql "$DATABASE_URL" -c "\copy (
  SELECT id, \"deletedAt\" FROM audit_logs
  WHERE \"createdAt\" < '<cutoff-iso>' AND \"deletedAt\" IS NULL
    AND \"tenantId\" = '<tenant-id>'
) TO 'phase253_pre_apply_snapshot.csv' CSV"

# Apply:
AUDIT_LOG_RETENTION_ENABLED=true \
AUDIT_LOG_RETENTION_APPLY=true \
AUDIT_LOG_RETENTION_TENANT_ID=<tenant-id> \
  npm run saas:phase253-audit-log-retention-enforce
```

### F.2 Null-tenant scope (legacy global rows)

```sh
AUDIT_LOG_RETENTION_ENABLED=true \
AUDIT_LOG_RETENTION_APPLY=true \
AUDIT_LOG_RETENTION_SCOPE=null-tenant \
  npm run saas:phase253-audit-log-retention-enforce
```

### F.3 All scope (explicit operator opt-in)

```sh
AUDIT_LOG_RETENTION_ENABLED=true \
AUDIT_LOG_RETENTION_APPLY=true \
AUDIT_LOG_RETENTION_SCOPE=all \
  npm run saas:phase253-audit-log-retention-enforce
```

### F.4 Verification

```sh
# Verify candidate count went to zero:
AUDIT_LOG_RETENTION_TENANT_ID=<tenant-id> \
  npm run saas:phase253-audit-log-retention-enforce
# Expect candidateRows == 0 in the dry-run report.
```

### F.5 Rollback after soft-delete (data-level)

```sql
-- Restore deletedAt = NULL for affected ids using the snapshot:
UPDATE audit_logs SET "deletedAt" = NULL
WHERE id IN (SELECT id FROM phase253_pre_apply_snapshot);
```

## G. Hard-delete sequence (Phase 2.54)

**Wait at least `AUDIT_LOG_HARD_DELETE_GRACE_DAYS` (default 90)
between F.x apply and G.x apply.** The grace window is the only
safety net between soft-delete and hard-delete.

### G.1 Eligibility (only)

A row is eligible for hard-delete only when:

- `audit_logs.deletedAt IS NOT NULL`
- `audit_logs.deletedAt < now() − AUDIT_LOG_HARD_DELETE_GRACE_DAYS`
- the active scope predicate matches

### G.2 Mandatory full-row snapshot (NOT id-only)

```sh
# Capture FULL ROWS — id-only snapshots cannot reconstruct
# changes, userEmail, userAgent, ipAddress, entity, action, etc.
psql "$DATABASE_URL" -c "\copy (
  SELECT * FROM audit_logs
  WHERE \"deletedAt\" IS NOT NULL
    AND \"deletedAt\" < '<hard-delete-cutoff-iso>'
    [AND scope predicate]
) TO 'phase254_pre_apply_full_rows.csv' CSV"

# Also capture pg_dump audit_logs as the canonical rollback source:
pg_dump --table=public.audit_logs --data-only --column-inserts \
  "$DATABASE_URL" > phase254_audit_logs_pg_dump.sql
```

### G.3 Dry-run

```sh
AUDIT_LOG_HARD_DELETE_TENANT_ID=<tenant-id> \
  npm run saas:phase254-audit-log-hard-delete
```

Review `eligibleRows`, `excludedNotSoftDeleted`,
`excludedInsideGrace`, `excludedByScope` in the report.

### G.4 Apply

```sh
AUDIT_LOG_HARD_DELETE_ENABLED=true \
AUDIT_LOG_HARD_DELETE_APPLY=true \
AUDIT_LOG_HARD_DELETE_TENANT_ID=<tenant-id> \
  npm run saas:phase254-audit-log-hard-delete
```

### G.5 Verification

```sh
# Idempotency — rerunning apply should report deletedRows=0:
AUDIT_LOG_HARD_DELETE_ENABLED=true \
AUDIT_LOG_HARD_DELETE_APPLY=true \
AUDIT_LOG_HARD_DELETE_TENANT_ID=<tenant-id> \
  npm run saas:phase254-audit-log-hard-delete
```

### G.6 Rollback after hard-delete (full-row only)

```sql
-- Re-insert from the FULL-ROW snapshot:
INSERT INTO audit_logs SELECT * FROM phase254_full_row_snapshot
ON CONFLICT (id) DO NOTHING;

-- OR restore from pg_dump:
psql "$DATABASE_URL" < phase254_audit_logs_pg_dump.sql
```

⚠ **An identity-only snapshot cannot reconstruct deleted rows**
because hard-delete removes `changes` jsonb plus all metadata
columns.

## H. Go / no-go gates

Tick every box at each transition. Do not proceed with any unchecked
gate.

### Gate 1 — Before any backfill apply

- [ ] All Phase 2.47–2.54 harnesses green on staging fixture.
- [ ] `npm run saas:scan:annotations` reports 0 findings.
- [ ] `npm run saas:scan:raw-sql` baseline (26 findings) unchanged.
- [ ] Dry-run report reviewed; counts match expectation.
- [ ] Snapshot of NULL-tenant audit rows captured.
- [ ] `pg_dump audit_logs` captured.
- [ ] Backend lead, DBA, and Product owner sign-off in section L.
- [ ] Maintenance window confirmed.
- [ ] Rollback owner assigned.

### Gate 2 — Before soft-delete apply (Phase 2.53)

- [ ] Backfill apply (Phases 2.50/2.51) verified.
- [ ] Audit read equivalence + isolation harnesses green.
- [ ] Retention preview report reviewed.
- [ ] Pre-apply id snapshot captured.
- [ ] Tenant scope explicitly chosen (`tenant`, `null-tenant`, or `all`).
- [ ] Operator approval recorded.

### Gate 3 — Before hard-delete apply (Phase 2.54)

- [ ] At least `AUDIT_LOG_HARD_DELETE_GRACE_DAYS` elapsed since the
      most recent soft-delete apply.
- [ ] Pre-apply **full-row** snapshot captured.
- [ ] `pg_dump audit_logs` captured.
- [ ] DBA confirms restore path is tested.
- [ ] Operator approval recorded.

## I. Monitoring and verification

Each apply step writes a JSON + Markdown report under
`backend/reports/saas/phase2/`. Operators should attach the JSON to
the change ticket. Key fields:

| Field | Phase | Meaning |
|---|---|---|
| `mode` | all | `dry-run` or `apply`. |
| `applied` | all | `true` only when apply succeeded. |
| `safeClassification` | all | runtime classification at script start. |
| `refusalReason` | all | populated if any gate is missing. |
| `candidateRows` | 2.50 / 2.51 | rows that would be updated. |
| `updatedRows` | 2.50 / 2.51 / 2.53 | rows actually updated (apply only). |
| `deletedRows` | 2.54 | rows physically deleted (apply only). |
| `scope` | 2.53 / 2.54 | `tenant` / `null-tenant` / `all`. |
| `tenantId` | 2.53 / 2.54 | active tenant for `scope=tenant`. |
| `cutoffIso` | 2.53 / 2.54 | ISO timestamp of the cutoff. |
| `beforeAliveRows` / `afterAliveRows` | 2.53 | rows alive in scope before/after. |
| `beforeTotalRows` / `afterTotalRows` | 2.54 | total rows in scope before/after. |

Watch the application logs for `Phase 0 feature flags:` lines
emitted at startup to confirm the env flags are in effect.

## J. Timing guidance

| Event | Recommended interval |
|---|---|
| Backfill apply (2.50, 2.51) | Same maintenance window or back-to-back. |
| Audit read validation | Immediately after each backfill. |
| Soft-delete apply (2.53) | After backfill verified; pick tenant scope first. |
| Grace-period wait | At least `AUDIT_LOG_HARD_DELETE_GRACE_DAYS` (default 90) days. |
| Hard-delete apply (2.54) | Only after grace window elapses AND fresh pg_dump. |
| Verification | After every apply; rerun dry-run to confirm idempotency. |

## K. Rollback policy

| Scenario | Reversible by | Notes |
|---|---|---|
| Backfill apply (2.50, 2.51) | id snapshot ⇒ `UPDATE audit_logs SET tenantId = NULL WHERE id IN (...)`. | Configuration alone does not revert. |
| Soft-delete apply (2.53) | id snapshot ⇒ `UPDATE audit_logs SET deletedAt = NULL WHERE id IN (...)`. | Soft-delete is a single column update, so id snapshot suffices. |
| Hard-delete apply (2.54) | **Full-row snapshot** OR `pg_dump` restore. | id-only snapshots are insufficient. |
| Configuration rollback (any phase) | Disable the relevant `*_APPLY` / `*_ENABLED` flag. | Stops future runs only — does not revert applied data. |

## L. Sign-off table

| Step | Owner | Timestamp (UTC) | Result | Notes |
|---|---|---|---|---|
| Pre-rollout review | Backend lead |  |  |  |
| Pre-apply pg_dump | DBA |  |  |  |
| Phase 2.50 apply | Backend lead |  |  |  |
| Phase 2.51 apply | Backend lead |  |  |  |
| Audit read validation | Backend lead |  |  |  |
| Phase 2.53 apply (tenant scope) | Backend lead + DBA |  |  |  |
| Grace-window start | Operations lead |  |  |  |
| Phase 2.54 apply (post-grace) | DBA + Product owner |  |  |  |
| Post-apply verification | Operations lead |  |  |  |
| Sign-off | Product / Compliance owner |  |  |  |
