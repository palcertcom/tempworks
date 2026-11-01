# Tenant Isolation Audit — 2026 Phase 3 #1

**Date:** 2026-05-30
**Branch:** `claude/design-multitenant-recruitment-8H42T`
**Scope:** Verification of Phase 1, Phase 2, Phase 3 tenant-related fixes.
**Mode:** Read-only audit + follow-up trivial-fix PR.

## Follow-up status (2026-05-30, post-audit)
- **R-1(a) — applied.** `reports.service.ts:1000-1005` expired-documents
  `findMany` now spreads `...(actor?.tenantId ? { tenantId: actor.tenantId } : {})`.
- **R-2 — applied.** `notifications.service.ts:165` `getUnreadCount` now
  spreads `...activeTenantWhere(caller)` matching `getUserNotifications`.
- **R-3 — applied.** All six pages
  (`EmployeeCompliance`, `WorkflowOverview`, `StageDetails`,
  `WorkflowBoardPage`, `WorkflowStageDetailsPage`, `WorkflowSettingsPage`)
  now import `useTenantSyncVersion` and include it in their load dep array.
- **R-4 — applied.** `vehicles.service.ts:248-256` validates the SUPER
  explicit `tenantId` against `tenant.findUnique` and throws
  `TENANT.NOT_FOUND` (matching agencies/job-ads). The update path was
  already validating.
- **R-1(b) / R-1(c) — applied.** `reports.service.ts:964-983` pipeline
  IN_PROGRESS counter now scopes the nested `employeeStages` count via
  `employee: { tenantId: actor.tenantId }`. `reports.service.ts:990-1010`
  approval-rate numerator and denominator both scope via
  `progress: { assignment: { candidate: { tenantId: actor.tenantId } } }`.
  Static regression `scripts/dashboard-counter-tenant-check.mjs` bans
  the bare patterns so the leak cannot reappear silently.
