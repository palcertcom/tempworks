# I18N Phase 2.L — Implementation Report

**Branch:** `claude/phase-2l-i18n-dashboard-jobads-hotspots`
**Scope:** Frontend-only — sweep the dashboard + job-ad hot spots
surfaced after Phase 2.K: `FinanceDashboard`, `LogsDashboard`,
`EmployeesList` body, `JobAdsList` body, `JobAdForm`.
**Date:** 2026-05-05.

---

## 1 · Changed files

```
src/app/pages/finance/FinanceDashboard.tsx                  (24 → 1 ‡)
src/app/pages/logs/LogsDashboard.tsx                        (20 → 1 ‡)
src/app/pages/employees/EmployeesList.tsx                   (12 → 1 ‡)
src/app/pages/job-ads/JobAdsList.tsx                        (9 → 1 ‡)
src/app/pages/job-ads/JobAdForm.tsx                         (9 → 1 ‡)

src/i18n/locales/en/pages.json                              (+ ~75 keys)
src/i18n/locales/{sk,de,ru,ar,tr}/pages.json                (sync — English fallback)

I18N_PHASE_2L_REPORT.md                                     (new)
```

‡ Remaining hits per file are TypeScript template-literal expressions
(`= from && t`, `Number(r.companyDisbursedAmount ?? 0)`,
`(e: React.ChangeEvent<...>`, `[c.key, true])) as Record`) — JS/TS
code that the regex catches as JSX text. Not user-visible.

### Per-file residual literal counts

| File | Before | After |
|---|---:|---:|
| `pages/finance/FinanceDashboard.tsx` | 24 | 1 (template-literal expr) |
| `pages/logs/LogsDashboard.tsx` | 20 | 1 (template-literal expr) |
| `pages/employees/EmployeesList.tsx` | 12 | 1 (template-literal expr) |
| `pages/job-ads/JobAdsList.tsx` | 9 | 1 (template-literal expr) |
| `pages/job-ads/JobAdForm.tsx` | 9 | 1 (TS-signature false positive) |

### Repo-wide literal-scanner totals

| Stage | Total |
|---|---:|
| Phase 2.K end | 690 |
| Phase 2.L end | 622 |

**68-literal reduction.**

---

## 2 · Dashboard / list / job-ad coverage

### `FinanceDashboard.tsx` (24 → 1)

Full visible-text translation under new `finance.dashboard.*`
(~22 keys):

```
✓ Access-denied panel ("You do not have permission…" + "Back to Dashboard")
✓ Column-picker (Toggle columns / Show all)
✓ 4 stat cards (Total Disbursed / Total Deducted / Current Balance /
   Emp / Agency Paid + "informational only" subtext)
✓ Filter panel: Person Type / All Statuses / Transaction Type /
   All Types / All Currencies / Date From / Date To / Paid By /
   Min Disbursed / Max Disbursed
✓ Loading state
✓ Footer legend (Credit (↑) / Debit (↓))
```

### `LogsDashboard.tsx` (20 → 1)

Extended `logs.dashboard.*` (~17 keys):

```
✓ Column-picker (Toggle columns / Show all)
✓ Activity by Module + Activity by Action card titles
✓ Time range select (All Time / Last 7 Days / Last 30 Days /
   Last 90 Days / Custom Range…)
✓ Module/Entity filter (placeholder + "All Modules" sentinel)
✓ Action filter ("All Actions" + 3 specific actions: Login Failed,
   Change Password, Stage Change)
✓ Custom-from date label
✓ Clear-logs dialog: "This action is irreversible…" warning,
   From Date / To Date / Module / Entity (optional) form labels +
   "All modules" placeholder
```

### `EmployeesList.tsx` body (12 → 1)

Extended `employees.list.*`:

```
✓ Filter sentinel SelectItems (All Statuses / All Agencies /
   All Citizenships) — placeholders were already translated; this
   adds the dropdown items
✓ "Joined from" date-range label
✓ Column-picker (Toggle columns / Show all / Hide all)
✓ Loading + filtered-empty states
```

