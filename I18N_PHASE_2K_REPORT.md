# I18N Phase 2.K — Implementation Report

**Branch:** `claude/phase-2k-i18n-employee-module-hotspots`
**Scope:** Frontend-only — sweep the new employee-module hot spots
surfaced after Phase 2.J: `EditEmployee`, `EmployeeComplianceTimeline`,
`EmployeeTrainingHistory`, `EmployeePerformanceReview`,
`EmployeeCertifications`.
**Date:** 2026-05-05.

---

## 1 · Changed files

```
src/app/pages/employees/EditEmployee.tsx                    (27 → 1 ‡)
src/app/pages/employees/EmployeeComplianceTimeline.tsx      (17 → 0 ✓)
src/app/pages/employees/EmployeeTrainingHistory.tsx         (12 → 0 ✓)
src/app/pages/employees/EmployeePerformanceReview.tsx       (12 → 0 ✓)
src/app/pages/employees/EmployeeCertifications.tsx          (8 → 1 ‡)

src/i18n/locales/en/pages.json                              (+ ~95 keys)
src/i18n/locales/{sk,de,ru,ar,tr}/pages.json                (sync — English fallback)

I18N_PHASE_2K_REPORT.md                                     (new)
```

‡ Remaining hits are template-literal expressions (`(e: React.ChangeEvent<...>`,
`0 && daysUntilExpiry`) — TypeScript code that the regex catches as
JSX text. Not user-visible.

### Per-file residual literal counts

| File | Before | After |
|---|---:|---:|
| `pages/employees/EditEmployee.tsx` | 27 | 1 (TS-signature false positive) |
| `pages/employees/EmployeeComplianceTimeline.tsx` | 17 | 0 ✓ |
| `pages/employees/EmployeeTrainingHistory.tsx` | 12 | 0 ✓ |
| `pages/employees/EmployeePerformanceReview.tsx` | 12 | 0 ✓ |
| `pages/employees/EmployeeCertifications.tsx` | 8 | 1 (template-literal expr) |

### Repo-wide literal-scanner totals

| Stage | Total |
|---|---:|
| Phase 2.J end | 764 |
| Phase 2.K end | 690 |

**74-literal reduction.** Plus all toast strings in `EditEmployee`
re-routed through `apiError(err, t(...))`.

---

## 2 · Employee-module coverage

### `EditEmployee.tsx` (27 → 1)

Mirrors the Phase 2.J `AddEmployee.tsx` structure. **Reuses the
existing `employees.add.*` keys** for shared labels (firstName,
lastName, email, phone, dateOfBirth, citizenship, emergencyContact,
streetAddress, city, postalCode, country, agency, directHire,
licenseNumber, licenseCategory, yearsExperience, notes) and adds
~32 edit-specific keys under `employees.edit.*`:

```
✓ Loading state via common.states.loading
✓ Access-denied panel via common.permissions.*
✓ Subtitle: "Update employee information"
✓ 3 card titles (Personal Information / Address Information /
   Professional Information)
✓ "Address Line 2" field (edit-only — not in Add form)
✓ Job Category select with "Select job category" placeholder + "Not specified" sentinel
✓ License Category placeholder ("e.g. CE, C, B")
✓ Photo upload card: title, alt text, change-photo button title,
   "New photo selected" indicator, Change/Upload Photo button label,
   "JPEG, PNG or WebP · max 5 MB" help text
✓ Status card: status select with 6 options (Pending / Onboarding /
   Active / Inactive / On Leave / Terminated)
✓ Saving…/Save Changes/Cancel buttons
✓ Photo upload partial-failure toast with apiError interpolation
✓ Update success/failure toasts via apiError
```

### `EmployeeComplianceTimeline.tsx` (17 → 0)

Full page translation under `employees.complianceTimeline.*` (~28 keys):

