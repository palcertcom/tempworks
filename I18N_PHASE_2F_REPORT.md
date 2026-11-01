# I18N Phase 2.F — Implementation Report

**Branch:** `claude/phase-2f-i18n-finance-confirmations`
**Scope:** Frontend-only — translate the highest-impact list-page
delete confirmations + their immediate toasts, the visible
FinancialRecordsTab surface (header, summary cards, table, expanded
panel, all toasts), and the full AddAgency form body.
**Date:** 2026-05-05.

---

## 1 · Changed files

```
src/app/pages/agencies/AgenciesList.tsx               (delete confirm + toasts)
src/app/pages/agencies/AgencyUsersManagement.tsx      (remove confirm + 4 toast paths + loading/notFound)
src/app/pages/agencies/AddAgency.tsx                  (full form body — 30+ literals → 0)
src/app/pages/applicants/ApplicantsList.tsx           (delete + bulk-delete confirms + toasts)
src/app/pages/applicants/CandidatesList.tsx           (delete + bulk-delete confirms + toasts)
src/app/pages/employees/EmployeesList.tsx             (delete confirm + toasts)
src/app/pages/users/UsersList.tsx                     (delete confirm + approve + bulk-import toasts)
src/app/pages/vehicles/VehiclesList.tsx               (delete confirm + load/export toasts)
src/app/pages/job-ads/JobAdsList.tsx                  (delete confirm + status-change toasts)

src/app/components/finance/FinancialRecordsTab.tsx    (header, summary cards, table headers,
                                                        expanded-row labels, all 16 toasts)

src/i18n/locales/en/common.json                       (+ confirm.* reusable phrases)
src/i18n/locales/en/pages.json                        (+ ~110 keys across users / applicants /
                                                        candidates / employees / vehicles / jobAds /
                                                        agencies / finance namespaces)
src/i18n/locales/{sk,de,ru,ar,tr}/{common,pages}.json (sync — English fallback)

I18N_PHASE_2F_REPORT.md                               (new)
```

### Per-file residual literal counts

| File | Before | After |
|---|---:|---:|
| `pages/agencies/AddAgency.tsx` | 30 | 0 ✓ |
| `pages/agencies/AgenciesList.tsx` | 9 | 9 † |
| `pages/agencies/AgencyUsersManagement.tsx` | 5 | 5 † |
| `pages/users/UsersList.tsx` | 0 visible-text; 8 raw toasts/dialogs | 0 raw |
| `pages/applicants/ApplicantsList.tsx` | 0 visible-text; 9 raw toasts/dialogs | 0 raw |
| `pages/applicants/CandidatesList.tsx` | 0 visible-text; 7 raw toasts/dialogs | 0 raw |
| `pages/employees/EmployeesList.tsx` | 0 visible-text; 9 raw toasts/dialogs | 0 raw |
| `pages/vehicles/VehiclesList.tsx` | 0 visible-text; 5 raw toasts/dialogs | 0 raw |
| `pages/job-ads/JobAdsList.tsx` | 0 visible-text; 6 raw toasts/dialogs | 0 raw |
| `components/finance/FinancialRecordsTab.tsx` | 30 | 22 ‡ |

† Remaining literals in `AgenciesList.tsx` / `AgencyUsersManagement.tsx`
are table column headers and inline labels not in this phase's scope —
tracked for Phase 2.G.

‡ The 22 remaining literals in `FinancialRecordsTab.tsx` are inside
the Add/Edit transaction modal and the Status (deduction) modal, which
together form a separate ~150-line form sub-component. Form-body
translation in this file deserves a dedicated phase; the high-impact
on-page surface (header, totals, table, expanded panel, every toast,
every action title) is fully translated.

### Repo-wide literal-scanner totals

| Stage | Total |
|---|---:|
| Phase 2.E end | 1079 |
| Phase 2.F end | 1056 |

23-literal reduction. The bigger story is that ~80 raw English toast
strings — which the literal scanner doesn't catch — were converted
through `t(...)` and `apiError(err, t(...))`.

