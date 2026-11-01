# I18N Phase 2.G — Implementation Report

**Branch:** `claude/phase-2g-i18n-modals-tables`
**Scope:** Frontend-only — close out the FinancialRecordsTab modals,
sweep ApplicationDataView (full read-only viewer), translate the
EditAgency form body, and continue the `confirm()` caller sweep on
high-traffic destructive flows.
**Date:** 2026-05-05.

---

## 1 · Changed files

```
src/app/components/finance/FinancialRecordsTab.tsx       (Add/Edit + Status modals + history + StatusBadge — 22 → 0 literals)
src/app/components/applicants/ApplicationDataView.tsx    (full viewer — 17 → 0 literals)
src/app/pages/agencies/EditAgency.tsx                    (full form body + doc-upload section — ~30 literals → 0)
src/app/pages/applicants/CandidateDeleteRequests.tsx     (approve/reject confirm + 4 toasts)
src/app/pages/users/EditUser.tsx                         (reset-password confirm + 8 toast paths + access-denied guard)
src/app/pages/documents/DocumentPreview.tsx              (delete confirm + 6 toasts)
src/app/pages/documents/DocumentsCompliance.tsx          (delete confirm + 1 toast)
src/app/pages/applicants/AddApplicant.tsx                (discard-draft confirm + 1 toast)

src/i18n/locales/en/common.json                          (+ confirm.deleteDocument* reusable phrases)
src/i18n/locales/en/pages.json                           (+ ~210 keys across applicants.applicationView,
                                                           agencies.edit, finance.tab.{modal,statusModal,history,
                                                           statusBadge,footerLegend}, users.edit,
                                                           documents.preview, applicants.addPage,
                                                           applicants.deleteRequestsPage)
src/i18n/locales/{sk,de,ru,ar,tr}/{common,pages}.json    (sync — English fallback)

I18N_PHASE_2G_REPORT.md                                  (new)
```

### Per-file residual literal counts

| File | Before | After |
|---|---:|---:|
| `components/finance/FinancialRecordsTab.tsx` | 22 | 0 ✓ (only 2 scanner false-positives in template-literal expressions) |
| `components/applicants/ApplicationDataView.tsx` | 17 | 0 ✓ |
| `pages/agencies/EditAgency.tsx` | ~30 | 0 ✓ |
| `pages/applicants/CandidateDeleteRequests.tsx` | 9 | 9 † |
| `pages/users/EditUser.tsx` | 0 visible-text + 8 raw toasts | 0 raw |
| `pages/documents/DocumentPreview.tsx` | 0 visible-text + 6 raw toasts | 0 raw |
| `pages/documents/DocumentsCompliance.tsx` | 0 visible-text + 1 raw toast | 0 raw |
| `pages/applicants/AddApplicant.tsx` | 0 visible-text + 1 raw toast | 0 raw |

† Remaining `CandidateDeleteRequests.tsx` literals are status filter
labels and column headers — out of scope for this phase's
confirm-flow focus.

### Repo-wide literal-scanner totals

| Stage | Total |
|---|---:|
| Phase 2.F end | 1056 |
| Phase 2.G end | 997 |

**59-literal reduction** in this phase. Plus ~30 raw English toast
strings (uncaught by the scanner) re-routed through `t(...)` and
`apiError(err, t(...))`.

---

## 2 · Finance modal coverage

Phase 2.F left the FinancialRecordsTab modals untouched (~22 literals).
This phase translates **everything** outside of the 2 scanner-noise
template-literal hits:

### Add / Edit Transaction modal (~14 labels, 4 placeholders, 8 helper texts)

```
✓ Modal title (New Transaction / Edit Transaction)
✓ Transaction Date & Time, Currency, Transaction Type, Description fields
✓ Description help line
✓ Company Disbursed Amount (Credit) — including all 3 lock-state help texts
✓ Employee/Agency Paid (informational) — including 2 lock-state help texts
✓ Deducted Amount (Debit) — locked panel + "Recorded on…/Payroll ref…/admin revert" copy
✓ Payment Method + Paid By (staff) selects — both with "— Not specified —" sentinel and "Select…" placeholder
✓ Internal Notes input + 2-line help
✓ Attachments header + count badge ("{{count}} queued") + "Add file" button
✓ Empty-state ("No files attached. Click 'Add file'…")
✓ Save Changes / Create Record / Saving… / Cancel buttons
```