### `JobAdsList.tsx` body (9 → 1)

Extended `jobAds.list.*` (~8 keys):

```
✓ 4 filter dropdowns (All Statuses / All Categories / All Countries /
   All Contracts) — placeholder + sentinel items
✓ "Created from" date-range label
✓ Column-picker (Toggle columns / Show all)
```

### `JobAdForm.tsx` (9 → 1)

Extended `jobAds.form.*` (~8 keys):

```
✓ Loading state
✓ 4 card titles (Basic Information / Job Description / Salary & Status /
   Required Documents)
✓ "City is required" / "Country is required" inline + toast
   validation
✓ "Loading document types…" empty state
```

---

## 3 · `confirm()` callers translated

This phase did not target additional `confirm()` callers. None of
the 5 dashboard/list/form files contain new `confirm()` invocations.
The 31-caller backlog from Phase 2.G/H/I/J/K remains for Phase 2.M.

---

## 4 · New translation keys

| Sub-tree | Keys | Purpose |
|---|---:|---|
| `finance.dashboard.*` | ~22 | Access-denied + 4 stat cards + filter panel + loading + legend |
| `logs.dashboard.*` (extension) | ~17 | Charts + time/module/action filters + clear-logs dialog |
| `employees.list.*` (extension) | ~6 | Filter sentinels + column picker + loading + empty + "Joined from" |
| `jobAds.list.*` (extension) | ~8 | Filter dropdowns + column picker + "Created from" |
| `jobAds.form.*` (extension) | ~8 | Loading + 4 card titles + 2 validation messages + doc-types loading |
| **Total new EN keys** | **~61** | — |

Times 5 non-EN locales = **~305 strings** awaiting native
translation. Cumulative since Phase 2.A is now ~3,700 EN keys ×
5 locales ≈ **~18,500 strings**.

---

## 5 · Locale parity strategy

`/tmp/sync_keys.mjs` walked every namespace in `en/` and inserted
missing keys into each non-English locale verbatim. CLDR plural
variants for ar/ru/sk preserved.

---

## 6 · RTL polish

Touched files use logical Tailwind classes (`me-`, `ms-`, `text-end`,
`text-start`, `start-`, `end-`). No new directional icons introduced.

---

## 7 · Quality checks

```
$ npm run i18n:check-keys
✓ All 5 target locales × 9 namespaces match English.

$ npm run i18n:check-literals
Found 622 suspicious hardcoded JSX literal(s)
  (down from 690 at end of Phase 2.K — 68-literal reduction).

$ npm run build
✓ built in ~27s
(bundle size warning unchanged; pre-existing.)
```

---

## 8 · Known limitations

1. **5 scanner false positives** carried in the touched files — JS/TS
   template-literal expressions. Not user-visible.

2. **31 `confirm()` callers still pass English props.** Carried over
   since Phase 2.G. Pages: `EmployeeProfile`, `ApplicantProfile`,
   `CandidateProfile`, `WorkflowSettingsPage`, `MaintenanceTypesList`,
   `MaintenanceRecordsList`, `WorkshopsList`, `VehicleSettings`,
   `MaintenanceTypesSettings`, `ReportsDashboard`,
   `WorkflowManagement`. Phase 2.M scope.

3. **Static column-picker `ALL_COLUMNS` arrays** in `FinanceDashboard`,
   `LogsDashboard`, `EmployeesList` etc. carry hardcoded English
   labels at module scope. The visible toggle text in the column
   picker comes from `c.label` which is set at module init. This is
   a structural pattern change (move the array inside the component
   body, or add a `labelKey` field with `t()` lookup at render time)
   that's deferred — flagged Phase 2.M.

