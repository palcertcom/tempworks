# I18N Phase 2.A — Implementation Report

**Branch:** `claude/phase-2a-i18n-profiles`
**Scope:** Frontend-only translation of high-traffic profile/detail pages.
**Date:** 2026-05-05.

---

## 1 · Changed files

### Translation source (locale JSONs)

All 6 locales (`en`, `sk`, `de`, `ru`, `ar`, `tr`) updated for parity.

```
src/i18n/locales/en/common.json
src/i18n/locales/en/pages.json
src/i18n/locales/sk/common.json
src/i18n/locales/sk/pages.json
src/i18n/locales/de/common.json
src/i18n/locales/de/pages.json
src/i18n/locales/ru/common.json
src/i18n/locales/ru/pages.json
src/i18n/locales/ar/common.json
src/i18n/locales/ar/pages.json
src/i18n/locales/tr/common.json
src/i18n/locales/tr/pages.json
```

### Page components translated

```
src/app/pages/agencies/AgencyProfile.tsx       (full rewrite, 0 residual literals)
src/app/pages/employees/EmployeeProfile.tsx    (full rewrite, 0 residual literals)
src/app/pages/vehicles/VehicleDetail.tsx       (full rewrite, 0 residual literals)
src/app/pages/vehicles/VehicleForm.tsx         (full rewrite, 0 residual literals)
src/app/pages/applicants/ApplicantProfile.tsx  (surgical: header / tabs / toasts / confirms / dialog titles — body text retained)
src/app/pages/applicants/CandidateProfile.tsx  (surgical: same scope as ApplicantProfile)
```

### Per-file residual literal scan (target pages only)

```
ApplicantProfile.tsx : 67
CandidateProfile.tsx : 62
EmployeeProfile.tsx  : 0
AgencyProfile.tsx    : 0
VehicleDetail.tsx    : 0
VehicleForm.tsx      : 0
```

The 67/62 residuals in the two largest files are deep-tab detail row labels
(personal info table rows, application data sections, agency history table
columns). They are documented as a known carry-over below.

---

## 2 · Translated screens

| Screen | Route | Surfaces translated |
|---|---|---|
| **AgencyProfile** | `/dashboard/agencies/:id` | Header, info cards, stats, all 4 tabs (Employees / Users / Finance / Settings), settings form, all toasts (`apiError`-wrapped), max-users select, status badge via `enumLabel`. |
| **EmployeeProfile** | `/dashboard/employees/:id` | Header, photo card, all 8 tabs (Overview / Application / Documents / Attendance / Contracts / Compliance / Financial / Notes), agency-access management, document upload form, compliance days-remaining, financial profile, notes editor, all confirms + toasts. Status badge via `enumLabel('employeeStatus')`. Dates via `formatDate`. Currency via `formatCurrency`. |
| **VehicleDetail** | `/dashboard/vehicles/:id` | Header, all 4 tabs (Overview / Driver / Documents / Maintenance), driver-assign dialog (with searchable picker), document add/edit dialog, maintenance add/edit dialog (3-section), all confirms + toasts, status badges via `enumLabel('maintenanceStatus')`, mileage via `formatNumber`, cost via `formatCurrency('GBP')`, dates via `formatDate`. |
| **VehicleForm** | `/dashboard/vehicles/new` & `/:id/edit` | All 7 conditional sections (Vehicle Details / Compliance / Purchase / Insurance / Truck / Van / Car / Tanker / Refrigerated / Specialty), every field label + placeholder, validation toasts, save/cancel buttons. Fuel type via `enumLabel`. |
| **ApplicantProfile** | `/dashboard/applicants/:id` | Header (title, subtitle, back arrow with `rtl:rotate-180`), all 8 tabs, every toast wrapped in `apiError`, every confirm dialog (delete applicant, delete document, disconnect workflow). Body content (Travel & Residence panel, Languages panel, Driving panel, etc.) retained in English — see §6. |
| **CandidateProfile** | `/dashboard/candidates/:id` | Same surface as ApplicantProfile + the candidate-approval band (pending Tempworks approval) and reject-candidate confirm. Title routes via `pages:applicants.profile.candidateTitle` so the same key tree drives both screens. |

---

## 3 · New / updated namespaces

This phase deliberately reused **existing** namespaces (`common` and
`pages`) — no new top-level namespaces were added.

### `common` (extended)