### Status (Deduction) modal (~10 keys)

```
✓ Title (Add Deduction / Add Another Deduction)
✓ Recap rows: Transaction / Original Amount / Already Deducted / Remaining / Description
✓ Deduction Amount input + max-≤-remaining help (with currency-formatted interpolation)
✓ Deduction Date + Payroll Reference fields + placeholder
✓ Confirm Deduction / Saving… / Cancel buttons
```

### Auxiliary surfaces

```
✓ StatusBadge (Deducted / Partial / Pending) — now uses useTranslation('pages')
✓ HistoryEntry timeline labels — 8 friendly verbs (Created transaction, Updated fields,
   Changed status, Added/Removed deduction, Attached file, Removed attachment, Deleted)
   + "System" fallback for missing user
✓ Totals footer "Totals" label + 4-segment legend (Credit (↑) = company disbursed amount, …)
✓ Multi-attachment success toast ("{{count}} attachment(s) uploaded")
✓ Status-modal "fully deducted" / "partial deduction added" success toasts
```

The FinancialRecordsTab is now **fully localized** for visible UI. Two
scanner hits remain (lines 686 & 914) — both are JS expressions
inside template literals (`runningBalance > 0 ? 'text-emerald-700'
…`) that the regex picks up as if they were JSX text. Not user-visible.

---

## 3 · `ApplicationDataView` coverage

The shared read-only application viewer is mounted in the Application
tab of ApplicantProfile, CandidateProfile, and EmployeeProfile. **17
flagged literals → 0**, plus translation of every other label that the
scanner missed (deeply nested `Field`-prop strings).

### New `applicants.applicationView.*` namespace (~110 keys)

| Sub-tree | Keys |
|---|---:|
| `empty`, `submittedBy`, `yes`, `no` | 4 |
| `sections.*` | 14 (Personal, Addresses, Contact, ID & Legal, Driving Licence/Experience, Education, Work Experience, Languages, Skills, First Aid & Tools, Work Preferences, Additional Notes, Declarations) |
| `subsections.*` | 13 (Permanent/Current Address, same-as-permanent, Lived Abroad, Passport, National ID, EU Visa/Residence/Work Permit, Criminal Records, Professional Qualifications, Reference) |
| `labels.*` | ~80 (every `Field label="…"` prop in the file) |

### Refactor pattern

```tsx
// before
<Field label="Date of Birth" value={ad.dateOfBirth} />
const yn = (v) => v === 'yes' ? 'Yes' : v === 'no' ? 'No' : undefined;
const expiry = (d, n) => n ? 'No Expiry' : (d || undefined);

// after
const { t } = useTranslation('pages');
<Field label={t('applicants.applicationView.labels.dateOfBirth')} value={ad.dateOfBirth} />
const yn = (v) => v === 'yes' ? tv('yes') : v === 'no' ? tv('no') : undefined;
const expiry = (d, n) => n ? tv('labels.noExpiry') : (d || undefined);
```

A small `tv(key, params)` helper at module scope wraps `i18n.t(...)`
for use in the `yn` / `expiry` utility functions, mirroring the `tf`
pattern already used in `ApplicantFormSteps.tsx`.

### Interpolation-aware fields

```tsx
{q.issueDate && t('labels.issuedPrefix', { date: q.issueDate })}     // "Issued 2024-03-15"
{l.speakingLevel && t('labels.speakingPrefix', { level: l.speakingLevel })}  // "Speaking: B1"
{ad.otherBrand && t('labels.otherPrefix', { name: ad.otherBrand })}  // "Other: Volvo"
```

Replaces the inline ` `Issued ${date}` ` / ` `Speaking: ${level}` `
patterns so word order can flip in RTL / non-EN locales.

---

## 4 · `EditAgency.tsx` form body coverage

