# SPIKE 009 — Reports Module Hardening Plan

**Status:** Investigation-only. No code or schema changes in this spike.
**Scope:** Plan the 12-item Reports hardening task from §1–§12 of the
brief: expanded sources, ownership/sharing, preview-vs-save, safe
limits, business IDs, deleted-name conflict, Select/Deselect All,
per-source permission gates, tests.

---

## 1. Current behaviour (audit findings)

### 1.1 Schema
`backend/prisma/schema.prisma:973–1032`
- `Report { id, name, description, dataSource, createdById, createdAt, updatedAt, deletedAt, deletedBy, deletionReason }`.
- **`name` is `@unique` globally** (line 975) — single index across every row, every tenant, deleted or not.
- **No `tenantId` column.** Reports are effectively a global table.
- **No visibility / sharing column.** No `ReportShare` / `ReportAccess` model exists.
- Siblings `ReportFilter`, `ReportColumn`, `ReportSorting` carry only the report's filter/column/sort definitions.

### 1.2 Source registry — two registries today
- **Legacy** in `backend/src/reports/reports.service.ts:53–505`. 17 sources covering employees, applicants, documents, compliance_alerts, agencies, work_permits, document_types, visas, plus their joined views. Every source exposes `id: { type: 'uuid' }` as its identity column. No `employeeNumber`/`candidateNumber`/`userNumber` is exposed.
- **Tenant-safe parallel** in `backend/src/saas/reports/runtime/report-sources.ts:86–131`. Same source names but each carries `tenantColumn`/`agencyColumn` metadata. Marks each source READY|DISABLED.
- The two registries are **not unified**; choosing the wrong path drops the tenant safety annotations.

### 1.3 Query builder
`reports.service.ts:738–882` — `executeReport()` composes `Prisma.sql` with:
- soft-delete filter on the primary table (line 785–787)
- user filters mapped to operators (line 789–817)
- **server-side `LIMIT/OFFSET`** (line 862) — Run is already paginated; Preview is unlimited at the controller boundary
- columns drive `SELECT`; if no columns are selected the builder falls back to a full row (which means a zero-column report would still return data)

### 1.4 Controller routes
`backend/src/reports/reports.controller.ts`
- `GET /reports`           `@RequirePermission('reports:read')`
- `POST /reports`          `@RequirePermission('reports:create')`
- `GET /reports/:id`       `@RequirePermission('reports:read')`
- `PUT /reports/:id`       (no explicit permission, role-gated only)
- `DELETE /reports/:id`    `@RequirePermission('reports:delete')`
- `POST /reports/:id/run`  `@RequirePermission('reports:create')` (oddly tied to create — likely a copy-paste; should be `reports:read`)
- `POST /reports/:id/export` `@RequirePermission('reports:create')`
- **No `/reports/preview` endpoint.**
- **No per-source permission gating** — once a user has `reports:read`, every source is available to them, including finance and attendance.

### 1.5 Preview vs save (the bug you reported)
`src/app/pages/reports/ReportsDashboard.tsx:212–225` — `handlePreview()` first calls `create()` or `update()` to persist the report, then `reportsApi.run()` to fetch rows. That is why pressing Preview/Review materialises the report into the saved list.

### 1.6 Delete + name uniqueness (the second bug)
`reports.service.ts:556–560` — the service-side check on create/update does `findFirst({ where: { name, deletedAt: null } })`, so a deleted report **should** allow a new one with the same name … except the underlying `@unique` index on `Report.name` (line 975 of the schema) does **not** ignore `deletedAt`. The DB raises a P2002 unique-constraint error before the service ever runs the soft-delete check. That is the "test → delete → create test → already exists" symptom.

### 1.7 Frontend
- Single file `src/app/pages/reports/ReportsDashboard.tsx` (~665 lines) combining the builder, the saved-reports list, and the KPI dashboard tab.
- Column selector has **no Select All / Deselect All**.
- Preview path: see 1.5.
- No sharing UI at all — there's no "Private / Shared / Public" toggle.

### 1.8 Permissions
- Module gate only: `reports:read` / `reports:create` / `reports:delete`.
- No per-source gates: a Recruiter with `reports:create` can build a Finance source report even without `finance:read`.

