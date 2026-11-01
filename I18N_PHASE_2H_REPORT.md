# I18N Phase 2.H — Implementation Report

**Branch:** `claude/phase-2h-i18n-lists-exports`
**Scope:** Frontend-only — sweep the largest remaining list-page
table headers / filter chips / status badges, the body sections of
`AgencyUsersManagement` / `AddApplicant`, the `CandidateDeleteRequests`
review page, residual loading/empty states across embedded
components, and the on-page section labels of the
`EmployeePdfDocument` React-PDF export.
**Date:** 2026-05-05.

---

## 1 · Changed files

```
src/app/pages/applicants/ApplicantsList.tsx              (19 → 2 false positives)
src/app/pages/applicants/CandidatesList.tsx              (24 → 2 false positives)
src/app/pages/agencies/AgenciesList.tsx                  (9 → 1 false positive)
src/app/pages/applicants/CandidateDeleteRequests.tsx     (9 → 0)
src/app/pages/agencies/AgencyUsersManagement.tsx         (5 → 0)
src/app/pages/applicants/AddApplicant.tsx                (4 → 0)
src/app/pages/agencies/MyAgencyProfile.tsx               (1 → 0)
src/app/components/attendance/AttendanceTab.tsx          (1 → 0)
src/app/components/employees/WorkHistoryTimeline.tsx     (6 → 0; full Add-entry dialog)
src/app/components/employees/EmployeePdfDocument.tsx     (4 → 0; React-PDF labels via i18n.t)

src/i18n/locales/en/pages.json                           (+ ~210 keys across applicants.list,
                                                           applicants.candidates, agencies.list,
                                                           agencies.users, agencies.myProfile,
                                                           applicants.deleteRequestsPage,
                                                           applicants.addPage, employees.pdf,
                                                           employees.workHistoryTimeline)
src/i18n/locales/{sk,de,ru,ar,tr}/pages.json             (sync — English fallback)

I18N_PHASE_2H_REPORT.md                                  (new)
```

### Per-file residual literal counts

| File | Before | After |
|---|---:|---:|
| `pages/applicants/ApplicantsList.tsx` | 19 | 2 ‡ |
| `pages/applicants/CandidatesList.tsx` | 24 (incl. 6 visible body) | 2 ‡ |
| `pages/agencies/AgenciesList.tsx` | 9 | 1 ‡ |
| `pages/applicants/CandidateDeleteRequests.tsx` | 9 | 0 ✓ |
| `pages/agencies/AgencyUsersManagement.tsx` | 5 | 0 ✓ |
| `pages/applicants/AddApplicant.tsx` | 4 | 0 ✓ |
| `pages/agencies/MyAgencyProfile.tsx` | 1 | 0 ✓ |
| `components/attendance/AttendanceTab.tsx` | 1 | 0 ✓ |
| `components/employees/WorkHistoryTimeline.tsx` | 6 | 0 ✓ |
| `components/employees/EmployeePdfDocument.tsx` | 4 | 0 ✓ |

‡ Remaining hits are template-literal expressions (`= 0 && age`, `= from && t`, `Filter by status`) that the regex picks up as JSX text but are JS code or pre-existing placeholder strings inside `SelectValue` props that were already translated for the `SelectItem` content. Documented as scanner false positives.

### Repo-wide literal-scanner totals

| Stage | Total |
|---|---:|
| Phase 2.G end | 997 |
| Phase 2.H end | 922 |

**75-literal reduction.** Plus ~25 raw English status-badge / filter-placeholder strings (uncaught by the scanner) routed through `t(...)`.

---

## 2 · Table / list pages translated

### Applicants list — `ApplicantsList.tsx` (19 → 2)

```
✓ Stat card  "Accepted / Onboarding"
✓ Bulk toolbar: "{{count}} selected" / "Promote to Candidate" / "Change Status" /
   "Delete Selected" / "Clear"
✓ Search placeholder "Search name, email, ID…"
✓ Filter selects: "All Statuses" / "All Agencies" / "All Citizenships" / "All Job Categories"
✓ "Refresh" / "Export to Excel ({n})" / "Export PDFs ({n})" buttons + their
   disabled-tooltips ("Select one or more rows to export …")
✓ Column-picker: "Columns" + count badge / "Toggle columns" / "Show all" / "Hide all"
✓ Date range "Applied from … to …" labels
✓ "Clear filters" ghost button
✓ Loading state ("Loading…") + filtered-empty state
✓ Lead-number "Legacy" italic fallback
✓ All 12 SortableHead column labels (Applicant, Contact, Citizenship, Applied Position,
   Passport Number, Age, Gender, Agency, Tier, Applied, Status, Actions)
✓ Bulk-Promote dialog: "Promote {{count}} Lead(s) to Candidate" CLDR-plural-aware title,
   intro paragraph, "Responsible Agency" label, "Use system default holding agency"
   placeholder + sentinel item, Cancel + Promote buttons
```

