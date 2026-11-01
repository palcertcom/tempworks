# I18N Phase 2.J — Implementation Report

**Branch:** `claude/phase-2j-i18n-documents-employee-hotspots`
**Scope:** Frontend-only — sweep the new top hot spots surfaced
after Phase 2.I: `AddEmployee` form, `EmployeeDocumentExplorer`,
`DocumentsCompliance` body, `EditDocument`, `DocumentsDashboard`,
and finish the `ApplicantPdfExport` field-prop labels.
**Date:** 2026-05-05.

---

## 1 · Changed files

```
src/app/pages/employees/AddEmployee.tsx                     (24 → 1 ‡)
src/app/pages/documents/EmployeeDocumentExplorer.tsx        (22 → 1 ‡)
src/app/pages/documents/DocumentsCompliance.tsx             (18 → 1 ‡)
src/app/pages/documents/EditDocument.tsx                    (9 → 0 ✓)
src/app/pages/documents/DocumentsDashboard.tsx              (5 → 0 ✓)
src/app/components/applicants/ApplicantPdfExport.tsx        (~6 → 0 ✓; full field-label lift)

src/i18n/locales/en/pages.json                              (+ ~210 keys)
src/i18n/locales/{sk,de,ru,ar,tr}/pages.json                (sync — English fallback)

I18N_PHASE_2J_REPORT.md                                     (new)
```

‡ Remaining hits are template-literal expressions (`= from && t`,
`(e: React.ChangeEvent<...>`) — JS/TS code that the regex catches
as JSX text. Not user-visible.

### Per-file residual literal counts

| File | Before | After |
|---|---:|---:|
| `pages/employees/AddEmployee.tsx` | 24 | 1 (TS-signature false positive) |
| `pages/documents/EmployeeDocumentExplorer.tsx` | 22 | 1 (template-literal expr) |
| `pages/documents/DocumentsCompliance.tsx` | 18 | 1 (template-literal expr) |
| `pages/documents/EditDocument.tsx` | 9 | 0 ✓ |
| `pages/documents/DocumentsDashboard.tsx` | 5 | 0 ✓ |
| `components/applicants/ApplicantPdfExport.tsx` | ~6 | 0 ✓ (~80 field labels translated via bulk script) |

### Repo-wide literal-scanner totals

| Stage | Total |
|---|---:|
| Phase 2.I end | 838 |
| Phase 2.J end | 764 |

**74-literal reduction.** Plus all toast strings in `AddEmployee` /
`EditDocument` re-routed through `apiError(err, t(...))`.

---

## 2 · `AddEmployee.tsx` coverage

**100% complete** (24 → 1 false positive). Full form translated
under new `employees.add.*` (~52 keys):

```
✓ Page subtitle
✓ Access-denied guard via common.permissions.*
✓ 4 card titles (Personal Information / Address Information /
   Professional Information / Status & Classification)
✓ "Next Steps" sidebar card with 4 bullet items
✓ All 14 field labels with their placeholders (firstName, lastName,
   email, phone, dateOfBirth, citizenship, emergencyContact,
   emergencyPhone, streetAddress, city, postalCode, country, agency,
   licenseNumber, licenseCategory, yearsExperience, notes)
✓ "Direct hire (no agency)" sentinel
✓ Initial Status select with 5 options (Pending / Onboarding /
   Active / Inactive / On Leave)
✓ Adding…/Add Employee/Cancel buttons
✓ Success/failure toasts via apiError
```

---

## 3 · Documents module coverage

### `EmployeeDocumentExplorer.tsx` (22 → 1)

```
✓ Column-picker (Toggle columns / Show all)
✓ Loading state
✓ 5 status badges (Valid / Expiring Soon / Expired / Rejected /
   Pending) — reused documents.preview.statusBadge.* + new
   documents.explorer.expiringSoon
✓ Filter dropdowns (All Citizenships / All Agencies / All Status /
   All Statuses) — replace_all-driven for repeated occurrences
✓ Empty states (No employees found / No applicants found /
   No Employees Selected / No Applicants Selected /
   No documents found for selected employees /
   No documents found for selected applicants)
✓ Date-range "Expiry from" labels
✓ "Expiring Soon" SelectItem entries (replace_all-driven)
```

The `ColumnPicker<K>` generic helper in this file is now i18n-aware
via its own `useTranslation('pages')` hook.

### `DocumentsCompliance.tsx` body (18 → 1)

```
✓ Compliance status badge (Compliant / At Risk / Pending / Non-Compliant)
   with 4-key sub-tree
✓ Filter Documents card title
✓ All Statuses / All Types / All Entities / All Compliance filter
   placeholders + sentinel SelectItems (replace_all-driven)
✓ Date-range labels (Expiry from / Issue from)
✓ Toggle columns / Show all panel labels
✓ Reject dialog: "Rejecting:" prefix + "Rejection Reason *" label
✓ Loading + empty table states
✓ "↩ renewal" inline label on chained renewal documents
✓ "Compliance Alerts" amber banner title
```