```
✓ Page title + dynamic subtitle ("{{name}} • Complete compliance
   history and events")
✓ Export Timeline button
✓ 4 stat-card titles (Completed / Warnings / Resolved / Compliance Rate)
✓ Current Compliance Status card title
✓ 3 status panels (All Documents Valid + help / Training Up to Date +
   help / No Active Issues + help)
✓ Compliance Event Timeline card title + subtitle
✓ Per-event labels (Date / Actioned By / Reference)
✓ "Notes:" label
✓ Load Older Events button
✓ Upcoming Compliance Requirements card title
✓ ADR Certificate Renewal item (title + due-in-11-months badge + help)
✓ Annual Medical Examination item (title + due-in-10-months badge + help)
```

### `EmployeeTrainingHistory.tsx` (12 → 0)

Extended `employees.training.*` (~12 keys):

```
✓ "Training History" page title
✓ 3 stat labels (In Progress / Total Hours / Avg Score)
✓ Course "Certificate:" + "Expires:" prefix labels
✓ 2 recommended-training items: "Advanced Route Planning &
   Navigation" + helper, "Electric & Hybrid Truck Operation" + helper
✓ "Enroll Now" button (× 2)
```

### `EmployeePerformanceReview.tsx` (12 → 0)

Extended `employees.performance.*` (~13 keys):

```
✓ "Performance Reviews" page title
✓ 4 stat-card labels (Latest Rating / Avg Rating / On-Time Rate /
   Total Incidents)
✓ "Current vs Previous quarter comparison" subtitle
✓ "Overall rating over time" subtitle
✓ Category Ratings section header
✓ Reviewer Feedback section header
✓ Per-review metric labels (Safety Rating / On-Time Delivery)
✓ "View Full Review" button
```

### `EmployeeCertifications.tsx` (8 → 1)

Extended `employees.certifications.*` (~8 keys):

```
✓ "Certifications & Licenses" page title
✓ "Expiring Soon" stat label
✓ Per-certificate row labels: Issued: / Expires:
✓ Endorsements: / Restrictions: / Attached Documents: section labels
```

---

## 3 · `confirm()` callers translated

This phase did not target additional `confirm()` callers. None of
the 5 employee-module files contain `confirm()` invocations — they
are read-only timelines / lists / forms. The 31-caller backlog from
Phase 2.G/H/I/J remains for Phase 2.L.

---

## 4 · New translation keys

| Sub-tree | Keys | Purpose |
|---|---:|---|
| `employees.edit.*` (extension) | ~32 | Full Edit Employee form (incl. photo upload card + 6 status options + 3 toasts) |
| `employees.complianceTimeline.*` (extension) | ~28 | Full timeline page (stats + status panels + event timeline + upcoming reqs) |
| `employees.training.*` (extension) | ~12 | Stats + cert/expires prefixes + recommended-training items + Enroll Now |
| `employees.performance.*` (extension) | ~13 | Stats + chart subtitles + section headers + per-review metrics + button |
| `employees.certifications.*` (extension) | ~8 | Page title + 6 row labels |
| **Total new EN keys** | **~93** | — |

Times 5 non-EN locales = **~465 strings** awaiting native
translation. Cumulative since Phase 2.A is now ~3,600 EN keys ×
5 locales ≈ **~18,000 strings**.

---

## 5 · Locale parity strategy

`/tmp/sync_keys.mjs` walked every namespace in `en/` and inserted
missing keys into each non-English locale verbatim. CLDR plural
variants for ar/ru/sk preserved.

---

## 6 · RTL polish

Touched files use logical Tailwind classes (`me-`, `ms-`, `text-end`,
`text-start`, `start-`, `end-`). The compliance timeline's vertical
line uses `start-6` for RTL-correct positioning.

---

## 7 · Quality checks

```
$ npm run i18n:check-keys
✓ All 5 target locales × 9 namespaces match English.

$ npm run i18n:check-literals
Found 690 suspicious hardcoded JSX literal(s)
  (down from 764 at end of Phase 2.J — 74-literal reduction).

$ npm run build
✓ built in ~19s
(bundle size warning unchanged; pre-existing.)
```

---

## 8 · Known limitations

1. **2 scanner false positives** in `EditEmployee.tsx` and
   `EmployeeCertifications.tsx` (TypeScript template-literal
   expressions). Not user-visible.