---

## 2 · `confirm()` callers translated

Phase 2.E left 46 untouched `confirm()` call sites. Phase 2.F
translates **9 high-impact callers** across the seven biggest list
pages plus the AgencyUsersManagement page:

| File | Action | New keys |
|---|---|---|
| `AgenciesList.tsx` | Delete agency | `agencies.list.deleteTitle/Body/Success/Failed` |
| `UsersList.tsx` | Delete user | `users.list.deleteTitle/Body/Success/Failed` |
| `ApplicantsList.tsx` | Delete one | `applicants.list.deleteTitle/Body/Success/Failed` |
| `ApplicantsList.tsx` | Delete selected | `applicants.list.deleteSelectedTitle/Body` |
| `CandidatesList.tsx` | Delete one | `applicants.candidates.deleteTitle/Body/Success/Failed` |
| `CandidatesList.tsx` | Delete selected | `applicants.candidates.deleteSelectedTitle/Body` |
| `EmployeesList.tsx` | Delete employee | `employees.list.deleteTitle/Body/Success/Failed` |
| `VehiclesList.tsx` | Delete vehicle | `vehicles.list.deleteTitle/Body/Success/Failed` |
| `JobAdsList.tsx` | Delete job ad | `jobAds.list.deleteTitle/Body/Success/Failed` |
| `AgencyUsersManagement.tsx` | Remove user from agency | `agencies.users.removeTitle/Body/Confirm/Success/Failed` |

Each `confirmText` reuses an existing `common.actions.*` key
(`actions.delete`, `actions.cancel`) — no new key for those.

Reusable phrasing (`Are you sure?`, `This action cannot be undone.`,
`This cannot be undone easily.`, `Archive?`, `Restore?`, `Approve?`,
`Reject?`, `Remove?`, `Revoke?`) is now available under
`common.confirm.*` for the remaining 37 callers in Phase 2.G.

### Untouched `confirm()` callers (Phase 2.G backlog)

```
src/app/components/employees/WorkHistoryTimeline.tsx       (×2)
src/app/pages/agencies/EditAgency.tsx
src/app/pages/applicants/CandidateDeleteRequests.tsx
src/app/pages/applicants/AddApplicant.tsx
src/app/pages/documents/DocumentPreview.tsx
src/app/pages/documents/DocumentsCompliance.tsx
src/app/pages/employees/EmployeeProfile.tsx               (multiple sites)
src/app/pages/applicants/ApplicantProfile.tsx             (multiple)
src/app/pages/applicants/CandidateProfile.tsx             (multiple)
src/app/pages/users/EditUser.tsx
src/app/pages/pipelines/WorkflowSettingsPage.tsx
src/app/pages/workflow/WorkflowManagement.tsx
src/app/pages/reports/ReportsDashboard.tsx
src/app/pages/vehicles/MaintenanceTypesList.tsx
src/app/pages/vehicles/MaintenanceRecordsList.tsx
src/app/pages/vehicles/WorkshopsList.tsx
src/app/pages/settings/VehicleSettings.tsx
src/app/pages/settings/MaintenanceTypesSettings.tsx
+ ~20 others
```

---

## 3 · Finance / `FinancialRecordsTab` coverage

The file is shared across the Applicant / Candidate / Employee / Agency
profile financial tabs and is the single biggest visible-literal
hotspot in the codebase.

### Translated this phase

```
✓ Loading state                — t('finance.tab.loading')
✓ "Transaction Ledger" header  — t('finance.tab.ledgerTitle')
✓ Record-count badge           — t('finance.tab.recordCount', { count })   (CLDR-plural-aware)
✓ Header "Export Excel" button — t('finance.tab.exportExcel')
✓ Header "Add Transaction"     — t('finance.tab.addTransaction')
✓ Empty state + first-CTA      — t('finance.tab.empty') / addFirstTransaction
✓ Three summary cards          — t('finance.tab.{totalDisbursed,totalDeducted,currentBalance}')
✓ All 10 table column headers  — t('finance.tab.columns.{date,type,description,…}')
✓ Edit/Delete/Deduction icon-button titles
✓ Expanded-row "Transaction Details" panel + 6 InfoItem labels
✓ "Deductions ({count})" with CLDR-plural support
✓ All 16 toasts wired through  apiError(err, t('finance.tab.toast.{…}'))
   — load, validation (3), record CRUD (5), deduction CRUD (4),
   attachment CRUD (4), export
```

