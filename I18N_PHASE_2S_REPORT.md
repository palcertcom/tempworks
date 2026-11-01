# I18N Phase 2.S Report

**Branch:** `claude/phase-2s-i18n-users-vehicles-longtail`
**Date:** 2026-05-06

## Summary

Phase 2.S completed the frontend i18n sweep for the Users module, Vehicles module, and all remaining workflow long-tail files. Literal count reduced from **137 → 13** (all 13 remaining are confirmed false positives).

---

## Files Modified

### Users Module

| File | Hook(s) | Strings Translated |
|------|---------|-------------------|
| `src/app/pages/users/AddUser.tsx` | `t` (pages), `tc` (common) | 16 |
| `src/app/pages/users/EditUser.tsx` | `t` (pages), `tc` (common) | 21 |
| `src/app/pages/users/UsersList.tsx` | `t` (pages), `tc` (common) | 15 |

**Sample keys added (`pages.users.*):**
- `users.list.filterAllRoles/Statuses/Agencies/Depts/Countries`
- `users.list.toggleCols`, `users.list.showAll/hideAll`
- `users.list.pendingApproval`, `users.list.activationLinkTitle`, `users.list.bulkImportTitle`
- `users.add.subtitle`
- `users.edit.subtitle/accountStatus/changeStatus/allowView/allowViewHelper/allowEdit/allowEditHelper/allowDelete/allowDeleteHelper`
- `users.form.photoLabel/photoHint/firstName/middleName/lastName/email/jobTitle/startDate/dateOfBirth/addressLine1/addressLine2/postalCode/password`

### Vehicles Module

| File | Hook(s) | Strings Translated |
|------|---------|-------------------|
| `src/app/pages/vehicles/VehiclesList.tsx` | `t` (pages), `tc` (common) | 7 |
| `src/app/pages/vehicles/MaintenanceTypesList.tsx` | `tp` (pages), `t` (common) | 6 + bug fix |
| `src/app/pages/vehicles/MaintenanceRecordsList.tsx` | `t` (pages) | 5 |
| `src/app/pages/vehicles/WorkshopsList.tsx` | `t` (pages), `tc` (common) | 5 |

**Bug fixed in `MaintenanceTypesList.tsx`:** Column headers were calling `t(c.labelKey)` with the common namespace but keys lived in pages — silently fell back to raw key strings. Fixed by aliasing pages hook as `tp`.

**Sample keys added (`pages.vehicles.*):**
- `vehicles.list.toggleCols/showAll/hideAll/filterAllTypes/filterAllStatuses`
- `vehicles.workshops.filterAllCities/filterAllCountries/filterAllStatuses/inactive`
- `vehicles.maintenanceRecords.filterAllStatuses/filterAllWorkshops/dateFrom/dateTo/clearFilters`
- `vehicles.maintTypes.subtitle/filterAllStatuses/toggleCols/showAll/empty`

### Workflow Long-tail Files

| File | Hook(s) | Strings Translated |
|------|---------|-------------------|
| `src/app/pages/workflow/StageDetails.tsx` | `t` (pages) — new | 8 |
| `src/app/pages/workflow/WorkflowAnalytics.tsx` | `t` (pages) — new | 16 |
| `src/app/pages/workflow/WorkflowStageDetail.tsx` | `t` (pages), `tc` (common) — new | 12 |
| `src/app/pages/workflow/WorkflowTimeline.tsx` | `t` (pages) — new | 8 |
| `src/app/pages/workflow/WorkflowManagement.tsx` | `tp` (pages), `t` (common) | 6 |
| `src/app/pages/workflow/VisaTracking.tsx` | `t` (pages) — new | 2 |
| `src/app/pages/workflow/WorkPermitTracking.tsx` | `t` (pages) — new | 3 |

**Sample keys added (`pages.workflow.*):**
- `workflow.stageDetails.notFound/notFoundDesc/returnToWorkflow/totalInStage/avgDaysInStage/atRisk/stageRequirements/inStage`
- `workflow.stageDetail.exportReport/stageRequirements/driversInStage/avgDaysInStage/atRiskSla/completionRate/inStage/stageCompletionRate/onTrack/atRisk/slaThreshold`
- `workflow.timeline.activityTitle/subtitle/filterByType/filterByDate/eventsToday/thisWeek/completedStages/loadMore`
- `workflow.analytics.title/subtitle/periodLast30/exportReport/avgTimeLabel/completionRateLabel/slaBreachesLabel/activeInWorkflow/stageVsSlaCardTitle/stageVsSlaTitle/monthlyTrendCardTitle/monthlyTrendTitle/bottleneckCardTitle/bottleneckTitle/dropOffCardTitle/dropOffTitle/insightsCardTitle/insight1-3Title`
- `workflow.management.title/subtitle/stageName/stageColor/addStage/dragToReorder`
- `workflow.workPermits.title/subtitle/inProgress`
- `workflow.visas.title/subtitle`

---

## Locale Sync

All 5 non-EN locales synced with English fallback values:

| Locale | Status |
|--------|--------|
| `ar` | ✓ synced |
| `de` | ✓ synced |
| `ru` | ✓ synced |
| `sk` | ✓ synced |
| `tr` | ✓ synced |

---

## Quality Checks

| Check | Result |
|-------|--------|
| `npm run i18n:check-keys` | ✓ All 5 target locales × 9 namespaces match English |
| `npm run i18n:check-literals` | 13 hits — all confirmed false positives |
| `npm run build` | ✓ Built successfully (18.24s) |

### Remaining Literal Scanner Hits (All False Positives)

| File | Line | Value | Reason |
|------|------|-------|--------|
| `ApplicantFormSteps.tsx` | 1304, 1553, 1728, 1976, 2259, 2698 | TS type signatures | TypeScript `Record<string, ...>` / function signatures in JSX generic context |
| `UsersList.tsx` | 625 | `"firstName,lastName,email,roleId,agencyId"` | CSV column format spec in textarea placeholder — technical, not user-visible label |
| `WorkflowAnalytics.tsx` | 81, 84, 102, 120, 138 | `"45 days"`, `"-8% vs last month"`, etc. | Static mock/demo metric values in hardcoded chart data |
| `api.ts` | 548 | `"[]) as Promise"` | TypeScript cast expression |

---

## Namespaces Used

- **`pages`** — all page-level UI labels (primary namespace for this phase)
- **`common`** — shared strings (`states.loading`, `permissions.accessDenied`, `required`, `saveChanges`, etc.)

---

## What Was Preserved (Not Translated)

- Backend-sourced content: names, emails, nationality, job titles, notes
- Dynamic data values: `{driver.firstName}`, `{item.count}`, `{stage.name}`, etc.
- Recharts chart data series names (`name="Avg Days"`, `name="SLA Threshold"`) — internal chart axis labels
- Mock numeric values in WorkflowAnalytics ("45 days", "+12 vs last month") — static demo data
- CSV format specification string in UsersList