| Sub-tree | New keys |
|---|---|
| `common.actions.*` | `saveChanges`, `saveAndContinue`, `remove`, `create`, `update`, `archive`, `restore`, `approve`, `reject`, `duplicate`, `copy`, `exportCsv`, `exportExcel`, `exportPdf`, `clearFilters`, `view`, `refresh`, `columns`, `selectAll`, `yes`, `no`, `upload`, `download`, `change`, `preview`, `more`, `saveAdd`, `openFullPage`, `openInNewTab` |
| `common.states.*` | `uploading`, `deleting`, `noResults`, `comingSoon`, `notImplemented`, `notAvailable`, `notProvided` |
| `common.table.*` (new sub-tree) | `rowsPerPage`, `of`, `page`, `selected_one/_zero/_two/_few/_many/_other`, `clearSelection`, `exportSelected`, `noResults` (CLDR plural variants for ar/ru/sk) |
| `common.filters.*` (new sub-tree) | `all`, `active`, `inactive`, `from`, `to`, `search`, `advancedFilters`, `clear` |
| `common.toast.*` (new sub-tree) | `created`, `updated`, `deleted`, `restored`, `archived`, `published`, `saved`, `copied`, `exportStarted`, `exportComplete`, `exportFailed`, `uploadStarted`, `uploadComplete`, `uploadFailed`, `networkOffline`, `errorGeneric`, `permissionDenied` |
| `common.form.*` (new sub-tree) | `required`, `optional`, `fieldRequired`, `selectOption`, `saving`, `saveSuccess` |

### `pages` (extended)

| Sub-tree | Notes |
|---|---|
| `pages.agencies.profile.*` | New keys for subtitle, info, stats, tabs, employees panel, users panel, settings panel, toasts. |
| `pages.employees.profile.*` | New keys for subtitle, header, quickNav, personal table, stats, agency, agencyAccess (with toasts + confirms), documents (with upload dialog + toasts), compliance (with day-count plurals), financial (banking profile), notes editor, all toasts + confirms. |
| `pages.vehicles.detail.*` | New keys for tabs, info, compliance (3 expiry rows + ExpiryCell strings), driver (assignments, dialog, toasts, confirmEnd), documents (table, dialog, toasts, confirmDelete), maintenance (3-section dialog, toasts, confirmDelete), header confirmDelete + delete toast. |
| `pages.vehicles.form.*` | Comprehensive: 10 section titles, ~80 field+placeholder pairs, 4 validation messages, 5 toasts. |
| `pages.applicants.profile.*` | Subtitle/candidateSubtitle, loading/notFound/candidateNotFound, promote keys, full tabs sub-tree (overview/application/documents/workflow/docCompliance/financial/agencyHistory/notes), 30+ toast keys (load/stage/workflow/agency/note/doc-approve/doc-reject/doc-delete/upload/delete/convert/promote/financial), 4 confirm sub-trees (delete applicant, delete candidate, disconnect, delete doc), candidateApproval sub-tree (pending band, approve/reject/confirmReject). |

---

## 4 · Helpers used (existing)

- **`apiError(err, fallback)`** — wraps every `toast.error(...)` after API
  calls in all 6 files. Backend coded errors flow through `errors.json`;
  fallback is the localized string. Replaced ~70 raw `err?.message ||
  '...'` occurrences.
- **`enumLabel(group, code)`** — replaces hand-rolled
  `status.replace(/_/g, ' ').toLowerCase()` and similar transforms.
  Applied to: `agencyStatus` (AgencyProfile), `employeeStatus`
  (EmployeeProfile, AgencyProfile employees panel), `documentStatus`
  (EmployeeProfile docs + compliance), `maintenanceStatus`
  (VehicleDetail status badges + dialog Select), `fuelType`
  (VehicleDetail info card + VehicleForm fuel-type Select).
- **`formatDate(date)`** — replaces `new
  Date(...).toLocaleDateString()` in EmployeeProfile, VehicleDetail
  (header dates, ExpiryCell, driver assignment "Since X", maintenance
  table dates), AgencyProfile (granted-on display).
- **`formatCurrency(value, ccy)`** — replaces `£${cost.toFixed(2)}` in
  VehicleDetail maintenance cost column, and the manual
  `Number().toLocaleString('en-GB', {…})` in EmployeeProfile
  financial.salaryAgreed.
- **`formatNumber(value)`** — replaces
  `value.toLocaleString()` for the mileage display in VehicleDetail.

---

## 5 · Build & i18n check results

```
$ npm run i18n:check-keys
✓ All 5 target locales × 9 namespaces match English.

$ npm run i18n:check-literals
Found 1349 suspicious hardcoded JSX literal(s)
  (down from baseline; 0 in 4 of 6 target files; 67 + 62 in the two
   profile pages remain — see §6)

$ npm run build
✓ built in ~17s
(bundle size warning unchanged; pre-existing)
```

CLDR plural variants (`_zero`, `_two`, `_few`, `_many`) added for `ar`,
`ru`, `sk` on the `common.table.selected_*` keys — script is plural-aware
and reports parity.

---

## 6 · Remaining hardcoded strings in target pages

**ApplicantProfile.tsx (~67) and CandidateProfile.tsx (~62):**

The header chrome, every tab label, every toast message, every confirm
dialog, every dialog title, and every loading/not-found message are
translated. What remains in English:

- **Overview tab body content:** Personal Information detail-row labels
  (Date of Birth, Citizenship, Job Type, Driving License panel rows,
  EU Visa fields, Languages panel rows, Work Flexibility panel,
  Documents-required hints).
- **Travel & Residence panel** rows (Passport Number, Visa Type, etc.)
  inside the detail card.
- **Convert to Employee dialog** internal field labels (Address Line 1,
  City, Country, Postal Code, License Number, Years Experience).
- **Promote to Candidate dialog** body explanation paragraphs.
- **Agency History tab** column headers and empty state.

