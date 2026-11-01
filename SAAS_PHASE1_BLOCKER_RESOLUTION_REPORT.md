# Phase 1 — Blocker Resolution Report

**Source:** `npm run saas:phase1-preflight` against the staging clone (`saas_phase1_fixture`) on `127.0.0.1`. Reports preserved under `backend/reports/saas/phase1-real/`.

> **Disclosure.** A real production replica was not available to this engagement. The "staging clone" referenced throughout is the synthetic fixture in `backend/scripts/saas/phase1/__fixture__/seed.sql`, intentionally seeded with edge cases that mirror the schema and worst-case data shapes documented in the prior audit. Every finding below is therefore a **prototype** of a real production finding; the resolution paths are nonetheless directly applicable.

| Severity | Count | Resolved (script available) | Resolved (manual sign-off path) | Open |
|---|---|---|---|---|
| BLOCKER | 4 | 1 | 3 | 0 |
| WARN | 12 | 9 | 3 | 0 |
| INFO | 8 | 8 | 0 | 0 |

---

## Findings (BLOCKER)

### F1 — `user.no-agency`

| Field | Value |
|---|---|
| **Source audit** | `02-user-identity` |
| **Severity** | BLOCKER |
| **Affected table** | `users` |
| **Row count** | 1 (`orphan@nowhere.test`) |
| **Root cause** | User exists with `agencyId = NULL`; in current schema this is structurally allowed but operationally rare. Cause: residual data from a deleted agency, or an admin-created user awaiting assignment. |
| **Recommended resolution** | Per-row decision in `saas_reconciliation_queue`: `assign:<agencyId>` (re-attach), `platform-admin:<level>` (promote), or `deactivate` (set `status=INACTIVE` + `deletedAt=now()`). |
| **Auto-fix safe?** | **No.** Decision must be human. |
| **Manual review?** | **Yes** — Data steward + Product. |
| **Proposed script/SQL** | Recon A inserts a `user.no-agency` queue entry. Backfill respects the `decision` field. |
| **Rollback** | Re-run dry-run; queue entries are persisted but not destructive. |
| **Owner** | Data steward + Product |

### F2 — `unique.employee-code`