### 1.9 Output columns
Every source's identity is the primary table's `id` UUID. None advertise the business numbers (`employeeNumber`, `candidateNumber`, `leadNumber`, `userNumber`, `docId`) that the rest of the app uses everywhere else.

### 1.10 Answer to "can Karim see my reports?"
**Yes, today.** With no `tenantId` on the Report row and no sharing model, every user with `reports:read` sees every saved report in the database, regardless of who created it or which tenant they're in. The fix is in Phase B below.

---

## 2. Phased implementation plan

Sized for small focused PRs. Each phase is independently shippable.

### Phase A — Pure code, no schema (small, safe)
- **A1. Preview-does-not-save** *(addresses §3)*
  New endpoint `POST /reports/preview` that accepts an inline `{ dataSource, columns, filters, sort }` body and returns up to 50 rows. Frontend `handlePreview()` switches to it; Save remains a separate explicit action.
- **A2. Safe Run limits** *(§4)*
  Cap Run page size at 1000 server-side (currently honors whatever the client sends). Reject 0. UI shows "Preview shows first 50 rows. Use filters or Export for larger results."
- **A3. Select All / Deselect All on column picker** *(§7)*
  Frontend-only. Selected-count chip. Reject zero-column reports on the backend (`assertColumnsNotEmpty`).
- **A4. Per-source permission gates** *(§8)*
  Map each source to its module permission (finance → `finance:read`, attendance → `attendance:read`, …). Enforced in the source-resolution path; frontend filters the source dropdown to entitled sources only.
- **A5. Fix `/reports/:id/run` permission** *(§4)*
  `@RequirePermission('reports:create')` → `'reports:read'`. Clear documentation gap, not a security gap (every role with create also has read), but worth tightening.

**Phase A schema impact: none.** Ready to ship without approval.

### Phase B — Additive schema (medium risk, REQUIRES YOUR APPROVAL)
- **B1. Report tenant ownership** *(§2, §6)*
  Add `Report.tenantId: String?` column (additive). Backfill from the creator's tenant via a gated audit script (`scripts/saas/report-tenant-audit.ts`, same `_REMEDIATE`/`_APPLY`/`_FORCE` pattern). Service spreads `tenantWhere` on every read. Do **not** promote `NOT NULL` in this phase.

- **B2. Name uniqueness fix** *(§6)*
  Drop the global `Report.name @unique` index. Add `@@unique([tenantId, createdById, name])` plus a **partial index** so deleted rows don't collide:
  ```sql
  CREATE UNIQUE INDEX reports_name_unique
    ON reports("tenantId", "createdById", name)
    WHERE "deletedAt" IS NULL;
  ```
  Prisma doesn't model partial indexes natively, so the index is created via `prisma migrate` raw SQL or the `healAdditiveDrift` boot path. **This is the one destructive step in the plan** — dropping an existing unique constraint.

- **B3. Sharing model** *(§2)*
  ```
  enum ReportVisibility { PRIVATE  SHARED  PUBLIC_IN_TENANT }
  Report.visibility ReportVisibility @default(PRIVATE)

  model ReportShare {
    reportId    String
    userId      String
    permission  ReportSharePermission @default(VIEW)
    grantedById String
    grantedAt   DateTime @default(now())
    @@id([reportId, userId])
  }
  enum ReportSharePermission { VIEW  RUN  EDIT  SHARE }
  ```
  Additive only. New rows default to PRIVATE. Access check: owner OR explicit share OR (visibility = PUBLIC_IN_TENANT AND same tenant).

### Phase C — Code-only follow-up to B (small)
- **C1. Sharing UI**: chips for visibility, modal to grant/revoke users, "Created by … · Visibility" columns in the saved list.
- **C2. Tenant column** for SUPER USER on the saved list (gated by `SuperUserTenantField` pattern).

### Phase D — Output identity (small, no schema)
- **D1. Business-ID columns in source defs** *(§5)*
  Each source advertises both the UUID `id` (kept for joins, not selected by default) and the business number as a default-selected column. Pattern:
  ```ts
  employees: {
    defaultColumns: ['employeeNumber', 'firstName', 'lastName', 'status'],
    columns: {
      id:             { dbCol: 'id',             type: 'uuid',   label: 'UUID', hideByDefault: true },
      employeeNumber: { dbCol: 'employeeNumber', type: 'string', label: 'Employee #' },
      …
    }
  }
  ```