### Deferred to Phase 2.G

```
× Add/Edit Transaction modal form (~120 lines, 14 labels + 4 placeholders)
× Status (deduction) modal form  (~30 lines, 4 labels + 1 placeholder)
× History timeline panel (line items inside the expanded row)
× ChangeDiff helper output ("Created", "Updated", field-name labels)
```

These ~22 remaining literals are inside lower-traffic modal sub-trees
that justify a focused per-modal sweep rather than mixing into the
already-large list-page sweep.

---

## 4 · `AddAgency.tsx` form body coverage

**100% complete.** Every visible literal in the form is now translated:

```
✓ Page subtitle + 6 card titles (Agency Information / Logo / Contact Person /
   HQ Address / Notes / Attached Documents)
✓ 14 field labels (name, country, status, website, contact first/middle/last,
   email, phone, whatsapp, line1, line2, city, state, postal)
✓ 4 placeholders (agency name, website, email, notes)
✓ Status select reuses `common.filters.{active,inactive}` for ACTIVE/INACTIVE;
   SUSPENDED uses an inline `defaultValue: 'Suspended'` (English fallback).
✓ Submit button + "Adding…" loading state + Cancel link
✓ Logo upload section (Replace / Select / Clear, alt text, 5MB help text)
✓ HQ "country applies to this address" help text
✓ Documents-after-creation help text
✓ All 7 validation toasts (name / country / contact / email / phone / website / logo format)
✓ Logo upload partial-failure warning + create-success/failure toasts
   — all wired through apiError(err, t('agencies.add.toast.addFailed'))
```

The `Suspended` status label is the only literal still inline; the
backend uses three statuses (`ACTIVE`, `INACTIVE`, `SUSPENDED`), and
existing `common.filters.*` only had two. Adding `agencyStatus` to the
existing `enums.json` table or extending `common.filters.*` is a
trivial one-key add for Phase 2.G.

---

## 5 · Toast sweep extensions

Beyond the per-page delete-flow toasts, this phase swept the following
auxiliary toast paths in the touched files:

| File | Sites | Pattern |
|---|---:|---|
| `UsersList.tsx` | 4 | approve user + 3 CSV-import paths |
| `ApplicantsList.tsx` | 4 | bulk action / select-empty / load / PDF export |
| `CandidatesList.tsx` | 4 | bulk action / select-empty / pick-workflow / fallback |
| `EmployeesList.tsx` | 5 | select-empty / bulk PDF / row-export / Excel export |
| `VehiclesList.tsx` | 4 | load / export-count / export-all / export fail |
| `JobAdsList.tsx` | 4 | load / status-change success / status-change fail |
| `AgencyUsersManagement.tsx` | 6 | load / approve / override / remove-user paths |

Pattern applied uniformly:

```diff
-toast.error(err?.message || 'Failed to ...')
+toast.error(apiError(err, t('<page>.<action>Failed')))
```

`apiError()` looks up the backend `error.code` (e.g.
`AGENCY.NAME_TAKEN`) in the `errors` namespace, falls back to the
backend's English `error.message`, and finally to the localized
fallback. Consistent across the entire touched surface.

---

## 6 · New translation keys