- **R-5 — applied (2026-05-30 follow-up).** DTOs in users / documents /
  finance / notifications / attendance verified not to declare
  `tenantId`; their services verified not to read it. `createWorkshop`
  SUPER override now validates the target tenant via
  `tenant.findUnique` (same shape as the #1.x R-4 fix on createVehicle).
  Static regression `scripts/dto-tenant-whitelist-check.mjs` bans the
  unsafe pattern in either direction (untrusted DTO declares tenantId,
  or trusted service skips validation).
- **R-6 through R-9 — open**, classified Low or Deferred.

---

## Executive summary

Tenant isolation is **substantially complete** for the per-entity CRUD
surface — every create/list/detail path on the audited entities routes
through a tenant predicate, agency-side users are gated through their
agency, and SUPER tenant switching is wired up on every page that owns
its data fetch.

Three classes of leak remain, all in **aggregate / counter** code that
post-dates the per-entity hardening:

1. **Dashboard counters in `reports.service.ts`** disagree with the
   underlying lists for SUPER users in selected-tenant mode (pilot-off
   path). Pipeline IN_PROGRESS, approval-rate, and the expired-docs
   detail list count across all tenants.
2. **`notifications.getUnreadCount`** uses `scope().tenantWhere()` alone
   while `getUserNotifications` correctly uses `scope().tenantWhere() +
   activeTenantWhere(caller)`. Bell badge can show a global count.
3. **Six workflow / compliance / pipeline pages** mount their data fetch
   without subscribing to `useTenantSyncVersion()`, so they show the
   previous tenant's data until the user navigates away and back.

Two **DTO whitelist gaps** (Vehicle / Notification / Attendance / Document /
Finance / User do not whitelist `tenantId`) are harmless **today** because
the only path that would write a client-supplied tenant is a hypothetical
SUPER override the services don't implement. They become risks the moment
those services grow a SUPER override — flagged for the future.

**Conclusions** (full statements in §D):
- Tenant isolation: **substantially complete**, four open items.
- Tenant switching: **substantially complete**, six pages to subscribe.
- Dashboard consistency: **partial — see Risk-1**.

---

## A. Entity matrix

Legend: **✓** = correct, **!** = concern (see Notes), **⊘** = intentionally global,
**def.** = deferred / not implemented yet.

| Entity                     | Create        | List          | Detail        | Update          | Delete         | Tenant safe? | Notes |
|----------------------------|:-------------:|:-------------:|:-------------:|:---------------:|:--------------:|:------------:|-------|
| User                       | !             | ✓             | ✓             | ✓               | ✓              | partial      | `User` has no flat `tenantId` (schema decision); scope flows via `TenantMembership` + `agencyId`. Create() writes the membership but not a User column. OK by design, but inconsistent with the matrix and requires careful resolver design if business IDs land. |
| Applicant (Lead/Candidate) | ✓             | ✓             | ✓             | ✓               | ✓              | ✓            | `phase228-pilot-scope` everywhere; jobAdTenant wins over agencyTenant on create. |
| Employee                   | def. (1)      | ✓             | ✓             | ✓               | ✓              | ✓            | (1) No standalone create — produced by `applicants.convertToEmployee`, which writes `tenantData()` + caller fallback. |
| Agency                     | ✓             | ✓             | ✓             | ✓ (#27)         | ✓              | ✓            | Phase 3 #27 wired SUPER tenant reassignment + DTO whitelist. |
| Document                   | ✓             | ✓             | ✓             | ✓ (#19 added auto-fill) | ✓     | ✓            | `assertEntityOwnedByActiveTenant` runs before storage write. |
| FinancialRecord            | ✓             | ✓             | ✓             | ✓               | ✓              | ✓            | `phase216-pilot-scope`; list uses `activeTenantWhere(caller)`. |
| Vehicle                    | ✓ (caveat 2)  | ✓             | ✓             | ✓               | ✓              | ✓            | (2) SUPER `tenantId` override accepted but target tenant **not validated** against `tenant.findUnique` — Agency/JobAd do validate. See R-4. |
| Workshop                   | ⊘             | ⊘             | ⊘             | ⊘               | ⊘              | n/a          | Global catalog — `phase223-global`. |
| MaintenanceRecord          | ✓             | ✓             | ✓             | ✓               | ✓              | ✓            | Child of Vehicle; inherits scope. |
| MaintenanceType            | ⊘             | ⊘             | ⊘             | ⊘               | ⊘              | n/a          | Global catalog. |
| WorkPermit                 | ✓             | ✓             | ✓             | ✓               | ✓              | ✓            | `phase227-pilot-scope`. |
| Visa                       | ✓             | ✓             | ✓             | ✓               | ✓              | ✓            | `phase227-pilot-scope`. |
| CompanyExportProfile       | ✓             | ✓             | ✓             | ✓               | ✓              | ✓            | Phase 2B hardened. |
| JobAd                      | ✓             | ✓             | ✓             | ✓               | ✓              | ✓            | Public route uses slug; dashboard uses `callerTenantWhere`. |
| Notification               | ! (3)         | ✓             | n/a (read-only) | ✓ (read state) | n/a            | partial      | (3) `getUnreadCount` skips `activeTenantWhere(caller)`. See R-2. Writes correctly stamp tenant when the ALS frame is set. |
| CandidateWorkflowAssignment| ✓             | ✓             | ✓             | ✓               | ✓              | ✓            | `phase262-pipeline-mutation-pilot`. |
| EmployeeWorkflowAssignment | def.          | ✓             | ✓             | def.            | def.           | partial      | `assignEmployee` is `phase261-pipeline-transition-deferred`; not yet implemented for tenant attribution. |
| AttendanceRecord           | ✓             | ✓             | ✓             | ✓ (#29)         | ✓              | ✓            | `phase248-attendance-mutation-pilot`. Phase 3 #29 normalizes payload. |
| ComplianceAlert            | ✓             | ✓             | ✓             | ✓               | n/a            | ✓            | Created with `tdata`; alerts list spreads tenant predicate. |
| Reports (counters)         | n/a           | !             | n/a           | n/a             | n/a            | partial      | See R-1: three counters bypass tenant. |
| Dashboard cards            | n/a           | !             | n/a           | n/a             | n/a            | partial      | Same source as Reports; carries the same gaps. |
| Settings / catalogs (DocumentType, JobType, StageTemplate) | ⊘ | ⊘ | ⊘ | ⊘ | ⊘ | n/a | Intentionally global. Phase 3 product question: per-tenant overrides. |

---

## B. Remaining risks

| ID  | Risk                                                                 | Severity | File:line                                              | Recommendation |
|-----|----------------------------------------------------------------------|:--------:|--------------------------------------------------------|----------------|
| R-1 | Three dashboard counters span all tenants for SUPER in selected-tenant mode | **High** | `backend/src/reports/reports.service.ts:964`, `985-986`, `1000-1005` | (a) Add `where: { tenantId: actor?.tenantId }` to the expired-docs `findMany` (line 1000-1005) — **one-liner** mirroring the same query on line 961. (b) For pipeline IN_PROGRESS (line 964) filter the nested `_count.employeeStages` `where` with `employee: { tenantId: actor?.tenantId }`. (c) For approval rate (985-986) filter through `progress: { assignment: { candidate: { tenantId: actor?.tenantId } } }`. (b) and (c) need a relation-traversal predicate, not a one-liner — separate PR. |
| R-2 | Notification unread count returns global total when pilot is off     | **High** | `backend/src/notifications/notifications.service.ts:165` (`getUnreadCount`) vs `147` (`getUserNotifications`) | Spread `activeTenantWhere(caller)` alongside `scope().tenantWhere()` in `getUnreadCount`, matching the pattern already correct on `getUserNotifications`. **One-liner** the moment the function accepts `caller` (which it already does per the agent finding). |
| R-3 | Six pages do not refetch on tenant switch                             | Medium   | `EmployeeCompliance.tsx:20`, `workflow/WorkflowOverview.tsx:17`, `workflow/StageDetails.tsx:20`, `pipelines/WorkflowBoardPage.tsx:145`, `pipelines/WorkflowStageDetailsPage.tsx:344`, `pipelines/WorkflowSettingsPage.tsx:132` | Add `const version = useTenantSyncVersion();` and append `version` to the dependency array of the data-loading `useEffect`. Pattern is identical to the 14 pages that already do it. |
| R-4 | Vehicle SUPER tenant override accepts unvalidated `tenantId`         | Medium   | `backend/src/vehicles/vehicles.service.ts:248-250`     | Validate the requested `tenantId` via `prisma.tenant.findUnique({ where: { id }, select: { id: true } })` and throw `BadRequestException` if missing — mirrors `agencies.service.ts:177-186` and `job-ads.service.ts:430`. Also adopt the shared `applySuperTenantReassignment` helper on update. |
| R-5 | DTOs that don't whitelist `tenantId` would silently swallow a future SUPER override | Low (today) | User / Document / FinancialRecord / Vehicle / Notification / Attendance DTOs | When/if these services grow a SUPER tenant override, add `@IsOptional() @IsString() tenantId?: string;` (same fix Phase 3 #27 just shipped on Agency). No action needed today. |
| R-6 | `EmployeeWorkflowAssignment.assignEmployee` is tenant-attribution deferred | Low | `backend/src/pipeline/pipeline.service.ts:844`         | When the feature is implemented, spread `tenantData()` from the parent employee's tenant and reject cross-tenant assignment ids. |
| R-7 | `Notification` write path stamps `tenantId` only when ALS frame is set | Low      | `backend/src/notifications/notifications.service.ts:826`, conditional `tid` write | Audit pass on the next notifications-touching task: confirm every server-side notification creator either (a) runs inside a tenant ALS frame, or (b) sets `tenantId` explicitly. Dedup keys assume tenant; a row stamped `tenantId=null` is invisible to that dedup. |
| R-8 | `Reports.runReport` custom SQL composer not re-verified in this pass | Low-Med  | `backend/src/reports/reports.service.ts:53-200+`       | Spot-check on the next reports task: every SOURCE_DEF query should `WHERE tenantId = $1` when `actor?.tenantId` is set. Likely already done in the SQL composer below line 200, but not visible in the excerpt I reviewed. |
| R-9 | `User` has no flat `tenantId` column                                 | Low      | `backend/prisma/schema.prisma:195`                     | By-design Phase 1 decision. Document the resolver requirement: any business-ID lookup on User must go through the existing `agencyId` + `TenantMembership` join, never a bare `findUnique({ userNumber })`. Already captured in SPIKE-007. |

---

## C. Required future work

### Trivial (one-line) — safe to ship in one focused PR
1. **R-1(a)** — add `...(actor?.tenantId ? { tenantId: actor.tenantId } : {})` to the expired-documents `findMany` at `reports.service.ts:1000-1005`. The matching `count` query four lines up already does it.
2. **R-2** — spread `...activeTenantWhere(caller)` in `getUnreadCount`'s `where` at `notifications.service.ts:165`. Matches `getUserNotifications`.

### Small (one-screen change)
3. **R-3** — six `useEffect` dependency-array additions. Each diff is two lines.
4. **R-4** — add `tenant.findUnique` validation in `vehicles.service.ts:248-250`; switch update path to use the shared `applySuperTenantReassignment` helper.

### Medium (needs design)
5. **R-1(b/c)** — pipeline IN_PROGRESS and approval-rate counters need relation-traversal predicates (`employee: { tenantId }`, `progress: { assignment: { candidate: { tenantId } } }`). Single PR but each query must be reasoned about and tested. Add a regression check that grep-bans bare `employeeStages.count` / `candidateStageApproval.count` without a tenant predicate.

### High-risk / deferred
6. **R-6** — `EmployeeWorkflowAssignment.assignEmployee` tenant attribution is out of scope for this audit; it's a feature gap, not a regression.

### Cleanup / hygiene (do later, not blocking)
7. **R-5** — when any of the listed services grow a SUPER override, ship the DTO whitelist at the same time. Phase 3 #27 is the template.
8. **R-7** — drop the `tid` conditional in `notifications.service.ts:826` once we confirm every server-side caller runs inside a tenant ALS frame.
9. **R-8** — re-verify `Reports.runReport` custom SQL composer (out of scope of the excerpt this audit reviewed).
10. **R-9** — codify the User-resolver rule in the eventual Phase A of SPIKE-007.

---

## D. Verification summary

| Module                    | Status |
|---------------------------|:------:|
| Users — CRUD + tenant scope          | **Pass** (caveat R-9) |
| Applicants / Leads / Candidates       | **Pass** |
| Employees                              | **Pass** |
| Agencies (post #27)                    | **Pass** |
| Documents                              | **Pass** |
| Finance                                | **Pass** |
| Vehicles                               | **Pass** (with R-4) |
| Workshops / MaintenanceTypes (global)  | **Pass (by design)** |
| MaintenanceRecords                     | **Pass** |
| WorkPermits / Visas                    | **Pass** |
| JobAds                                 | **Pass** |
| Notifications (lists / preferences)    | **Pass** |
| Notifications (unread count)           | **Fail — R-2** |
| Attendance (post #29)                  | **Pass** |
| Compliance alerts                      | **Pass** |
| CandidateWorkflowAssignment            | **Pass** |
| EmployeeWorkflowAssignment             | **Deferred — R-6** |
| Reports — list-style counters          | **Pass** |
| Reports — pipeline / approval counters | **Fail — R-1(b/c)** |
| Reports — expired docs list            | **Fail — R-1(a)** |
| Dashboard cards                        | **Fail — R-1** (data sourced from reports.service) |
| Frontend tenant switching — list pages | **Pass** (14 pages subscribe) |
| Frontend tenant switching — workflow / pipeline / compliance pages | **Fail — R-3** (6 pages do not subscribe) |
| Tenant audit log writes                | **Pass** |
| Settings / catalogs                    | **Pass (by design)** |

---

## E. Explicit conclusions

1. **Is tenant isolation complete?** — **No, three known gaps remain.**
   - The list/detail/CRUD surface is hardened. The leaks are in *aggregate*
     queries: three counters in `reports.service.ts` (R-1) and the unread
     notification badge (R-2). All four are tractable; two are one-liners.
   - One feature is deferred (R-6) but doesn't represent regression — it's
     a not-yet-shipped path.

2. **Is tenant switching complete?** — **No, six pages stale-after-switch.**
   - 14 pages already subscribe to `useTenantSyncVersion()` and refetch on
     switch. Six workflow / compliance / pipeline pages do not (R-3). Fix
     is mechanical: import the hook + add to dep array.

3. **Is dashboard consistency complete?** — **No, see R-1.**
   - For a SUPER user with a specific tenant selected and pilot off, the
     pipeline counter, approval-rate counter, and expired-documents list
     show numbers larger than the lists below them. Same shape as the
     classic Phase 2A "Raed bug," carried here by the reports service
     post-dating Phase 2A's `activeTenantWhere` adoption.

4. **What remains open?**
   - **High:** R-1, R-2.
   - **Medium:** R-3 (UX-only — no data leak; just stale display until
     refetch), R-4.
   - **Low / deferred:** R-5 through R-9.
   - None of these are new functionality. R-1(a), R-2, R-3, R-4 fit one
     small focused PR each and don't require schema work.

---

## Audit method note

This audit was a **read-only static scan** of:
- The 20+ service files referenced above.
- `backend/prisma/schema.prisma` for `tenantId` column presence and
  `@@index` coverage.
- `src/app/contexts/TenantSyncContext.tsx` for the version-bump contract.
- Every frontend list page identified in the SUPER tenant-switching
  audit (14 subscribed, 6 not subscribed).

It does **not** include runtime testing, integration tests, or a
production-data scan. The audit scripts shipped earlier this phase
(`applicant-jobad-tenant-audit.ts`, `agency-tenant-audit.ts`,
`user-tenant-membership-audit.ts`, `passport-metadata-audit.ts`) cover
the data-side equivalents; they should be re-run on a staging clone
after R-1(b/c) lands to confirm the historical counters reconcile.

**No code changed in this audit pass.**
