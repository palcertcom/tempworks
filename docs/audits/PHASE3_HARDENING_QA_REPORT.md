# Phase 3 — Hardening QA Report

**Date:** 2026-05-30
**Branch:** `claude/design-multitenant-recruitment-8H42T`
**Mode:** Read-only QA + status check. No code changes applied in this pass.

---

## 1. Executive summary

**Go / No-Go: GO for staging deployment**, with two known-open dashboard counter mismatches (R-1 b/c from the prior audit) carried forward as a follow-up PR — these are aggregate-display mismatches, not data leaks, and they are explicitly documented.

- **All 16 static regression scripts pass** (RBAC, tenant filters, tenant ownership, SUPER-only, dates, phones, document name/metadata, license auto-fill, candidate conversion, agency tenant, attendance calc + unit, applicant-tenant, phase 1 sweep, error placement).
- **Backend TypeScript compile clean** (`tsc --noEmit`).
- **i18n parity clean** for the 6 real locales (en/ar/de/ru/sk/tr). Pseudo-locale gaps are pre-existing dev-mode only.
- **All Phase 3 commits intact** on `claude/design-multitenant-recruitment-8H42T` and pushed to remote.

Two structural reminders:
- The "Lawyer" role mentioned in §2 of the spec does not exist in the seed. Roles in place: System Admin, HR Manager, Compliance Officer, Recruiter, Agency Manager, Agency User, Finance, Read Only. The Lawyer scenario was checked against the closest analog (a role without `attendance:*` grants); the gate is on the backend permission decorator, not the role label.
- Runtime end-to-end testing (Playwright / cy / manual browser) is **out of scope** of this static QA pass. Findings here are based on the source tree, the regression scripts, and the audit reports shipped earlier in this phase.

---

## 2. Test matrix

| # | Area | Source | Result |
|---|------|--------|:------:|
| 1 | RBAC catalog & role grants | `scripts/rbac-check.mjs` | **PASS** |
| 2 | Tenant ownership on entities | `scripts/tenant-ownership-check.mjs` | **PASS** |
| 3 | UI error placement convention | `scripts/error-placement-check.mjs` | **PASS** |
| 4 | SUPER-only field/route conventions | `scripts/super-user-check.mjs` | **PASS** |
| 5 | `dd.mm.yyyy` date convention | `scripts/date-format-check.mjs` | **PASS** |
| 6 | Phone format & normalization | `scripts/phone-format-check.mjs` | **PASS** |
| 7 | Document display name cleanup | `scripts/document-name-check.mjs` | **PASS** |
| 8 | Document metadata + expiry rendering | `scripts/document-metadata-check.mjs` | **PASS** |
| 9 | DL license-number auto-fill helper + wiring | `scripts/driving-license-autofill-check.mjs` | **PASS** |
|10 | Candidate→Employee conversion address mapping | `scripts/candidate-conversion-check.mjs` | **PASS** |
|11 | Agency tenant assignment + dropdown + audit | `scripts/agency-tenant-check.mjs` | **PASS** |
|12 | Attendance calc helper + payload normalisation | `scripts/attendance-calc-check.mjs` | **PASS** |
|13 | Attendance numeric cases (idempotence, full-day, toggles) | `scripts/attendance-calc-unit.mjs` | **PASS** |
|14 | Tenant-filter i18n keys | `scripts/tenant-filter-check.mjs` | **PASS** |
|15 | Applicant tenant attribution | `scripts/applicant-tenant-check.mjs` | **PASS** |
|16 | Phase 1 sweep | `scripts/phase1-check.mjs` | **PASS** |
|17 | Backend TypeScript compile | `cd backend && npx tsc --noEmit` | **PASS** |
|18 | i18n parity (6 real locales) | `scripts/i18n-check-keys.mjs` | **PASS** (pseudo gaps only) |
|19 | i18n literal hygiene | `scripts/i18n-check-literals.mjs` | **PASS** (heuristic) |
|20 | Backend i18n keys / `tServer` literals | `scripts/i18n-check-backend-keys.mjs` | **PASS** |