**100% complete** (~30 literals → 0). Mirrors the AddAgency Phase 2.F
work; reuses `agencies.add.*` keys for shared field labels (firstName,
country, status, addressLine1, etc.) and adds `agencies.edit.*` for
edit-specific copy:

```
✓ Page subtitle ("Update agency information")
✓ Logo card: "Upload logo" / "Replace logo" / "Uploading…" / 5MB help
✓ Tenancy Scope card (System Admin only): toggle label + 3-line help
✓ Documents card: empty state, "Document Type" select with placeholder,
   "Document Name" + "Optional — defaults to file name" placeholder,
   "Upload" / "Uploading…" button, "Files are stored through the shared
   Documents module…" help
✓ Document row " · expires {{date}}" interpolation
✓ Document delete confirmation dialog ("Remove document?" / 
   "\"{{name}}\" will be removed from this agency.")
✓ All 7 validation toasts reuse agencies.add.validation.* keys
✓ Logo upload toasts (Logo updated / Logo upload failed)
✓ Document CRUD toasts (uploaded / removed / failed)
✓ Submit: Save Changes / Saving… / Cancel
✓ Access-denied guard now uses common.permissions.{accessDenied,noPermission}
✓ Loading state uses common.states.loading
```

The Status select reuses the same `common.filters.{active,inactive}` +
inline `'Suspended'` defaultValue as AddAgency.

---

## 5 · `confirm()` callers translated

Phase 2.F translated 9 of the 46 `confirm()` callers; this phase
translates **6 more** in user-visible destructive flows:

| Page | Action | Keys |
|---|---|---|
| `EditAgency` | Remove document | `agencies.edit.removeDocTitle/Body` + `actions.remove` |
| `CandidateDeleteRequests` | Approve delete request | `applicants.deleteRequestsPage.approveTitle/Body/Confirm` |
| `EditUser` | Send password reset email | `users.edit.resetTitle/Body/Confirm` |
| `DocumentPreview` | Delete document | `common.confirm.deleteDocumentTitle/Body` + `actions.delete` |
| `DocumentsCompliance` | Delete document | `common.confirm.deleteDocumentTitle/Body` (named variant) + `actions.delete` |
| `AddApplicant` | Discard saved draft | `applicants.addPage.discardTitle/Body/Confirm` |

Two reusable `common.confirm.deleteDocument*` keys
(`Title`, `BodyDefault`, `BodyNamed`) cover both DocumentPreview and
DocumentsCompliance — a single key tree usable across any
delete-document caller.

### Remaining untouched `confirm()` callers (Phase 2.H backlog)

```
src/app/components/employees/WorkHistoryTimeline.tsx       (×2)
src/app/pages/employees/EmployeeProfile.tsx                (multiple sites)
src/app/pages/applicants/ApplicantProfile.tsx              (multiple)
src/app/pages/applicants/CandidateProfile.tsx              (multiple)
src/app/pages/pipelines/WorkflowSettingsPage.tsx
src/app/pages/workflow/WorkflowManagement.tsx
src/app/pages/reports/ReportsDashboard.tsx
src/app/pages/vehicles/MaintenanceTypesList.tsx
src/app/pages/vehicles/MaintenanceRecordsList.tsx
src/app/pages/vehicles/WorkshopsList.tsx
src/app/pages/settings/VehicleSettings.tsx
src/app/pages/settings/MaintenanceTypesSettings.tsx
+ ~17 others
```

~31 callers remain. The `common.confirm.*` reusable phrases added in
Phase 2.F (and extended this phase with `deleteDocument*`) make the
remaining work mechanical.

---

## 6 · New translation keys