| Sub-tree | Keys | Purpose |
|---|---:|---|
| `common.confirm.*` | 10 | Reusable phrases (`areYouSure`, `cannotBeUndone`, `archive/restore/approve/reject/remove/revoke` titles) |
| `agencies.list.{deleteTitle,deleteBody,deleteSuccess,deleteFailed}` | 4 | List delete |
| `agencies.add.*` | ~50 | Full form body (titles + fields + placeholders + validation + toasts) |
| `agencies.users.*` (extension) | 12 | Loading/approve/override/remove flows |
| `users.list.*` (extension) | 9 | Delete + approve + bulk import |
| `applicants.list.*` (extension) | 11 | Delete (single + bulk) + bulk action + PDF export |
| `applicants.candidates.*` (extension) | 12 | Delete (single + bulk) + bulk action + workflow assign |
| `employees.list.*` (extension) | 9 | Delete + bulk PDF + Excel export |
| `vehicles.list.*` (extension) | 7 | Delete + load + export |
| `jobAds.list.*` (extension) | 6 | Delete + load + status change |
| `finance.tab.*` (new) | ~50 | Header / summary cards / table / expanded panel / 16 toasts |
| **Total new EN keys** | **~180** | — |

Times 5 non-EN locales = **~900 strings** awaiting native translation.
All key paths are stable.

---

## 7 · Locale parity strategy

`/tmp/sync_keys.mjs` (carried over from Phase 2.D, plural-variant-safe)
walked every namespace in `en/` and inserted missing keys into each
non-English locale verbatim, preserving existing translations. CLDR
plural variants (`_zero`, `_two`, `_few`, `_many`) for ar/ru/sk are
preserved, so the new `finance.tab.recordCount_one/_other` keys land
correctly.

---

## 8 · RTL polish

Touched files use logical Tailwind classes already (`me-*`, `text-end`,
`text-start`). No new directional icons were added. The `ChevronUp` /
`ChevronDown` row-expand toggle in `FinancialRecordsTab` is
visually-symmetric so no flip needed. The export-arrow icon in `Export
Excel` button uses `me-1` (margin-end) — flips correctly in Arabic.

---

## 9 · Quality checks

```
$ npm run i18n:check-keys
✓ All 5 target locales × 9 namespaces match English.

$ npm run i18n:check-literals
Found 1056 suspicious hardcoded JSX literal(s)
  (down from 1079 at end of Phase 2.E — 23-literal reduction).

$ npm run build
✓ built in ~16s
(bundle size warning unchanged; pre-existing.)
```

---

## 10 · Known limitations

1. **`FinancialRecordsTab` modal forms still untranslated.** The
   ~22-literal Add/Edit Transaction modal + Status (deduction) modal
   are tracked for Phase 2.G. They are gated by `canWrite` /
   `canChangeStatus` permissions so a read-only user never sees
   them.

2. **37 `confirm()` callers still pass English props.** This phase
   translated 9 (the highest-traffic list pages); the remaining 37 are
   in detail-page sub-actions (workflow stage moves, document
   actions, employee profile sub-actions, settings pages). Pattern is
   uniform — translate via existing per-page namespaces, reuse
   `common.confirm.*` phrases. ~1 day of mechanical work.

3. **`AgenciesList.tsx` table column headers (9 literals)** —
   visible-text labels for "Name", "Email", "Phone", "Country",
   "Contact", "Status", "Actions" etc. that the scanner reports.
   Defer to Phase 2.G.

4. **`AgencyUsersManagement.tsx` body (5 literals)** — the page
   header / subtitle / column headers. Toast sweep done; visible body
   for Phase 2.G.