### Candidates list — `CandidatesList.tsx` (24 → 2)

Same pattern as ApplicantsList plus candidate-specific:

```
✓ "Mark Accepted" / "Connect to Workflow" / "Convert to Employees" bulk actions
✓ Bulk Connect-to-Workflow dialog: title + body + "Workflow *" + "In Progress"
   inline strong, Responsible Agency picker, Notes input, Assign/Cancel buttons
✓ Bulk Convert-to-Employee dialog: title CLDR-plural, "Responsible Agency (optional)",
   "Keep each candidate's current agency" placeholder + sentinel
```

### Agencies list — `AgenciesList.tsx` (9 → 1)

```
✓ Status filter select: "All Status" placeholder + items reuse
   `common.filters.{active,inactive}` for Active/Inactive
✓ Country filter select: "All Countries"
✓ Date range "Created from … to …" labels
✓ "Clear" / "Columns" / "Toggle columns" / "Show all" / "Reset"
✓ All 8 column headers (Agency Name → Created), "Actions"
✓ Loading + empty-short states
✓ "View" link button text
```

### Other list-bodies

```
✓ CandidateDeleteRequests: page title + subtitle, 4 status filter tabs (All/Pending/Approved/
   Rejected), Card title "Delete Requests", loading + empty + emptyHelp,
   table headers (Candidate Name / Candidate ID / Requested By / Date / Reason / Status /
   Actions), Approve / Reject buttons, status badges (Pending/Approved/Rejected),
   reject-reason modal (title / intro / notes label + placeholder, Rejecting…/Reject
   Request/Cancel buttons)
✓ AgencyUsersManagement: page title + dynamic subtitle ({{name}} — Manage agency user
   accounts), Add User button, "Maximum number of users reached" warning + body,
   3 stat cards (Active Users / Managers / Inactive), agency-users-card title with
   {{count}}, no-users empty state, 6 table headers, 3 approval-status badges,
   "Manager override:" prefix
✓ AddApplicant: access-denied panel via common.permissions.*, draft subtitle vs.
   Driver Application Form, "Discard draft" button, Agency label + (optional)
   suffix, Select agency placeholder + "No Agency" sentinel
✓ MyAgencyProfile: title + "Your account is not attached to any agency." notice
```

---

## 3 · `confirm()` callers translated

This phase did not add new `confirm()` translations — the focus was
table / list / body / PDF surfaces. The 31 callers backlogged in
Phase 2.G remains for Phase 2.I.

---

## 4 · PDF / export labels

### `EmployeePdfDocument.tsx` (frontend React-PDF) ✓ done

The 4 visible-text literals are now translated via a `tp(key)`
wrapper around `i18n.t('employees.pdf.<key>', { ns: 'pages' })` —
mirrors the print-summary pattern from Phase 2.D's
`downloadApplicationSummary`. React-PDF doesn't run inside React's
component tree, but the synchronous `i18n.t()` call works because
i18next is always initialized before the user can trigger a PDF
export.

```
✓ "Personal Information" / "Contact Details" / "Emergency Contact"
✓ "TempWorks Europe — Confidential" footer
```

The remaining 30 untranslated labels in `EmployeePdfDocument.tsx`
(`First Name`, `Last Name`, `Date of Birth`, etc.) are field-prop
strings on the `<F label="…">` helper. Pattern is uniform —
trivial Phase 2.I extension if desired.

### `ApplicantPdfExport.tsx` (frontend React-PDF) — deferred

23 visible literals across the entire applicant PDF (similar to the
EmployeePdfDocument structure but ~3× larger). Same `i18n.t()` lift
pattern would apply. **Deferred to Phase 2.I**: the PDF export is
backend-renderable in the long term per the Phase 4 audit
recommendation (per-locale email-template strategy already lives in
`backend/src/email/email-i18n.ts`). Translating ~50 React-PDF labels
on the frontend is a stop-gap; the consensus recommendation is to
move PDF generation to a backend endpoint that uses the same
template strategy as transactional emails.