| Sub-tree | Keys | Purpose |
|---|---:|---|
| `common.confirm.deleteDocument*` | 3 | Reusable delete-document phrasing |
| `pages.applicants.applicationView.*` | ~110 | Full read-only viewer (sections + labels + helpers) |
| `pages.agencies.edit.*` | ~32 | EditAgency form body copy + doc-upload section + remove-doc confirm |
| `pages.finance.tab.modal.*` | ~30 | Add/Edit Transaction modal |
| `pages.finance.tab.statusModal.*` | ~13 | Status (Deduction) modal |
| `pages.finance.tab.history.*` | 10 | History timeline (8 action verbs + "System" + 2 states) |
| `pages.finance.tab.statusBadge.*` | 3 | Deducted / Partial / Pending |
| `pages.finance.tab.footerLegend.*` | 8 | Credit/Debit/Emp-Agency/Balance legend (def + descr) |
| `pages.finance.tab.totals` + 2 toast keys | 3 | Totals footer + plural attachment toast + 2 deduction success toasts |
| `pages.users.edit.*` | 16 | Permissions / unlock / reset-password / activation flows |
| `pages.documents.preview.*` | 8 | Document preview approve/reject/delete + not-found |
| `pages.documents.compliancePage.*` | 2 | Compliance page delete success/failure |
| `pages.applicants.addPage.*` | 4 | Discard saved draft flow |
| `pages.applicants.deleteRequestsPage.*` | 8 | Delete-request review flow |
| **Total new EN keys** | **~250** | — |

Times 5 non-EN locales = **~1,250 strings** awaiting native
translation. All key paths are stable.

---

## 7 · Locale parity strategy

`/tmp/sync_keys.mjs` (carried over from Phase 2.D, plural-variant-safe)
walked every namespace in `en/` and inserted missing keys into each
non-English locale verbatim, preserving existing translations and CLDR
plural variants for ar/ru/sk.

---

## 8 · RTL polish

No new directional icons or layouts were added. The
ApplicationDataView uses logical Tailwind classes throughout (`me-`,
`ms-`, `text-end`). The EditAgency document-row layout is
flex-based with `gap-3`; flips correctly. The FinancialRecordsTab
modals already used logical classes from prior phases.

---

## 9 · Quality checks

```
$ npm run i18n:check-keys
✓ All 5 target locales × 9 namespaces match English.

$ npm run i18n:check-literals
Found 997 suspicious hardcoded JSX literal(s)
  (down from 1056 at end of Phase 2.F — 59-literal reduction).

$ npm run build
✓ built in ~24s
(bundle size warning unchanged; pre-existing.)
```

---

## 10 · Known limitations

1. **2 scanner false-positives in `FinancialRecordsTab.tsx`** at lines
   686 and 914 (JS expressions inside template literals that match the
   `>...<` regex). Not user-visible.

2. **31 `confirm()` callers still pass English props.** Pattern is
   uniform — pull `title` / `description` from each page's namespace
   plus the reusable `common.confirm.*` phrases. ~1 day of mechanical
   work in Phase 2.H.

3. **~300 raw English toasts in untouched files.** Phases 2.A–2.G
   converted ~110 of them; the rest live in detail-page sub-actions
   (employee profile workflow moves, document expiry resends, vehicle
   maintenance flows, etc.).

4. **Bulk-action partial-failure warning toasts** in the list pages
   (e.g. *"Applied to X, failed for Y (first error: …)"*) remain in
   English — they concatenate a backend error message with localized
   prefixes and would need an interpolation-safe formatter.

5. **`SUSPENDED` agency status** still uses an inline English
   `defaultValue: 'Suspended'`. Trivial Phase 2.H fix-up — extend
   `common.filters.*` or add `enums.agencyStatus.SUSPENDED`.

6. **`AgenciesList.tsx` (9), `AgencyUsersManagement.tsx` (5),
   `CandidateDeleteRequests.tsx` (9)** still report literals — page
   bodies / table headers / status filter chips. Phase 2.H scope.

7. **English fallback values for ~250 new keys in non-EN locales.**
   Per the brief, English fallback is acceptable. The script-driven
   sync inserted English values into `sk/de/ru/ar/tr` for the new
   keys.

8. **Build still emits pre-existing 500 KB chunk warning.** Unchanged.

---

## 11 · Remaining high-impact untranslated areas