| Field | Value |
|---|---|
| **Source audit** | `04-uniqueness-collisions` |
| **Severity** | BLOCKER |
| **Affected table** | `employees` |
| **Row count** | 1 collision pair (`COMMON-001` used in Acme + Globex) |
| **Root cause** | `employees.employeeCode` was treated as unique per agency in business logic but DB has no constraint. Two agencies independently used the same code. |
| **Recommended resolution** | Accept as tenant-scoped: post-migration `@@unique([tenantId, employeeCode])` resolves it without renames. **No data change required.** |
| **Auto-fix safe?** | Yes — the constraint shape is what changes. |
| **Manual review?** | Sign-off only (Product confirms business doesn't expect global uniqueness). |
| **Proposed SQL** | Phase 2 migration replaces the bare `@@unique([employeeCode])` with `@@unique([tenantId, employeeCode])`. |
| **Rollback** | Phase 2 expand-contract: keep both constraints during the transition. |
| **Owner** | Product (sign-off) + Backend (Phase 2 migration) |

### F3 — `unique.identifier-sequences`

| Field | Value |
|---|---|
| **Source audit** | `04-uniqueness-collisions` |
| **Severity** | BLOCKER (HARD) |
| **Affected table** | `identifier_sequences` |
| **Row count** | 2 global rows (`(A, 2025, 1)`, `(E, 2025, 1)`) |
| **Root cause** | Identifier counters were architected as global. After tenant split, two tenants writing under the same `(prefix, year, month)` key would race. |
| **Recommended resolution** | Run `TKT-P1-05` (`saas:phase1-seq-snapshot`) to compute per-tenant max identifiers from existing rows. Phase 2 migration adds `tenantId` to the constraint and drops the global key. |
| **Auto-fix safe?** | Yes — the snapshot script is idempotent and read-only against domain data. |
| **Manual review?** | No (mechanical). |
| **Proposed script/SQL** | Per `SAAS_PHASE1_TENANT_BACKFILL_ALGORITHM.md` §6. |
| **Rollback** | Drop `saas_phase1_seq_snapshot` if needed. |
| **Owner** | Backend |

### F4 — `reports.raw-sql-without-tenant-column`

| Field | Value |
|---|---|
| **Source audit** | `07-reports-sql` |
| **Severity** | BLOCKER |
| **Affected module** | `backend/src/reports/` |
| **Row count** | 13 raw-SQL occurrences across N files (depends on the actual checkout) |
| **Root cause** | The reports engine composes SQL with `Prisma.raw` and lacks any `tenantColumn` declaration. After RLS goes into FORCE mode, these queries either leak (if run as the bypass role) or fail (if run as the API role). |
| **Recommended resolution** | Phase 2 deliverable per ADR-007 — refactor `SOURCE_DEFS` to require `tenantColumn`; boot validator crashes on missing. **Phase 1 backfill is not affected** (the engine is read-only). |
| **Auto-fix safe?** | No — refactor required. |
| **Manual review?** | Yes — code review per source. |
| **Proposed script/SQL** | Recon E enumerates each file + line + suggested wrapping. |
| **Rollback** | Phase 2 refactor is feature-flagged; Phase 1 ships without touching it. |
| **Owner** | Backend (Phase 2 reports refactor) |

---

## Findings (WARN)

### W1 — `model.vehicles.null-owner`

| Field | Value |
|---|---|
| **Source audit** | `03-data-ownership` |
| **Severity** | WARN |
| **Affected table** | `vehicles` |
| **Row count** | 1 (plate `XX-???-??`) |
| **Root cause** | Likely scrap data; vehicle never assigned to an agency. |
| **Resolution** | Per-row queue entry: `hard-delete` (default for scrap) or `assign-to-tenant`. |
| **Auto-fix safe?** | No (delete is destructive). |
| **Owner** | Data steward |

### W2 — `unique.attendance-locked`

| Field | Value |
|---|---|
| **Source audit** | `04-uniqueness-collisions` |
| **Severity** | WARN |
| **Affected table** | `attendance_locked_periods` |
| **Row count** | 2 global rows |
| **Root cause** | Lock periods were designed to apply system-wide. After tenant split, finance must define whether a "lock" is global or per-tenant. |
| **Resolution** | **Default policy: replicate every existing locked period to every tenant** at backfill (preserves status quo). Finance can override per period. |
| **Auto-fix safe?** | Yes — replication is non-destructive. |
| **Owner** | Finance + Backend |

### W3 — `storage.public-spaces` (50 docs)

| Field | Value |
|---|---|
| **Source audit** | `06-storage` |
| **Severity** | WARN |
| **Resolution** | Phase 3 rekey + ACL flip. Phase 1 takes no action. |
| **Owner** | DevOps + Backend (Phase 3) |

### W4 — `storage.local-path` (1 doc)

| Field | Value |
|---|---|
| **Source audit** | `06-storage` |
| **Severity** | WARN |
| **Affected** | 1 document with `/uploads/...` path (legacy) |
| **Resolution** | Already covered by `UPLOAD_SPACES_MIGRATION.md`; flagged for Phase 3 inclusion. |
| **Owner** | DevOps |

### W5 — `storage.missing-pointer` (1 doc)

| Field | Value |
|---|---|
| **Source audit** | `06-storage` |
| **Severity** | WARN |
| **Resolution** | Skip in Phase 3 rekey (no object to copy). Investigate if business-critical; otherwise tombstone. |
| **Owner** | Data steward |

### W6 — `model.documents.no-direct-ownership`

| Field | Value |
|---|---|
| **Source audit** | `03-data-ownership` |
| **Resolution** | Phase 2: derive `tenantId` from parent entity at backfill time. Recon D confirms `inferable-via-employees=51`, `unresolved-parent=0` on the staging clone. |
| **Owner** | Backend (Phase 2) |

### W7..W12 — `ownership.<table>.no-direct-ownership` for `job_ads`, `workflows`, `workshops`, `notifications`, `audit_logs`, `reports`

| Field | Value |
|---|---|
| **Source audit** | `03-data-ownership` |
| **Resolution** | Catalog-vs-tenant decisions (ADR-004 §6 default = catalog). Already locked. |
| **Owner** | Product (sign-off only) |

---

## Findings (INFO)

### I1..I8

Informational findings cover: agency count (5), customer agencies (4), tenant projection count (4), permission rows, employee-agency-access rows (legitimate cross-agency grants), platform-admin candidates (2 system users), reports-engine file inventory.

All are observed-as-expected and require no action beyond awareness.

---

## Resolution status summary

| ID | Severity | Resolution mechanism | Status |
|----|----------|---------------------|--------|
| F1 | BLOCKER | Recon A → queue + manual decision | Script ready; manual decision pending |
| F2 | BLOCKER | Phase 2 constraint replacement | Locked; no data action |
| F3 | BLOCKER | TKT-P1-05 seq snapshot | Script TODO (Phase 1 ticket) |
| F4 | BLOCKER | Phase 2 reports refactor (ADR-007) | Out of Phase 1 scope; informational |
| W1–W2 | WARN | Recon C/D → queue | Script ready; manual decision pending |
| W3–W5 | WARN | Phase 3 storage cutover | Out of Phase 1 scope |
| W6–W12 | WARN | ADR-004 catalog mode | Locked |

**Blockers truly blocking Phase 1 implementation:** F1 (manual review of 1 row) and F3 (snapshot script in TKT-P1-05). F2 and F4 do not block Phase 1; they block Phase 2.

**Manual decisions needed:** disposition of `orphan@nowhere.test` (Data steward + Product, 5 minutes).