- **D2. Export uses business IDs** — the export job composes the same columns.

### Phase E — Expanded sources (small per source, no schema)
*(§1)* — add to the registry one by one, gated by their parent permission:
  Users, Vehicles, Workshops, Maintenance, Attendance, Finance, Job Ads, Workflows + Assignments. Each addition is a 30-50 line PR with a static check.

### Phase F — Tests *(§11)*
- Static checks alongside each phase.
- Runtime end-to-end tests are out of scope of this codebase (no Jest harness for reports). Spec is captured per phase below.

---

## 3. Schema migrations summary

| Migration | Phase | Type | Risk | Needs approval? |
|-----------|:-----:|------|:----:|:---------------:|
| `Report.tenantId` (nullable) | B1 | Additive | Low | **Yes** |
| Drop `Report.name @unique` + add partial index `(tenantId, createdById, name) WHERE deletedAt IS NULL` | B2 | **Destructive on the existing index** | Medium | **Yes — explicit** |
| `Report.visibility` enum default PRIVATE | B3 | Additive | Low | **Yes** |
| New `ReportShare` table | B3 | Additive | Low | **Yes** |
| Backfill `Report.tenantId` from creator | B1 | Data, gated audit script | Low | **Yes** |

No data is destroyed in any of these. The only destructive step is the index drop in B2, and the new partial index restores stricter, tenant-aware uniqueness immediately after — net safety increases.

---

## 4. Open questions / approvals needed

Before I ship anything beyond Phase A:

**Q1 — Schema migrations (B1/B2/B3).** The plan above adds two columns, one enum, one table, and rewrites one unique index. Do you want me to:
- (a) ship them as one migration in a single PR,
- (b) split B1+B2 (tenant + name fix) from B3 (sharing model) into two PRs, or
- (c) hold all of Phase B for a separate approval after Phase A lands?

**Q2 — Name uniqueness scope.** The proposed key is `(tenantId, createdById, name) WHERE deletedAt IS NULL`. Alternatives:
- per-tenant only: `(tenantId, name)` — two users in the same tenant can't reuse the same name
- per-user globally: `(createdById, name)` — but then cross-tenant SUPER admins overlap
- the proposed `(tenantId, createdById, name)` lets each user in each tenant own their own namespace and reuse names after delete.
Which scope do you want?

**Q3 — Visibility scope.** PUBLIC_IN_TENANT means "any user in the same tenant with `reports:read` can see and run it." Is that the right level, or do you want a more granular concept (e.g. role-bound)?

**Q4 — Sharing permission set.** I proposed `VIEW | RUN | EDIT | SHARE`. EDIT lets a sharee modify the definition; SHARE lets them grant onwards. Do you want all four, or only `VIEW | RUN`?

**Q5 — Source-permission mapping**, my proposal:
```
employees / employees_*  → employees:read
applicants / applicants_*→ applicants:read
documents / documents_*  → documents:read
agencies                 → agencies:read
work_permits / visas     → documents:read (they're a document subtype)
finance                  → finance:read    (Phase E)
attendance               → attendance:read (Phase E)
vehicles / workshops / maintenance → vehicles:read (Phase E)
users                    → users:read      (Phase E)
job_ads                  → job-ads:read    (Phase E)
workflows                → workflow:read   (Phase E)
```
OK to adopt this mapping?

**Q6 — Phase ordering / starting point.** The user-stated order in the brief is "preview-not-save first, then deleted-name fix, then Select-All, then ownership/sharing, then expand sources, then business IDs." That maps to A1 → B2 → A3 → B1+B3 → E → D. Confirm or override?

---

## 5. Recommendation

**Ship Phase A as the immediate next PR — it answers four of the twelve items (preview-not-save, safe Run limits, Select/Deselect All, per-source gates) with no schema risk and is sufficient to unblock the most painful UX bugs.** Phase B requires your migration approval (Q1, Q2). Phase D is small and can ride either before or after B. Phase E is naturally a series of small PRs.

I have **not** changed any code in this spike. Awaiting your answers to Q1–Q6 (especially Q1 + Q2) before proceeding past Phase A.