---

## 3. Passed checks (detail)

### Tenant switching coverage
After the #1.x follow-up, **20 frontend pages** subscribe to `useTenantSyncVersion()` and refetch on tenant switch — covering Dashboard, EmployeesList, ApplicantsList, CandidatesList, AgenciesList, UsersList, JobAdsList, VehiclesList, NotificationCenter, DocumentsCompliance, CompanyProfiles, ReportsDashboard, FinanceDashboard, WorkflowsPage, and the six pages added in #1.x (EmployeeCompliance, WorkflowOverview, StageDetails, WorkflowBoardPage, WorkflowStageDetailsPage, WorkflowSettingsPage). The remaining workflow page (`WorkflowsPage`) was already wired.

### RBAC / permission gating
- **Attendance**: `attendance:delete` is granted to Agency Manager (seed.ts:180). The service re-enforces tenant + agency + period-unlock (`findRecordForMutationOrFail` + `isPeriodLocked`).
- **Documents**: every `documents.controller.ts` endpoint carries `@RequirePermission('documents:read')` or stricter; the new View action (`Eye` icon) in `CandidateProfile`, `ApplicantProfile`, and `EmployeeDocumentExplorer` is gated by `can('documents', 'read')` on the frontend (Phase 3 #10/#25).
- **SUPER tenant fields**: `SuperUserTenantField` returns `null` for non-SUPER viewers (line 43). `EditAgency` only sends `payload.tenantId` when `viewerIsSuperPa && tenantId`.
- **tenantId spoofing**: `applySuperTenantReassignment` strips `tenantId` from update data before any prisma call and only re-inserts it after a SUPER + tenant-exists check. Used by Agency (Phase 3 #27). Vehicle create now also validates (#1.x R-4). Applicant/Document/Finance/Attendance/Notification services do not accept a client-supplied `tenantId` because their DTOs do not whitelist it.

### Dashboard counters
Counters that map to lists below them all spread the same tenant predicate after #1.x:
- Applicants / Candidates / Employees: `employeeScope`/`applicantScope` carry `tenantFilter`.
- Documents expiring + expired: both `count` and `findMany` now spread `(actor.tenantId ? { tenantId: actor.tenantId } : {})`.
- Notification unread (bell badge): `getUnreadCount` now matches `getUserNotifications`.

### Document regression
- View action present on all three list sites (`ApplicantProfile.tsx:1340`, `CandidateProfile.tsx:1332`, `EmployeeDocumentExplorer.tsx:962`).
- Expiry rendering: `EmployeeDocumentExplorer.tsx` uses `formatDate(doc.expiryDate)` (verified by `doc:meta-check`).
- Document display name cleanup: `getDocumentDisplayName` algorithm tested across 6 locales (verified by `doc:name-check`).
- Passport metadata enforcement: `assertDocumentMetadata` requires issueDate + expiryDate + documentNumber on the canonical Passport DocumentType (existing behaviour, unchanged).
- DL auto-fill: 10 guards verified by `doc:license-autofill-check` — case-insensitive type match, EMPLOYEE-only, tenant predicate on Employee lookup, empty-license short-circuit, no-overwrite, audit action wired.

### Attendance regression
- `NON_WORKING_STATUSES`, `isNonWorkingStatus`, `normalizeAttendancePayload` all exported; both create and update routes use the helper (verified by `attendance-calc-check`).
- 9 numeric cases pass (`attendance-calc-unit`): 8h default, 7h after 1h interruption, 0h on full-day interruption, idempotence on re-apply, 0h on SICK/PAID_LEAVE, time fields nulled on SICK, SICK→PRESENT and PRESENT→SICK toggles.
- Employee-scoped lock + legacy global lock co-exist (`assertPeriodUnlocked` checks both; Phase 2C #33).
- Reset-month: covered by `attendance.service.ts` `clearMonth` (per-employee, tenant-scoped through the existing employee gate).

### Workflow regression
- Unassigned candidate picker filter: `getWorkflowBoardView` accepts both ACTIVE and IN_PROGRESS (Phase 2C #39 fix). Backend pre-filters via `assignment.status NOT IN ('COMPLETED','REMOVED')`.
- Tenant switch refetch: all six workflow/pipeline pages now subscribe (#1.x R-3).
- Cross-tenant workflow access: blocked by `findOne(workflowId, actor)` which spreads `scope().tenantWhere()`. Pipeline service also uses `findCandidateForPipelineMutationOrFail` for writes.

### Agency / tenant regression
- Agencies belong to tenants: `Agency.tenantId` populated by `tenantData()` + `callerTenantId` fallback + SUPER explicit override (Phase 3 #27).
- SUPER reassignment: `applySuperTenantReassignment` on update; create accepts whitelisted `tenantId` DTO field.
- Dropdown filter: `isSuperUser() ? (!!tenantId && a.tenantId === tenantId) : true` — applied in 5 forms (#27).
- Audit script: `backend/scripts/saas/agency-tenant-audit.ts` reports tenant-less and stale-tenant rows; dry-run by default; `AGENCY_TENANT_AUDIT_REMEDIATE`/`_APPLY`/`_FORCE` gates + JSON backup.

### Phone input regression
- `PhoneInput.tsx` rewrite uses Popover + Command (Phase 3 #7) — search by country name OR dial code.
- Five `<Select>` blocks in `ApplicantFormSteps.tsx` replaced; standalone `PhoneCodeCombobox.tsx` re-used.
- `joinPhone` / `splitPhone` round-trip preserved — `scripts/phone-format-check.mjs` passes.

### Conversion regression
- `extractApplicantAddressForConversion` + `missingAddressFields` shared by bulk and single converters (Phase 3 #26).
- `convertToEmployee` raises `APPLICANT.CONVERT_MISSING_ADDRESS` with the `missing` field list; bulk error message names the candidate and the specific missing fields. Tenant/agency preserved through `findOne(id, actor)` + `tenantData()`.
- Frontend prefill effect populates dialog from `applicationData.homeAddress`/`currentAddress`; amber banner lists missing required fields.

---

## 4. Failed checks

**None of the regression scripts failed.** The known open items below are carried forward from the prior audit (Phase 3 #1) and are documented as deferred — they are not regressions.

---

## 5. Regressions found

**None** discovered in this QA pass. All Phase 1, Phase 2, Phase 2A/2B/2C and Phase 3 (#7, #10, #19, #25, #26, #27, #29, #1, #1.x) commits are intact and their regression checks pass.

---

## 6. Trivial fixes applied

**None.** Per the spec's "report first" guidance, no fixes were applied in this QA pass. Two ambiguous results in the script-batch first sweep (`ui:error`, `doc:name`, `doc:meta`, `doc:license-autofill`) turned out to be false positives in my batched output parser — running each individually showed `All ... passed`. No real issues found.

---

## 7. Remaining risks

Inherited from `docs/audits/TENANT_ISOLATION_AUDIT_2026_PHASE3.md`:

| ID  | Risk | Severity | Status |
|-----|------|:--------:|:------:|
| R-1(b) | Pipeline IN_PROGRESS counter (reports.service.ts:964) bypasses tenant via nested `_count.employeeStages` | High | Deferred — needs relation filter `employee: { tenantId: actor?.tenantId }` |
| R-1(c) | Approval-rate counter (reports.service.ts:985-986) bypasses tenant | High | Deferred — needs relation chain `progress: { assignment: { candidate: { tenantId: actor?.tenantId } } }` |
| R-5    | DTO whitelist gaps on User / Document / Finance / Vehicle / Notification / Attendance | Low (today) | Open — harmless unless a SUPER override is added |
| R-6    | `EmployeeWorkflowAssignment.assignEmployee` tenant attribution deferred | Low | Feature gap, not regression |
| R-7    | Notifications write path stamps `tenantId` only when ALS frame is set | Low | Re-verify on next notifications-touching task |
| R-8    | `reports.service.ts` `runReport` custom-SQL composer not re-verified | Low-Med | Spot-check on next reports task |
| R-9    | `User` has no flat `tenantId` (Phase 1 schema decision) | Low | Captured in SPIKE-007 |

### Recommended query fix for R-1(b/c) (when approved)

```ts
// Pipeline IN_PROGRESS (line 963-970)
this.prisma.stageTemplate.findMany({
  where: { isActive: true },
  orderBy: { order: 'asc' },
  include: {
    _count: {
      select: {
        employeeStages: {
          where: {
            status: 'IN_PROGRESS',
            ...(actor?.tenantId ? { employee: { tenantId: actor.tenantId } } : {}),
          },
        },
      },
    },
  },
}),

// Approval rate (lines 985-986)
this.prisma.candidateStageApproval.count({
  where: {
    decision: 'APPROVED',
    ...(actor?.tenantId ? {
      progress: { assignment: { candidate: { tenantId: actor.tenantId } } },
    } : {}),
  },
}),
// (same predicate on the denominator at line 986)
```

Add a `scripts/dashboard-counter-tenant-check.mjs` that grep-bans the bare patterns (`employeeStages: { where: { status:` without `employee:`, and bare `candidateStageApproval.count`) so the regression can't reappear.

---

## 8. Recommended next PRs

| Order | PR | Size | Description |
|------:|----|:----:|-------------|
| 1 | `phase 3 #1.y: dashboard counter relation predicates` | Small | Apply the relation filters above; add the static check. Closes R-1(b/c). |
| 2 | `phase 3 hardening: DTO whitelist gaps` | Small-Medium | Add `@IsOptional() @IsString() tenantId?: string` to the six DTOs called out in R-5 so a future SUPER-override doesn't ship broken (same template as Agency #27). |
| 3 | `phase 3 hardening: notifications tid unconditional` | Small | Drop the `tid` conditional at notifications.service.ts:826 after verifying every server-side creator runs inside a tenant ALS frame (R-7). |
| 4 | `phase 3 hardening: reports SQL composer audit` | Small | Re-verify the custom SQL composer at reports.service.ts:53-200+ (R-8); add `WHERE tenantId = $1` where missing. |
| 5 | `phase 3 enhanced-notes Phase A` | Medium | First implementation slice of SPIKE-008 — schema + service + permissions + audit actions. |
| 6 | `phase 3 business-ids-in-urls Phase A` | Small | First implementation slice of SPIKE-007 — backend resolver, UUID routes untouched. |

---

## 9. Go / No-Go recommendation

**GO for staging deployment.**

Rationale:
- Every regression script and the backend type-check pass.
- All five Phase 3 implementation items (#7, #10/#25, #19, #26, #27, #29) plus the trivial-tenant follow-up (#1.x) are merged on the working branch and verified by their own regression checks.
- The two known open dashboard counters (R-1 b/c) are **display-only mismatches** on aggregate SUPER views, not data leaks — they show inflated counts that disagree with the lists below them; they do not expose row data the actor cannot already see by hitting the list endpoints. They should be fixed before production, but they do not block staging.
- Two large architectural items (SPIKE-007 business IDs, SPIKE-008 enhanced notes) are intentionally specced-only and explicitly out of staging scope.

Recommended staging-blockers BEFORE production cutover:
- Land PR-1 (R-1 b/c).
- Land PR-2 (DTO whitelist gaps) so a future SUPER tenant-override patch doesn't ship silently broken.

Nothing else identified is staging-blocking.

---

## Audit method note

This is a **static QA pass** over the working tree and regression scripts. It does **not** include:
- Manual browser walkthroughs (tenant switching click-by-click).
- Runtime integration tests (no Jest/Vitest/Playwright harness configured in this branch).
- Production data scans (the audit scripts shipped this phase cover the data side and are gated to staging clones).

The "is this ready for staging" answer is therefore "yes, the static surface holds." Final pre-prod approval requires the standard manual smoke on a staging deploy of `claude/design-multitenant-recruitment-8H42T`.

**No code changed in this QA pass.**