### `EditDocument.tsx` (9 → 0)

Full form translation under new `documents.edit.*` (~18 keys):
- Loading state via `common.states.loading`
- Page title + subtitle ("Update document metadata")
- "Document Information" card title
- 7 field labels + 4 placeholders (Document Name *, Document Type,
  "— Select type —", Issue Date, Expiry Date, Document Number, Issuer,
  Notes)
- Saving…/Save Changes/Cancel buttons
- Load failure + update success/failure toasts via `apiError`

### `DocumentsDashboard.tsx` (5 → 0)

```
✓ Loading state via common.states.loading
✓ 4 stat-card titles (Total Documents / Valid / Expiring Soon /
   Pending Review)
✓ Document Categories + Recent Documents section titles
✓ "{{count}} document(s)" CLDR-plural-aware count badge
✓ All 6 table headers
✓ Empty state ("No documents found.") + "Upload one" link
✓ View action button
✓ Load-failure toast
```

---

## 4 · `ApplicantPdfExport.tsx` final coverage

**100% complete.** All ~80 `<F label="…">` and `<FF label="…">`
prop strings now go through `tp('field.<key>')`. Applied via a
`/tmp/replace_pdf_labels.mjs` helper (untracked, similar to the
`/tmp/sync_keys.mjs` pattern):

```js
for (const [label, key] of Object.entries(labels)) {
  const re = new RegExp(`label="${escaped}"`, 'g');
  src = src.replace(re, `label={tp('field.${key}')}`);
}
src = src.replace(/'No Expiry'/g, `tp('field.noExpiry')`);
```

### New `applicants.applicantPdf.field.*` sub-tree (~55 keys)

Maps every distinct field label in the PDF to a stable key:

```
firstName, lastName, middleName, dateOfBirth, gender, citizenship,
countryOfBirth, cityOfBirth, jobCategory, preferredStartDate,
availability, willingToRelocate, preferredLocations,
salaryExpectation, email, phone, address, city, postalCode, country,
name, relationship, passportNumber, issuingCountry, issueDate,
expiryDate, expiry, idNumber, type, number, purposeOfIssue,
permitNumber, dateOfIssue, countryOfIssue, homeCriminalRecord,
euCriminalRecord, level, institution, fieldOfStudy, startDate,
endDate, degreeCertificate, jobTitle, company, responsibilities,
references, firstAidCert, firstAidExpiry, toolsEquipment,
licenseNumber, howDidYouHear, additionalNotes, informationDeclaration,
dataProcessingConsent, backgroundDeclaration, noExpiry
```

The PDF section titles (translated in Phase 2.I) plus these field
labels mean the full PDF document is now language-aware. The export
remains a frontend-rendered React-PDF blob; the backend-template
recommendation from earlier reports still stands as a future
consolidation path but is no longer blocking i18n coverage.

---

## 5 · `confirm()` callers

This phase did not target additional `confirm()` callers beyond the
ones already in the touched files (none of the 5 target files have
new `confirm()` invocations). The 31-caller backlog from Phase 2.G/H
remains for Phase 2.K.

---

## 6 · New translation keys

| Sub-tree | Keys | Purpose |
|---|---:|---|
| `employees.add.*` | ~52 | Full Add Employee form (cards, fields, placeholders, status options, validation, toasts) |
| `documents.explorer.*` (extension) | ~18 | Column picker, filters, empty states, expiring-soon badge |
| `documents.compliance.*` (extension) | ~22 | Compliance badges (4), filter placeholders (4), date ranges, column picker, reject dialog, loading + empty + renewal-suffix |
| `documents.edit.*` (extension) | ~18 | Full form |
| `documents.dashboard.*` (extension) | ~17 | Stat cards, sections, table headers, empty state, CLDR-plural count |
| `applicants.applicantPdf.field.*` | ~55 | All PDF field-prop labels |
| **Total new EN keys** | **~182** | — |

Times 5 non-EN locales = **~910 strings** awaiting native
translation. Cumulative since Phase 2.A is now ~3,500 EN keys ×
5 locales ≈ **~17,500 strings**.

---

## 7 · Locale parity strategy

`/tmp/sync_keys.mjs` walked every namespace in `en/` and inserted
missing keys into each non-English locale verbatim. CLDR plural
variants for ar/ru/sk preserved. `documents.dashboard.categoryCount_one/_other`
plural keys land correctly.

---

## 8 · RTL polish

