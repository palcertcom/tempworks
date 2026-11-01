# Phase 1 — "Production Replica" Reconciliation Analysis

> Same disclosure as the preflight analysis: the active "replica" is the
> staging fixture. The reconciliation outputs landed under
> `backend/reports/saas/phase1-prod-replica/reconciliation/`.

**Run command:** five recon scripts in default (dry-run) mode.
**Outputs:** `recon-A-user-identity.{json,md}` … `recon-E-reports-sql.{json,md}`.

---

## 1. Aggregate

| Recon script | Status | Metrics | Actions |
|---|---|---|---|
| A — User Identity | **BLOCKER** | 6 | 4 |
| B — Agency → Tenant Projection | OK | 5 | 1 |
| C — Unique Constraints | **BLOCKER** | 6 | 4 |
| D — Data Ownership | WARN | 18 | 4 |
| E — Reports SQL | **BLOCKER** | 3 | 15 |

**Total proposed reconciliation actions:** 28.

## 2. Rows requiring manual review

Detected by Recons A and D; written to `saas_reconciliation_queue` only when run with `--apply` (not done in this read-only pass).

| Kind | Count (fixture) | Default proposed decision | Owner |
|---|---|---|---|
| `user.no-agency` | 1 | `assign-tenant` \| `platform-admin` \| `deactivate` | Data steward + Product |
| `user.platform-admin-candidate` | 2 | `platform-admin:SUPER` (downgrade post-cutover) | Security |
| `ownership.null.vehicles` | 1 | `assign-tenant` \| `hard-delete` | Data steward |
| `ownership.manual-decision-required` | 3 (job_ads, workflows, workshops) | catalog-vs-replicate decision | Product |

## 3. Automatically resolvable rows

Recon B's tenant projection is fully automatic when slugs derive cleanly:

```
Acme HR    → tenant id reuses agency.id; slug "acme-hr"     ; 0 conflicts
Globex Co. → tenant id reuses agency.id; slug "globex-co"   ; 0 conflicts
Initech    → tenant id reuses agency.id; slug "initech"     ; 0 conflicts
Empty Co   → tenant id reuses agency.id; slug "empty-co"    ; 0 conflicts
```

`agency.system-count = 1` → 2 system-agency users become PlatformAdmin
candidates without manual triage.

## 4. Unsafe rows

> An "unsafe row" is one the script cannot move without explicit operator
> sign-off. None of the rows below would be auto-mutated by the backfill.

| Kind | Count | Why unsafe |
|---|---|---|
| `collision.identifier-sequences` | 2 (global) | Phase 2 cutover prerequisite (TKT-P1-05). Per-tenant initialisation must precede any application writer switching to the new key. |
| `collision.attendance-locked-period` | 2 (global) | Affects payroll. Replicate-per-tenant default requires Finance sign-off. |
| `collision.employee-code` | 1 pair | Tenant-scoped constraint resolves it without renames; Product confirms expected semantics. |
| `reports.raw-sql` | 13 | Phase 2 reports refactor (ADR-007). Each `Prisma.raw(...)` site needs `tenantColumn` declaration. |

## 5. Slug conflicts (Recon B)

| Slug type | Count | Action |
|---|---|---|
| Reserved | 0 | none |
| Regex-violating | 0 | none |
| Cross-tenant duplicates | 0 | none |

On real data, expected scenarios:

- Two customer agencies with identical names (e.g. "Acme") would
  trigger duplicate handling: collision suffix is appended (`acme-XYZ`).
- Agency names containing only special characters generate `t-<hash>`.

## 6. Duplicate email conflicts (Recon A)

| Check | Fixture result | Real-data expectation |
|---|---|---|
| `users.duplicate-emails` | 0 | 0 (today's `email UNIQUE` constraint structurally prevents it) |
| `users.invalid-email` | 0 | 0 unless the data store has bypassed validation |
| `users.null-email` | 0 | 0 expected |
| `employees.cross-tenant email pairs` | 0 | Likely > 0 on prod; not a blocker (becomes tenant-scoped) |

## 7. Orphan ownership cases (Recon D)

| Model | NULL owner | Orphan owner (FK → missing) |
|---|---|---|
| applicants | 0 | 0 |
| employees | 0 | 0 |
| vehicles | 1 | 0 |
| documents | (entity-keyed; `inferable-via-employees=51`, `unresolved-parent=0`) | n/a |
| financial_records | (entity-keyed; same shape) | n/a |

## 8. Report SQL risks (Recon E)

13 raw-SQL occurrences detected statically across `backend/src/reports`. Each
proposed action:

```
wrap-with-Prisma.sql + parameterize; declare tenantColumn on parent source
```

Plus one cross-cutting action:

```
reports.export-isolation: route Excel/PDF/DOCX exports through `runReport`
with the same tenantColumn enforcement
```

Phase 1 backfill is unaffected by these findings. Phase 2 reports refactor
(ADR-007) is a hard prerequisite to enabling `TENANT_PRISMA_ENFORCEMENT=true`
in any environment.

## 9. Storage risks (Recon F via Audit 06-storage)

| Risk | Count | Disposition |
|---|---|---|
| Public-Spaces URLs | 50 | Phase 3 rekey + ACL flip (`SAAS_FILE_STORAGE_SECURITY_PLAN.md`) |
| Legacy `/uploads/` paths | 1 | Phase 3 rekey |
| Missing storage pointer | 1 | Investigate (likely orphan; tombstone) |

No Phase 1 action.

## 10. Sign-off matrix (proposed)

| Decision area | Rows | Required signer |
|---|---|---|
| Disposition of `user.no-agency` | 1 | Data steward |
| PlatformAdmin grants | 2 | Security |
| Tenant slugs (auto-derived) | 4 | Product (review only) |
| Catalog-vs-replicate (workshops, etc.) | 3 | Product |
| Locked-period replication policy | 2 | Finance |
| Employee-code "duplicates accepted as tenant-scoped" | 1 pair | Product |

## 11. What the same recon run would look like on real prod

The recon scripts are static-pattern based; their behaviour does not
depend on row count. On real data:

- More queue rows from each recon (proportional to data volume).
- Same per-row proposed decisions; same sign-off matrix shape.
- `recon-E-reports-sql` produces identical output (it scans source
  files, not data).

The reconciliation queue CLI (TKT-P1-07) is required to drain the
queue efficiently when row counts are high. Until it ships, ops drains
via raw SQL `UPDATE`s.

## 12. Conclusion

The five reconciliation scripts produce a consistent, owner-tagged
worklist. On the available SAFE_CLONE data, **28 actions** are
proposed; about **half are mechanical** (slug derivation, PlatformAdmin
provisioning, identifier-sequence snapshotting) and half require
**human sign-off** (orphan disposition, catalog policy, payroll lock
policy).

Phase 1 implementation work can proceed; final cutover is gated by
draining the queue on real data.