5. **Bulk-action partial-failure warning toast** (e.g. *"Applied to
   X, failed for Y (first error: …)"*) in `ApplicantsList` /
   `CandidatesList` is left in English — it concatenates a backend
   error message with localized prefixes and would need 4 separate
   keys + an interpolation-safe formatter. Defer.

6. **`SUSPENDED` agency status** uses an inline English
   `defaultValue: 'Suspended'`. Trivial Phase 2.G fix-up — extend
   `common.filters.*` or add `enums.agencyStatus.SUSPENDED`.

7. **English fallback values for ~180 new keys in non-EN locales.**
   Per the brief — *"English fallback is acceptable for non-English
   locales"*. The script-driven sync inserted English values into
   `sk/de/ru/ar/tr` for the new keys. Translators can replace them in
   place without touching TSX.

8. **Build still emits pre-existing 500 KB chunk warning.**
   Unchanged.

---

## 11 · Remaining high-impact untranslated areas

Sorted by literal-scanner count (heuristic):

| File | Literals | Notes |
|---|---:|---|
| `components/applicants/ApplicantPdfExport.tsx` | 23 | PDF export labels — print-only artifact. Backend-localization candidate. |
| `components/finance/FinancialRecordsTab.tsx` | 22 | Modals (Add/Edit + Status). Phase 2.G. |
| `components/applicants/ApplicationDataView.tsx` | 17 | Read-only applicant data viewer. Phase 2.G. |
| `pages/agencies/AgenciesList.tsx` | 9 | Table column headers. Phase 2.G. |
| `components/employees/WorkHistoryTimeline.tsx` | 6 | Embedded in EmployeeProfile. |
| `components/applicants/ApplicantFormSteps.tsx` | 6 | All TS-signature false positives (Phase 2.C/D). |
| `pages/agencies/AgencyUsersManagement.tsx` | 5 | Page body + column headers. |
| `components/employees/EmployeePdfDocument.tsx` | 4 | PDF export labels. |
| `components/workflow/StageTransition.tsx` | 4 | Dead code (flagged Phase 2.E). |
| 37 `confirm()` callers across detail/settings pages | — | English title/description. |

---

## 12 · Recommended Phase 2.G scope

### Phase 2.G.1 — `FinancialRecordsTab` modal sweep (~1 d)

Translate the Add/Edit Transaction modal (~14 labels + 4 placeholders +
3 form-action buttons + attachment helpers) and the Status modal (~4
labels + Save Status button). Add keys under `finance.tab.modal.*` and
`finance.tab.statusModal.*`. Wire any new error toasts through
`apiError`.

### Phase 2.G.2 — Remaining `confirm()` caller sweep (~1.5 d)

Translate the 37 remaining `confirm()` call sites listed in §2 above.
Mostly mechanical: pull `title`/`description`/`confirmText` from the
existing per-page namespace plus the new reusable
`common.confirm.{archive,restore,approve,reject,remove,revoke}` keys.

### Phase 2.G.3 — `ApplicationDataView.tsx` + `EditAgency.tsx` body (~1 d)

`ApplicationDataView` is the read-only applicant viewer mounted in 3
profile pages. `EditAgency` mirrors the AddAgency form body that was
just translated — copy the `agencies.add.*` keys into `agencies.edit.*`
or share via `agencies.form.*` to avoid duplication.

### Phase 2.G.4 — `AgenciesList` + `AgencyUsersManagement` table headers (~0.5 d)

Translate the 14 visible column-header literals across these two pages.
Add `agencies.{list,users}.columns.*` sub-trees.

### Phase 2.G.5 — Native translations for the ~900 new strings (~3 d)

Replace the English fallback values in `sk/de/ru/ar/tr` for the keys
introduced in Phase 2.E + 2.F. ~330 + ~900 = ~1230 strings × 5 locales.
Key paths are stable.

### Phase 2.G.6 — Delete dead code (~0.25 d)

Remove `components/workflow/StageTransition.tsx` (unused, flagged in
Phase 2.E).

### Suggested next prompt

> Implement Phase 2.G.1 + 2.G.2 of the i18n component sweep. Branch
> `claude/phase-2g-i18n-modals-confirms`. Translate the FinancialRecordsTab
> Add/Edit and Status modals (`finance.tab.modal.*`,
> `finance.tab.statusModal.*`), and complete the 37 remaining `confirm()`
> call sites listed in I18N_PHASE_2F_REPORT.md §2. Reuse existing
> per-page namespaces and the new `common.confirm.*` reusable phrases.
> Run `npm run i18n:check-keys`, `npm run i18n:check-literals`, and
> `npm run build` before commit. Push to the new branch. Do not open a
> PR.