4. **New literal-scanner hot spots surfaced** by removing this
   phase's targets:
   - `pages/pipelines/WorkflowStageDetailsPage.tsx` (18)
   - `pages/notifications/NotificationCenter.tsx` (14)
   - `pages/pipelines/WorkflowSettingsPage.tsx` (11)
   - `pages/pipelines/WorkflowsPage.tsx` (8)
   - `pages/pipelines/WorkflowBoardPage.tsx` (8)

5. **`StageTransition.tsx` (4 literals) is dead code** — flagged
   Phase 2.E for removal.

6. **English fallback values for ~61 new keys.** Per the brief.

7. **Build still emits pre-existing 500 KB chunk warning.** Unchanged.

---

## 9 · Remaining high-impact untranslated areas

Sorted by literal-scanner count:

| File | Literals | Notes |
|---|---:|---|
| `pages/pipelines/WorkflowStageDetailsPage.tsx` | 18 | Stage detail / approval page. |
| `pages/notifications/NotificationCenter.tsx` | 14 | Notifications list / panel. |
| `pages/pipelines/WorkflowSettingsPage.tsx` | 11 | Workflow stage configuration. |
| `pages/pipelines/WorkflowsPage.tsx` | 8 | Workflows list body residuals. |
| `pages/pipelines/WorkflowBoardPage.tsx` | 8 | Workflow board residuals. |
| `components/applicants/ApplicantFormSteps.tsx` | 6 | TS-signature false positives. |
| `pages/profile/ChangePassword.tsx` | 5 | Password change form residuals. |
| `components/workflow/StageTransition.tsx` | 4 | **Dead code**. |
| `pages/notifications/NotificationSettings.tsx` | 3 | Notification preferences. |
| 31 `confirm()` callers | — | English title/description across detail / settings pages. |

---

## 10 · Recommended Phase 2.M scope

### Phase 2.M.1 — Pipelines/Workflow detail pages (~1.5 d)

Translate `WorkflowStageDetailsPage.tsx` (18), `WorkflowSettingsPage.tsx`
(11), `WorkflowsPage.tsx` body residuals (8), `WorkflowBoardPage.tsx`
body residuals (8). All 4 already use `pages.pipelines.*` namespace
from earlier phases — extend it.

### Phase 2.M.2 — Notifications module (~0.75 d)

Translate `NotificationCenter.tsx` (14) and `NotificationSettings.tsx`
(3). Add `pages.notifications.*` namespace if not present.

### Phase 2.M.3 — `confirm()` caller sweep (~1.5 d)

The 31 callers backlogged from Phase 2.G/H/I/J/K/L. Pattern is
mechanical with `common.confirm.*` reusable phrases.

### Phase 2.M.4 — Static column-picker labels (~0.5 d)

Refactor `ALL_COLUMNS` arrays in FinanceDashboard, LogsDashboard,
EmployeesList, ApplicantsList, CandidatesList etc. to use a
`labelKey` field, evaluated at render time via `t()`. Removes the
remaining static English label leaks in column dropdowns.

### Phase 2.M.5 — Native translations (~3-4 d)

Cumulative translator workload is ~3,700 EN keys × 5 locales ≈
~18,500 strings.

### Phase 2.M.6 — Delete dead code (~0.25 d)

Remove `components/workflow/StageTransition.tsx`.

### Suggested next prompt

> Implement Phase 2.M.1 + 2.M.2 + 2.M.3 of the i18n component sweep.
> Branch `claude/phase-2m-i18n-pipelines-notifications-confirms`.
> Translate the Pipelines/Workflow detail pages (StageDetailsPage,
> SettingsPage, list/board residuals), the Notifications module
> (Center + Settings), and complete the 31 remaining `confirm()`
> call sites listed in I18N_PHASE_2L_REPORT.md §8. Reuse existing
> `pages.pipelines.*` / `pages.notifications.*` namespaces and the
> `common.confirm.*` reusable phrases. Run `npm run i18n:check-keys`,
> `npm run i18n:check-literals`, and `npm run build` before commit.
> Push to the new branch. Do not open a PR.
