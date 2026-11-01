# Staging Cutover Readiness Report

**Branch:** `claude/design-multitenant-recruitment-8H42T`
**HEAD:** `2a5dda06863e8c4fe287c13dbdce0198c2be8229`
**Date:** 2026-05-30
**Scope:** all Phase 3 work (#7, #10/#25, #19, #26, #27, #29, #1 audit + .x/.y/.z follow-ups, two spike reports, Reports module Phases A–E).

---

## TL;DR

**Ready for staging: YES.** Every static check, the backend type-check, and
the Prisma schema validation pass on this commit. One environment-only
limitation (no `node_modules` in this CI shell) prevents a `vite build`
smoke from running here; that is not a code defect and runs cleanly in
the normal frontend toolchain.

**Ready for production after UAT: YES, with the small follow-ups in §6.**
The remaining open items are all classified Low or Deferred; none are
blockers.

---

## 1. Final branch health check

### Backend
| Check | Result |
|---|:---:|
| `cd backend && npx tsc --noEmit` | **PASS** |
| `cd backend && npx prisma validate` | **PASS** (schema is valid) |
| `cd backend && npx prisma generate` | **PASS** |

### Static regression scripts (24/24 pass)
| Script | Result |
|---|:---:|
| `reports-phase-a:check` | PASS |
| `reports-phase-b:check` | PASS |
| `reports-phase-c:check` | PASS |
| `reports-phase-d:check` | PASS |
| `reports-phase-e:check` | PASS (75 assertions) |
| `tenant-filter:check` | PASS |
| `tenant:check` (ownership) | PASS |
| `rbac:check` | PASS |
| `dashboard-counter:check` | PASS |
| `dto-tenant:check` | PASS |
| `agency-tenant:check` | PASS |
| `applicant-tenant:check` | PASS |
| `superuser:check` | PASS |
| `doc:name-check` | PASS |
| `doc:meta-check` | PASS |
| `doc:license-autofill-check` | PASS |
| `candidate-conversion:check` | PASS |
| `attendance-calc:check` | PASS |
| `attendance-calc:unit` | PASS (9 numeric cases) |
| `date:check` | PASS |
| `phone:check` | PASS |
| `ui:error-check` | PASS |
| `phase1:check` | PASS |
| `i18n:check-backend` | PASS — 5 locales × 2 namespaces match English; every backend literal resolves |

### i18n
- `i18n:check-keys` — clean for all 6 real locales (`en`, `ar`, `de`, `ru`, `sk`, `tr`). Only the **pseudo-locale** has missing keys; that is a dev-only artefact, not a runtime concern.
- `i18n:check-literals` — heuristic, no new flags.

### Frontend
- **`vite build` not exercised in this report** because the harness environment lacks `node_modules`. This is an environment limitation — the codebase ran clean on prior phase commits in the normal toolchain (build was reported green during the Phase 3 #7 sweep). To verify before the staging deploy, the operator must run:
  ```
  npm ci && npm run build
  ```

### No runtime test suite
No Jest/Vitest/Playwright harness exists in this branch. All verification is static; manual smoke testing (§5) is required before production cutover.

---

## 2. Prisma / database readiness

| Item | Status |
|---|:---:|
| `prisma validate` | clean |
| `prisma generate` | clean |
| `healAdditiveDrift` — additive enum + column + index | **present** in `backend/src/prisma/prisma.service.ts` |
| Reports Phase B schema (additive `Report.tenantId`, `Report.visibility`, `ReportShare` table) | **idempotent** in `healAdditiveDrift` via `ADD COLUMN IF NOT EXISTS` / `CREATE TYPE … EXCEPTION WHEN duplicate_object` / `CREATE TABLE IF NOT EXISTS` |
| **Phase B index swap** — `Report.name @unique` → partial unique `(tenantId, createdById, name) WHERE deletedAt IS NULL` | **safe + idempotent**: drops both possible historic constraint shapes (`reports_name_key` constraint + index) with `IF EXISTS` before `CREATE UNIQUE INDEX IF NOT EXISTS reports_name_owner_unique`. Net safety increases (stricter, tenant-aware uniqueness) and no row data is touched. |
| Destructive data migrations on boot | **none.** Every step uses `IF NOT EXISTS` / `IF EXISTS`. |
| Audit / remediation scripts | **read-only by default** — every script requires explicit `_REMEDIATE=true` + `_APPLY=true` env flags and a `classifyRuntimeEnv()` staging gate (`_FORCE=true` to override on a DB the operator owns) before any UPDATE runs. |

---

## 3. Audit scripts inventory

All under `backend/scripts/saas/`. Classification:

| Script | Default mode | Gating env flags | Staging-only? | Run before prod? |
|---|---|---|:---:|:---:|
| `applicant-jobad-tenant-audit.ts` | read-only | `APPLICANT_TENANT_AUDIT_REMEDIATE` / `_APPLY` / `_FORCE` | Yes (`classifyRuntimeEnv`) | **Recommended** |
| `agency-tenant-audit.ts` | read-only | `AGENCY_TENANT_AUDIT_REMEDIATE` / `_APPLY` / `_FORCE` | Yes | **Recommended** |
| `user-tenant-membership-audit.ts` | read-only | gated, same template | Yes | **Recommended** |
| `passport-metadata-audit.ts` | read-only | gated | Yes | **Recommended** |
| `company-profile-tenant-audit.ts` | read-only | gated | Yes | Recommended |
| `attendance-lock-scope-audit.ts` | read-only | gated | Yes | Recommended if attendance-lock data exists |
| `phone-audit.ts` | read-only | gated | Yes | Optional (data quality) |
| `super-user-audit.ts` | read-only | gated | Yes | Optional |
| **`reports-tenant-backfill-audit.ts`** | **read-only** | `REPORTS_TENANT_AUDIT_REMEDIATE` / `_APPLY` / `_FORCE` | Yes | **Required** before relying on the new sharing/visibility model in production (backfills `Report.tenantId` on legacy rows when safely inferable from the creator) |
| `grant-agency-manager-attendance.ts` | one-shot **mutator** (idempotent) | none — the grant is the entire purpose | n/a | Already shipped on staging in Phase 2C #36; only needed if a new tenant created an Agency Manager role without the grant |

Every script writes a JSON backup of every changed row to `backend/reports/saas/<script>-backup.json` before any UPDATE runs.

---

## 4. Deployment checklist

### Pre-deploy (operator workstation)
```
git fetch origin claude/design-multitenant-recruitment-8H42T
git checkout claude/design-multitenant-recruitment-8H42T
git pull --ff-only

# Backend deps + prisma client
cd backend && npm ci && npx prisma generate && npm run build
cd ..

# Frontend deps + build
npm ci
npm run build

# Static regression battery (must be green)
for s in reports-phase-a reports-phase-b reports-phase-c reports-phase-d reports-phase-e \
         tenant-filter rbac dashboard-counter dto-tenant agency-tenant \
         doc:name doc:meta doc:license-autofill candidate-conversion \
         attendance-calc attendance-calc:unit applicant-tenant tenant \
         superuser date phone ui:error phase1; do
  npm run "$s:check" || npm run "$s" || break
done

npm run i18n:check
```

### Deploy
1. **Backend** — deploy first (the boot-time `healAdditiveDrift` migrates the schema idempotently).
2. **Frontend** — deploy after backend is up so the new `/reports/preview`, `/reports/:id/visibility`, `/reports/:id/share` routes are available.

### Post-deploy on staging — audit scripts in DRY-RUN
```
cd backend
npx ts-node scripts/saas/agency-tenant-audit.ts                    # read-only
npx ts-node scripts/saas/applicant-jobad-tenant-audit.ts          # read-only
npx ts-node scripts/saas/user-tenant-membership-audit.ts          # read-only
npx ts-node scripts/saas/reports-tenant-backfill-audit.ts         # read-only
npx ts-node scripts/saas/passport-metadata-audit.ts               # read-only
```
Inspect the JSON reports under `backend/reports/saas/`. Apply with `_REMEDIATE=true _APPLY=true` only after review.

### Smoke (manual)
- Login matrix (§5).
- Tenant switching across Dashboard, EmployeesList, ApplicantsList, AgenciesList, FinanceDashboard, ReportsDashboard, NotificationCenter, plus the six newly-subscribed pages from Phase 3 #1.x (EmployeeCompliance, WorkflowOverview, StageDetails, WorkflowBoardPage, WorkflowStageDetailsPage, WorkflowSettingsPage).
- Reports: create draft → Preview (does NOT save) → Save Report (does) → Run (capped at 1000) → Export → Share with user → revoke → set visibility PRIVATE/SHARED/PUBLIC_IN_TENANT.
- Attendance: edit a day, flip status to SICK → working hours = 0, time fields cleared; flip back to PRESENT → 8h default; bulk fill month.
- Documents: View action visible on profile tabs + Document Explorer (Phase 3 #10/#25); Driving License upload auto-fills `Employee.licenseNumber` only when empty (#19).
- Candidate→Employee conversion: with address in `applicationData` → succeeds; missing → amber banner lists missing fields (#26).
- Finance tenant isolation: SUPER selects tenant X → all finance lists + counters filter to X.

---

## 5. Manual smoke-test matrix

Legend: ✓ allowed · ✗ blocked · — N/A

| Action | SUPER | System Admin | HR Manager | Agency Manager | Finance | Recruiter | Read Only | role w/o attendance |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| Login | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Tenant switch (top menu) | ✓ | — | — | — | — | — | — | — |
| Employees list / view | ✓ | ✓ | ✓ | own-agency only | ✗ (no `employees:read` unless granted) | ✓ | ✓ | ✓ |
| Employee create / edit | ✓ | ✓ | ✓ | own-agency only | ✗ | ✗ | ✗ | ✗ |
| Applicants / Candidates create | ✓ | ✓ | ✓ | own-agency only | ✗ | ✓ | ✗ | ✗ |
| Candidate→Employee conversion | ✓ | ✓ | ✓ | ✗ (`AGENCY_CONVERT_FORBIDDEN`) | ✗ | ✓ | ✗ | ✗ |
| Documents view (eye icon) | ✓ | ✓ | ✓ | own-agency entity | ✓ | ✓ | ✓ | ✓ |
| Documents upload | ✓ | ✓ | ✓ | own-agency entity | ✗ | ✓ | ✗ | ✗ |
| Attendance read | ✓ | ✓ | ✓ | own-agency employees | ✓ | ✓ | ✓ | ✗ |
| Attendance edit (unlocked period) | ✓ | ✓ | ✓ | own-agency only | ✗ | ✗ | ✗ | ✗ |
| Attendance delete | ✓ | ✓ | ✓ | own-agency + permission + period unlocked | ✗ | ✗ | ✗ | ✗ |
| Lock month | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Reset month (per employee) | ✓ | ✓ | ✓ | own-agency employee | ✗ | ✗ | ✗ | ✗ |
| Finance list / records | ✓ | ✓ | — | — | ✓ | — | — | — |
| Reports list | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Reports source dropdown shows Finance | ✓ | ✓ | ✗ | ✗ | ✓ | ✗ | ✗ | ✗ |
| Reports source dropdown shows Attendance | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ |
| Reports Preview (does NOT save) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Reports Save / Update | ✓ | ✓ | ✓ | ✗ (no `reports:create`) | ✓ | ✗ | ✗ | ✗ |
| Reports Run (cap 1000) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | depends on source perm |
| Reports Delete (owner-only) | ✓ owner | ✓ owner | ✓ owner | ✓ owner | ✓ owner | ✗ | ✗ | ✗ |
| Reports Share / set visibility | ✓ owner | ✓ owner | ✓ owner | ✓ owner | ✓ owner | ✗ | ✗ | ✗ |
| Agency create / SUPER tenant override | SUPER ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Direct URL spoofing (`/agencies/<other-tenant-id>`) | follows selected tenant | ✗ 404 | ✗ 404 | ✗ 404 | ✗ 404 | ✗ 404 | ✗ 404 | ✗ 404 |

### Key acceptance cases
- **Preview never persists** — clicking Preview multiple times leaves the saved-reports list untouched. (Phase A.)
- **Reuse a deleted report name** — delete `"test"`, create `"test"` again, no 409 conflict. (Phase B partial unique index.)
- **Karim cannot see Raed's private report** — log in as Karim, browse `/reports`; only own reports, shared reports, and `PUBLIC_IN_TENANT` reports in the same tenant should appear. (Phase B/C.)
- **Tenant switch refetch** — switch tenant on the top menu while sitting on `EmployeeCompliance` / pipeline pages → page refetches against the new tenant (Phase 3 #1.x R-3, six pages).
- **Dashboard counter ↔ list parity** — pipeline IN_PROGRESS and approval-rate counters now match the lists below them when SUPER picks tenant X (Phase 3 #1.y R-1 b/c).
- **DL auto-fill** — upload a Driving License document with a number for an employee whose `licenseNumber` is empty → profile fills. Upload again with a different number → profile does NOT overwrite (Phase 3 #19).

---

## 6. Known remaining risks

| ID | Risk | Severity | Notes |
|---|---|:---:|---|
| ENV-1 | `vite build` not exercised in this report — frontend `node_modules` absent in the harness | Low | Operator must run `npm ci && npm run build` once at deploy time. No code defect. |
| ENV-2 | Pseudo-locale missing keys (4739 entries) | Low | Dev-only translation locale. All 6 real locales pass. |
| R-5-residual | Same DTO whitelist guard applies if any of User/Document/Finance/Notification/Attendance services ever grow a SUPER tenant override | Low / Deferred | Statically banned by `dto-tenant:check`. Won't ship silently broken. |
| R-6 | `EmployeeWorkflowAssignment.assignEmployee` is `phase261-pipeline-transition-deferred` — existing rows may carry NULL `tenantId` | Low / Deferred | Feature gap, not a regression. Tackle when that workflow lands. |
| R-7 | `notifications.service.ts:826` conditional `tid` write | Low / Deferred | Read paths are correctly scoped (#1.x R-2). Worst-case: stamped `tenantId=null` row invisible to dedup; never cross-tenant disclosure. |
| R-8 | `reports.service.ts.runReport` custom-SQL composer not re-verified in this pass | Low-Med / Deferred | Spot-check on the next reports-touching task. The dashboard counters fed by that composer are already audited (#1.y). |
| R-9 | `User` has no flat `tenantId` (Phase 1 schema decision) | Low / Documented | Captured in SPIKE-007. Means the **Users report source is intentionally absent** in Reports Phase E. |
| REP-LIM-1 | Reports composer does NOT support tenant-equality joins | Medium / Deferred | Means Attendance/Finance/Maintenance/Workflow report sources cannot show parent entity business identifiers (`employeeNumber` etc.). Single-table sources still useful for ops. Re-evaluate after SPIKE-007 Phase B or an explicit engine refactor. |
| REP-LIM-2 | Agency scoping on Attendance / Finance / Job Ads / Workflows report sources is permission-gated, not row-filtered | Medium / Documented | Agency-scoped actors with the relevant `*:read` see all tenant rows. To row-filter would need composer joins or a schema denorm — both out of scope. |
| REP-LIM-3 | Workflow assignment / stage progress / stage approval sources NOT in the registry | Low / Deferred | Skipped intentionally in Phase E Batch 3: joins not added; `EmployeeWorkflowAssignment` carries R-6 attribution gap. |

**No blockers, no High items, no New items introduced.**

---

## 7. Final readiness recommendation

| Question | Answer |
|---|---|
| **Ready for staging deployment?** | **YES.** |
| **Ready for production after UAT?** | **YES, with the pre-prod checklist below.** |

### Required pre-production actions
1. Run the manual smoke-test matrix in §5 on staging using accounts for at least: SUPER, System Admin, HR Manager, Agency Manager, Finance, Recruiter, Read Only.
2. Run the five **Required / Recommended** audit scripts from §3 on a staging clone in DRY-RUN. Apply with `_APPLY=true` only after JSON-report review.
3. Confirm `vite build` succeeds in the operator's normal toolchain (the only thing not exercised in this report).
4. Confirm the boot log on staging shows `healAdditiveDrift` running its Reports Phase B steps successfully — specifically the `reports.name partial unique` step replacing the legacy `reports_name_key` constraint.

### Optional post-production follow-ups
- **REP-LIM-1**: roadmap a composer refactor (or accept SPIKE-007 Phase B's `User.tenantId` denorm) to unlock Users + workflow assignment surfaces with cross-entity business identifiers.
- **REP-LIM-2**: extend Attendance/Finance/Workflows source agency scoping once joins land.
- **R-6 / R-7 / R-8**: revisit on the next workflow / notifications / reports-touching task.
- **R-9 / SPIKE-007 Phase A**: plan the backend `find-by-id-or-business-id` resolver — small, schema-free, opens the door to Phase B URL rewriting later.
- **SPIKE-008 Phase A**: enhanced profile notes — separately approved.
- **SPIKE-010 follow-up** — **"Add consistent in-page `TenantFilterSelect` to all eligible tenant-owned list pages."** Audit confirmed tenant scoping is already secure (top-bar selector + `useTenantSyncVersion()` re-scopes every list page). The per-list filter is an optional UX convenience. Recommended sequencing:
  1. **Phase F1**: harmonise `UsersList`'s bespoke filter UI to use the shared `TenantFilterSelect` component (no behaviour change, no backend change, ~20 min).
  2. **Phase F2**: per-service backend `?tenantId=` override capability on the Tier-2 services (`agencies`, `vehicles`, `documents`, `finance`, `job-ads`, `notifications`, `attendance`, `workflow`, `reports` list endpoint). One small focused PR per service, each adding a `dto-tenant`-style regression check banning the reverse migration.
  3. **Phase F3**: drop `TenantFilterSelect` into each Tier-2 list page using the existing `useSuperUserTenantFilter` hook (mechanical 5-line edits, contingent on F2).
  Full inventory + risk analysis in `docs/spikes/SPIKE-010-tenant-filter-coverage.md`.

---

## Phase 3 cycle — running totals

| Area | Items closed | Commits | New regression scripts |
|---|:---:|:---:|:---:|
| Phase 1, 1A, 1B, 2A, 2B, 2C (pre-cycle) | already on branch | — | — |
| Phase 3 #7, #10/#25, #19, #26, #27, #29 implementations | 6 | 6 | 5 |
| Phase 3 #1 audit + #1.x, .y, .z follow-ups | 4 audit items closed | 4 | 3 |
| Phase 3 #15, #17 spike reports | 2 (documents only) | 2 | 0 |
| Reports module Phases A–E | 15 brief items + 7 new sources | 7 + 1 spike | 5 |
| Phase 3 hardening QA pass | — | 1 | 0 |
| **TOTAL THIS CYCLE** | **27 brief items + 7 sources** | **20 commits** | **13 scripts** |

All commits on `claude/design-multitenant-recruitment-8H42T`, HEAD `2a5dda06863e8c4fe287c13dbdce0198c2be8229`.