These ~129 residual literals are deep-section detail row labels in 2000-
line files. Recommended scope for a follow-up Phase 2.B PR (see §8).

**Other target files (EmployeeProfile, AgencyProfile, VehicleDetail,
VehicleForm):** 0 residual user-visible literals per the heuristic
scanner.

**Out of scope (untouched, but visible from the target pages):**

- `ApplicantPdfExport.tsx` (PDF generation; not on-screen text).
- `ApplicationDataView.tsx` (read-only sub-component used inside the
  Application tab — defer to Phase 2.B).
- `FinancialRecordsTab.tsx` (used in Agency / Applicant / Candidate /
  Employee profiles — wide reach, ~30 literals; defer to Phase 2.B).
- `AttendanceTab.tsx`, `WorkHistoryTimeline.tsx` (used in
  EmployeeProfile — defer).
- `WhatsAppButton.tsx` (no user-visible text).

---

## 7 · Known risks

1. **Body strings in ApplicantProfile / CandidateProfile remain English.**
   With Arabic selected, the page chrome flips RTL but personal info
   field labels still read left-to-right. Visually obvious but
   functionally unobtrusive. Tracked as Phase 2.B item.
2. **CLDR plural rules.** Russian, Slovak and Arabic plural forms for
   the new `common.table.selected_*` sub-tree are seeded with reasonable
   defaults but have not been reviewed by a native speaker. Should be
   QA'd by translators before next release.
3. **`enumLabel` fallback path.** When a backend returns a status code
   not in `enums.json` (e.g. a freshly-added enum value), `enumLabel`
   falls back to the raw code. Existing helper behaviour — no change.
4. **`formatCurrency('GBP')` hardcoded** in VehicleDetail maintenance
   cost column. The previous code used `£` symbol literal; both are
   currency-locale-correct for en/sk/de/ru/tr. Arabic numerals format
   nicely via `Intl.NumberFormat`. Acceptable.
5. **VehicleDetail `dash = '—'`** is rendered as a literal string. Not
   a translation issue — em-dash is locale-neutral.
6. **`unused-vars` lint warnings (pre-existing, not from this PR).** I
   removed the `Progress` import in EmployeeProfile (was already
   unused) and silenced two state setters (`setAssignment`,
   `setAllWorkflows`) that are written-only — these were dead code
   pre-PR and didn't change behaviour.
7. **Build passes; no TypeScript errors introduced.** Bundle size
   delta: ~+8 KB gzip from the new locale chunks, well within the
   pre-existing ≥500 KB warning for the index chunk.

---

## 8 · Recommended Phase 2.B scope

Translate the body content of the two profile pages plus the four
reusable feature components that cascade into them. Concretely:

### Phase 2.B.1 — Profile body content (~3 d)

- `ApplicantProfile.tsx` — translate Overview tab body (Personal Info,
  Travel & Residence, Driving, Languages, Work Flexibility), the
  Convert dialog, the Promote dialog, and the Agency History tab.
  Estimated 67 strings + ~10 dialog strings.
- `CandidateProfile.tsx` — translate the same set of body panels.
  Estimated 62 strings.
- New keys land in `pages.applicants.profile.body.*` plus a shared
  `pages.applicants.profile.dialogs.*` sub-tree.

### Phase 2.B.2 — Reusable feature components (~3 d)

These are mounted inside the profile pages and currently render
English regardless of locale:

- `src/app/components/applicants/ApplicationDataView.tsx` (~17 lits)
- `src/app/components/applicants/ApplicantFormSteps.tsx` (~138 lits —
  the largest single hotspot in the codebase; carries the public
  `/apply` form and the Add/Edit Applicant pages).
- `src/app/components/finance/FinancialRecordsTab.tsx` (~30 lits, 14
  toasts — embedded in 4 profile pages).
- `src/app/components/employees/WorkHistoryTimeline.tsx` (~6 lits, 7
  toasts).
- `src/app/components/attendance/AttendanceTab.tsx` (~1 literal but
  6 toasts).

### Phase 2.B.3 — Apply same `apiError` toast sweep across remaining toast call-sites

The audit identifies ~70 untranslated toast invocations across the
broader page tree. This phase wraps them in `apiError(err,
t('common:toast.errorGeneric'))` for failures and switches success
toasts to `t('common:toast.<verb>')` keys. Mostly mechanical.

### Suggested next prompt

> Implement Phase 2.B.1 of the i18n profile-bodies push. Branch
> `claude/phase-2b-i18n-profile-bodies`. Translate the remaining ~67
> JSX literals in `src/app/pages/applicants/ApplicantProfile.tsx` and
> ~62 literals in `src/app/pages/applicants/CandidateProfile.tsx`. Add
> a `pages.applicants.profile.body.*` and
> `pages.applicants.profile.dialogs.*` sub-tree. Use existing helpers
> (`enumLabel` for status, `formatDate`/`formatCurrency` for values).
> Run `npm run i18n:check-keys`, `npm run i18n:check-literals`, and
> `npm run build` before commit. Push to the new branch. Do not open a
> PR.