Touched files use logical Tailwind classes throughout. No new
directional icons introduced. The `EmployeeDocumentExplorer`
column-picker and date-range filters use `start-`/`end-` already.
The PDF document is locale-direction-agnostic (same layout) — full
RTL on the PDF would need a separate document layout pass; out of
scope.

---

## 9 · Quality checks

```
$ npm run i18n:check-keys
✓ All 5 target locales × 9 namespaces match English.

$ npm run i18n:check-literals
Found 764 suspicious hardcoded JSX literal(s)
  (down from 838 at end of Phase 2.I — 74-literal reduction).

$ npm run build
✓ built in ~26s
(bundle size warning unchanged; pre-existing.)
```

---

## 10 · Known limitations

1. **3 scanner false positives** carried in `AddEmployee` (1),
   `EmployeeDocumentExplorer` (1), `DocumentsCompliance` (1) — JS/TS
   template-literal expressions. Not user-visible.

2. **31 `confirm()` callers still pass English props.** Carried over
   since Phase 2.G. Pages: `EmployeeProfile`, `ApplicantProfile`,
   `CandidateProfile`, `WorkflowSettingsPage`, `MaintenanceTypesList`,
   `MaintenanceRecordsList`, `WorkshopsList`, `VehicleSettings`,
   `MaintenanceTypesSettings`, `ReportsDashboard`,
   `WorkflowManagement`. Carry-over to Phase 2.K.

3. **New literal-scanner hot spots surfaced** by removing this
   phase's targets:
   - `pages/employees/EditEmployee.tsx` (27)
   - `pages/employees/EmployeeComplianceTimeline.tsx` (17)
   - `pages/employees/EmployeeTrainingHistory.tsx` (12)
   - `pages/employees/EmployeePerformanceReview.tsx` (12)
   - `pages/employees/EmployeeCertifications.tsx` (8)

4. **`StageTransition.tsx` (4 literals) is dead code** — flagged
   Phase 2.E for removal.

5. **English fallback values for ~182 new keys.** Per the brief.

6. **Build still emits pre-existing 500 KB chunk warning.** Unchanged.

---

## 11 · Remaining high-impact untranslated areas

Sorted by literal-scanner count:

| File | Literals | Notes |
|---|---:|---|
| `pages/employees/EditEmployee.tsx` | 27 | Full edit form. Likely mirrors AddEmployee shape. |
| `pages/employees/EmployeeComplianceTimeline.tsx` | 17 | Per-employee timeline view. |
| `pages/employees/EmployeeTrainingHistory.tsx` | 12 | Training records. |
| `pages/employees/EmployeePerformanceReview.tsx` | 12 | Performance review form. |
| `pages/employees/EmployeeCertifications.tsx` | 8 | Certifications list. |
| `components/applicants/ApplicantFormSteps.tsx` | 6 | TS-signature false positives. |
| `components/workflow/StageTransition.tsx` | 4 | **Dead code**. |
| 31 `confirm()` callers | — | English title/description across detail / settings pages. |

---

## 12 · Recommended Phase 2.K scope

### Phase 2.K.1 — Employee detail/edit pages (~2 d)

Translate:
- `EditEmployee.tsx` (27) — likely mirrors AddEmployee structure
- `EmployeeComplianceTimeline.tsx` (17)
- `EmployeeTrainingHistory.tsx` (12)
- `EmployeePerformanceReview.tsx` (12)
- `EmployeeCertifications.tsx` (8)

Total ~76 visible-text literals across the 5 employee detail pages.

### Phase 2.K.2 — `confirm()` caller sweep (~1.5 d)

The 31 callers backlogged from Phase 2.G/H/I/J. Pattern is
mechanical with `common.confirm.*` reusable phrases.

### Phase 2.K.3 — Native translations (~3-4 d)

Cumulative translator workload is ~3,500 EN keys × 5 locales ≈
~17,500 strings.

### Phase 2.K.4 — Delete dead code (~0.25 d)

Remove `components/workflow/StageTransition.tsx`.

### Suggested next prompt

> Implement Phase 2.K.1 + 2.K.2 of the i18n component sweep. Branch
> `claude/phase-2k-i18n-employee-details-confirms`. Translate the
> EditEmployee form + 4 employee detail pages
> (EmployeeComplianceTimeline, EmployeeTrainingHistory,
> EmployeePerformanceReview, EmployeeCertifications), and complete
> the 31 remaining `confirm()` call sites listed in
> I18N_PHASE_2J_REPORT.md §10. Reuse existing `employees.*` /
> `compliance.*` namespaces and the `common.confirm.*` reusable
> phrases. Run `npm run i18n:check-keys`, `npm run i18n:check-literals`,
> and `npm run build` before commit. Push to the new branch. Do not
> open a PR.