2. **31 `confirm()` callers still pass English props.** Carried
   over since Phase 2.G. Mostly mechanical — pages: `EmployeeProfile`,
   `ApplicantProfile`, `CandidateProfile`, `WorkflowSettingsPage`,
   `MaintenanceTypesList`, `MaintenanceRecordsList`,
   `WorkshopsList`, `VehicleSettings`, `MaintenanceTypesSettings`,
   `ReportsDashboard`, `WorkflowManagement`. Phase 2.L scope.

3. **New literal-scanner hot spots surfaced** by removing this
   phase's targets:
   - `pages/finance/FinanceDashboard.tsx` (24)
   - `pages/logs/LogsDashboard.tsx` (20)
   - `pages/employees/EmployeesList.tsx` (12 — visible-text labels;
     bulk-action toasts already covered Phase 2.F)
   - `pages/job-ads/JobAdsList.tsx` (9 — body literals; toasts
     already covered Phase 2.F)
   - `pages/job-ads/JobAdForm.tsx` (9)

4. **`StageTransition.tsx` (4 literals) is dead code** — flagged
   Phase 2.E for removal.

5. **English fallback values for ~93 new keys.** Per the brief.

6. **Build still emits pre-existing 500 KB chunk warning.** Unchanged.

---

## 9 · Remaining high-impact untranslated areas

Sorted by literal-scanner count:

| File | Literals | Notes |
|---|---:|---|
| `pages/finance/FinanceDashboard.tsx` | 24 | Finance dashboard — stat cards + charts + tables. |
| `pages/logs/LogsDashboard.tsx` | 20 | Audit logs viewer. |
| `pages/employees/EmployeesList.tsx` | 12 | List body — table headers + filters not yet swept. |
| `pages/job-ads/JobAdsList.tsx` | 9 | List body. |
| `pages/job-ads/JobAdForm.tsx` | 9 | Add/Edit job ad form. |
| `components/applicants/ApplicantFormSteps.tsx` | 6 | TS-signature false positives. |
| `components/workflow/StageTransition.tsx` | 4 | **Dead code**. |
| 31 `confirm()` callers | — | English title/description across detail / settings pages. |

---

## 10 · Recommended Phase 2.L scope

### Phase 2.L.1 — Finance + Logs dashboards (~1.5 d)

Translate `FinanceDashboard.tsx` (24) and `LogsDashboard.tsx` (20).
Pattern is uniform: stat cards, chart subtitles, table headers,
filters, date pickers, empty states.

### Phase 2.L.2 — Job Ads module (~1 d)

Translate `JobAdsList.tsx` body (9) and `JobAdForm.tsx` (9). Reuse
existing `jobAds.list.*` namespace from Phase 2.F + add
`jobAds.form.*` for the add/edit form.

### Phase 2.L.3 — `EmployeesList.tsx` body (~0.5 d)

The remaining 12 literals are visible table column headers and
filter labels — extends existing `employees.list.*` namespace
(toasts already covered in Phase 2.F).

### Phase 2.L.4 — `confirm()` caller sweep (~1.5 d)

The 31 callers backlogged from Phase 2.G/H/I/J/K. Pattern is
mechanical with `common.confirm.*` reusable phrases.

### Phase 2.L.5 — Native translations (~3-4 d)

Cumulative translator workload is ~3,600 EN keys × 5 locales ≈
~18,000 strings.

### Phase 2.L.6 — Delete dead code (~0.25 d)

Remove `components/workflow/StageTransition.tsx`.

### Suggested next prompt

> Implement Phase 2.L.1 + 2.L.2 + 2.L.3 of the i18n component sweep.
> Branch `claude/phase-2l-i18n-finance-logs-jobads`. Translate the
> Finance + Logs dashboards, the Job Ads list body + form, and the
> EmployeesList table-header literals. Reuse existing `finance.*` /
> `logs.*` / `jobAds.*` / `employees.*` namespaces. Run
> `npm run i18n:check-keys`, `npm run i18n:check-literals`, and
> `npm run build` before commit. Push to the new branch. Do not
> open a PR.