### Backend-generated exports — out of scope

The Excel / Word / xlsx exports for applicants / candidates /
employees / vehicles all stream from backend service methods
(`employees.service.exportExcel`, `agencies.service.exportExcel`,
etc.). Per the brief — "backend-generated reports as Phase 3/backend
work" — these are documented as backend i18n work and not touched
in this phase.

---

## 5 · New translation keys

| Sub-tree | Keys | Purpose |
|---|---:|---|
| `applicants.list.*` | ~52 | ApplicantsList table headers, filters, bulk actions, promote dialog (CLDR plural) |
| `applicants.candidates.*` | ~55 | CandidatesList table headers, filters, bulk actions, convert/workflow dialogs (CLDR plural) |
| `applicants.deleteRequestsPage.*` | ~30 | CandidateDeleteRequests full body + reject modal |
| `applicants.addPage.*` | 7 | AddApplicant subtitle + agency picker |
| `agencies.list.*` | ~24 | AgenciesList filters, columns, table headers, load/empty |
| `agencies.users.*` | ~16 | AgencyUsersManagement body + table headers + approval badges + at-limit notice |
| `agencies.myProfile.*` | 1 | "not attached" notice |
| `employees.pdf.*` | 4 | EmployeePdfDocument section titles + footer |
| `employees.workHistoryTimeline.*` | ~16 | Full Add-entry dialog + empty + Created/Approved by labels |
| **Total new EN keys** | **~205** | — |

Times 5 non-EN locales = **~1,025 strings** awaiting native
translation. All key paths are stable.

---

## 6 · Locale parity strategy

`/tmp/sync_keys.mjs` (carried over from Phase 2.D, plural-variant-safe)
walked every namespace in `en/` and inserted missing keys into each
non-English locale verbatim. CLDR plural variants for ar/ru/sk are
preserved. The new `applicants.list.promoteDialog.title_one/_other`
and `applicants.candidates.workflowDialog.title_one/_other`,
`convertDialog.title_one/_other` keys land correctly.

---

## 7 · RTL polish

Touched files use logical Tailwind classes (`me-`, `ms-`, `text-end`,
`text-start`, `start-3`, `end-0`). No new directional icons added.

The `EmployeePdfDocument` is React-PDF and is locale-direction-
agnostic (same layout for all locales) — RTL would need a separate
direction prop on the document if desired. Not in scope.

---

## 8 · Quality checks

```
$ npm run i18n:check-keys
✓ All 5 target locales × 9 namespaces match English.

$ npm run i18n:check-literals
Found 922 suspicious hardcoded JSX literal(s)
  (down from 997 at end of Phase 2.G — 75-literal reduction).

$ npm run build
✓ built in ~15s
(bundle size warning unchanged; pre-existing.)
```

---

## 9 · Known limitations

1. **Scanner false positives** in `ApplicantsList.tsx`,
   `CandidatesList.tsx`, `AgenciesList.tsx` (5 total) are JS
   expressions inside template literals (`age >= 0 && age <= …`,
   `dateFrom >= from && t.date`) and one stale `Filter by status`
   placeholder that's never user-visible because the
   `SelectValue.placeholder` only displays before a value is set,
   and these selects always have a selected `__all__` sentinel.

2. **31 `confirm()` callers still pass English props.** Carried over
   from Phase 2.G — not touched in this phase.

3. **`ApplicantPdfExport.tsx` (23 literals)** deferred. Backend
   localization recommended.

4. **Dozens of detail / settings / workflow pages** still have raw
   English visible text. The literal scanner currently shows hot
   spots in `DocumentUpload.tsx` (12), `DocumentPreview.tsx` (10),
   `EmployeeCompliance.tsx` (8), `AttendanceSheet.tsx` (7),
   `AttendanceList.tsx` (6), `EditApplicant.tsx` (5),
   `EditCandidate.tsx` (5), `DocumentVerification.tsx` (4),
   `WorkflowSettingsPage.tsx`, `MaintenanceTypesList.tsx`, etc.

5. **English fallback values for ~205 new keys in non-EN locales.**
   Per the brief, English fallback is acceptable.