| File | Literals | Notes |
|---|---:|---|
| `components/applicants/ApplicantPdfExport.tsx` | 23 | PDF export labels — print-only artifact. Backend-localization candidate. |
| `pages/applicants/ApplicantsList.tsx` | 19 | Table column headers + filter chips + status labels. |
| `pages/applicants/CandidateDeleteRequests.tsx` | 9 | Page header + status filter + table columns. |
| `pages/agencies/AgenciesList.tsx` | 9 | Table column headers. |
| `pages/applicants/CandidatesList.tsx` | 6 | Table column headers + filter chips. |
| `components/employees/WorkHistoryTimeline.tsx` | 6 | Embedded in EmployeeProfile. |
| `components/applicants/ApplicantFormSteps.tsx` | 6 | TS-signature false positives (Phase 2.C/D). |
| `pages/agencies/AgencyUsersManagement.tsx` | 5 | Page body + column headers. |
| `pages/applicants/AddApplicant.tsx` | 4 | Stepper labels + status banner. |
| `components/workflow/StageTransition.tsx` | 4 | **Dead code** — flagged Phase 2.E for removal. |
| `components/employees/EmployeePdfDocument.tsx` | 4 | PDF export labels. |
| 31 `confirm()` callers | — | English title/description across detail / settings pages. |

---

## 12 · Recommended Phase 2.H scope

### Phase 2.H.1 — Remaining `confirm()` caller sweep (~1.5 d)

Translate the 31 remaining `confirm()` call sites listed in §5.
Mostly mechanical: pull `title` / `description` / `confirmText` from
each page's existing namespace + new
`common.confirm.{archive,restore,approve,reject,remove,revoke}` keys.
Hot spots: EmployeeProfile / ApplicantProfile / CandidateProfile each
own ≥3 destructive sub-actions.

### Phase 2.H.2 — High-impact list-page table headers (~1 d)

`ApplicantsList.tsx` (19), `CandidatesList.tsx` (6), `AgenciesList.tsx`
(9), `AgencyUsersManagement.tsx` (5), `CandidateDeleteRequests.tsx`
(9), `AddApplicant.tsx` (4) — all visible-text literals are table
column headers, status filter chips, and stepper labels. ~52 strings.
Add `<page>.list.columns.*` and `<page>.list.statusFilter.*` sub-trees
where missing.

### Phase 2.H.3 — `ApplicantPdfExport` + `EmployeePdfDocument` (~1 d)

The two PDF builders carry ~27 visible literals between them. Two
options: (a) thread `t()` through their helpers (frontend), or
(b) move PDF rendering to a backend endpoint with per-locale templates
(matches the email-templates strategy from Phase 4 backend work). The
audit recommends option (b) for consistency with email i18n.

### Phase 2.H.4 — Native translations for the ~1,250 new strings (~3 d)

Replace English fallback values in `sk/de/ru/ar/tr` for the keys
introduced in Phase 2.E + 2.F + 2.G. Cumulative translator workload
is ~1,250 + ~900 + ~330 = ~2,480 strings × 5 locales = ~12,400
strings. Key paths are stable; no TSX changes needed.

### Phase 2.H.5 — Toast sweep across detail pages (~1.5 d)

~300 raw English toasts remain in untouched pages. Pattern is uniform:
`apiError(err, t(...))` for the catch branch, `t(...)` for the success
branch.

### Phase 2.H.6 — Delete dead code (~0.25 d)

Remove `components/workflow/StageTransition.tsx` (unused, flagged in
Phase 2.E).

### Suggested next prompt

> Implement Phase 2.H.1 + 2.H.2 of the i18n component sweep. Branch
> `claude/phase-2h-i18n-confirms-tables`. Translate the 31 remaining
> `confirm()` call sites listed in I18N_PHASE_2G_REPORT.md §5 and the
> ~52 visible-text literals across ApplicantsList / CandidatesList /
> AgenciesList / AgencyUsersManagement / CandidateDeleteRequests /
> AddApplicant table column headers + status filter chips. Reuse
> existing per-page namespaces and the `common.confirm.*` reusable
> phrases. Run `npm run i18n:check-keys`, `npm run i18n:check-literals`,
> and `npm run build` before commit. Push to the new branch. Do not
> open a PR.