6. **Build still emits pre-existing 500 KB chunk warning.** Unchanged.

---

## 10 · Remaining high-impact untranslated areas

| File | Literals | Notes |
|---|---:|---|
| `components/applicants/ApplicantPdfExport.tsx` | 23 | React-PDF; same lift pattern as EmployeePdfDocument or backend localization. |
| `pages/documents/DocumentUpload.tsx` | 12 | Form body + validation. |
| `pages/documents/DocumentPreview.tsx` | 10 | Detail body labels. |
| `pages/compliance/EmployeeCompliance.tsx` | 8 | Compliance dashboard labels. |
| `pages/attendance/AttendanceSheet.tsx` | 7 | Attendance editor labels. |
| `pages/attendance/AttendanceList.tsx` | 6 | List filters + columns. |
| `pages/applicants/EditApplicant.tsx` | 5 | Edit page body. |
| `pages/applicants/EditCandidate.tsx` | 5 | Edit page body. |
| `pages/documents/DocumentVerification.tsx` | 4 | Review surface. |
| `components/applicants/ApplicantFormSteps.tsx` | 6 | All TS-signature false positives. |
| 31 `confirm()` callers | — | English title/description across detail / settings pages. |

---

## 11 · Recommended Phase 2.I scope

### Phase 2.I.1 — Documents module + EditApplicant/EditCandidate (~1.5 d)

Translate `DocumentUpload.tsx` (12), `DocumentPreview.tsx` (10),
`DocumentVerification.tsx` (4), `EditApplicant.tsx` (5),
`EditCandidate.tsx` (5). Mostly form-body and detail labels — pull
from existing `documents.*` and `applicants.{edit,candidates.edit}.*`
namespaces.

### Phase 2.I.2 — Compliance + Attendance pages (~1 d)

Translate `EmployeeCompliance.tsx` (8), `AttendanceSheet.tsx` (7),
`AttendanceList.tsx` (6). Add new `compliance.employee.*` /
`attendance.{sheet,list}.*` sub-trees if they don't already exist.

### Phase 2.I.3 — `ApplicantPdfExport` lift (~0.75 d)

Apply the same `tp(key)` wrapper pattern as
`EmployeePdfDocument.tsx`. ~50 labels to translate. **Or** flag for
backend PDF endpoint migration following the email-i18n template
pattern.

### Phase 2.I.4 — Remaining `confirm()` caller sweep (~1.5 d)

The 31 callers still backlogged from Phase 2.G in
`EmployeeProfile.tsx`, `ApplicantProfile.tsx`, `CandidateProfile.tsx`,
`WorkflowSettingsPage.tsx`, `MaintenanceTypesList.tsx`,
`MaintenanceRecordsList.tsx`, `WorkshopsList.tsx`,
`VehicleSettings.tsx`, `MaintenanceTypesSettings.tsx`,
`ReportsDashboard.tsx`, `WorkflowManagement.tsx`. Mechanical sweep;
reuse `common.confirm.*` reusable phrases.

### Phase 2.I.5 — Native translations for the cumulative ~3,500 new strings (~3-4 d)

Cumulative translator workload is now ~205 (this phase) + ~1,250
(Phase 2.G) + ~900 (Phase 2.F) + ~330 (Phase 2.E) + ~290 (Phase 2.C)
+ ~200 (Phase 2.B) = ~3,200 EN keys × 5 locales ≈ **~16,000
strings** awaiting native translation.

### Phase 2.I.6 — Delete dead code (~0.25 d)

Remove `components/workflow/StageTransition.tsx` (unused, flagged in
Phase 2.E).

### Suggested next prompt

> Implement Phase 2.I.1 + 2.I.2 of the i18n component sweep. Branch
> `claude/phase-2i-i18n-documents-compliance`. Translate the
> Documents module pages (DocumentUpload, DocumentPreview body,
> DocumentVerification), the Edit Applicant / Edit Candidate forms,
> and the EmployeeCompliance + AttendanceSheet + AttendanceList
> pages. Reuse existing `documents.*` / `applicants.*` /
> `compliance.*` / `attendance.*` namespaces and add per-page
> sub-trees only where missing. Run `npm run i18n:check-keys`,
> `npm run i18n:check-literals`, and `npm run build` before commit.
> Push to the new branch. Do not open a PR.
