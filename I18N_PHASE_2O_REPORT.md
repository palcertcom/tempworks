# I18N Phase 2.O — Implementation Report

**Branch:** `claude/phase-2o-i18n-column-prefs-legal`
**Scope:** Frontend-only — column-picker `ALL_COLUMNS` refactor across
13 list/dashboard files, UserPreferences static option arrays,
DataProcessingAgreement body wiring, remaining `confirm()` callers,
top-3 high-impact literal-scanner files (ReportsDashboard,
DatabaseBackup, DeletedRecords).
**Date:** 2026-05-06.

---

## 1 · Changed files

```
# Column-picker refactor (13 files)
src/app/pages/agencies/AgenciesList.tsx
src/app/pages/attendance/AttendanceList.tsx
src/app/pages/users/UsersList.tsx
src/app/pages/applicants/ApplicantsList.tsx
src/app/pages/applicants/CandidatesList.tsx
src/app/pages/finance/FinanceDashboard.tsx
src/app/pages/employees/EmployeesList.tsx
src/app/pages/logs/LogsDashboard.tsx
src/app/pages/vehicles/WorkshopsList.tsx
src/app/pages/vehicles/VehiclesList.tsx
src/app/pages/vehicles/MaintenanceTypesList.tsx
src/app/pages/job-ads/JobAdsList.tsx
src/app/pages/documents/DocumentsCompliance.tsx

# Profile preferences static arrays
src/app/pages/profile/UserPreferences.tsx

# DataProcessingAgreement body wiring
src/app/pages/public/DataProcessingAgreement.tsx

# Remaining confirm() backlog
src/app/pages/pipelines/WorkflowSettingsPage.tsx

# Top-3 high-impact literal files
src/app/pages/reports/ReportsDashboard.tsx
src/app/pages/settings/DatabaseBackup.tsx
src/app/pages/recycle-bin/DeletedRecords.tsx

# Locales
src/i18n/locales/en/pages.json                  (+ ~125 keys)
src/i18n/locales/en/public.json                 (+ ~17 dpa item keys, full body text)
src/i18n/locales/{sk,de,ru,ar,tr}/{pages,public}.json   (sync)

I18N_PHASE_2O_REPORT.md                         (new)
```

### Repo-wide literal-scanner totals

| Stage | Total |
|---|---:|
| Phase 2.N end | 518 |
| Phase 2.O end | 430 |

**88-literal reduction.**

---

## 2 · Column-picker `ALL_COLUMNS` refactor

All 13 inventoried `ALL_COLUMNS` arrays converted from
`{ key, label: string }` to `{ key, labelKey: string }`, with the
column-picker render expression changed from `{c.label}` /
`{label}` to `{t(c.labelKey)}` / `{t(labelKey)}`.

Stable column IDs preserved. Backend field names untouched. Filter,
sort, and export logic unchanged.

| File | Columns | Namespace |
|---|---:|---|
| `agencies/AgenciesList.tsx` | 7 | `agencies.list.cols.*` |
| `attendance/AttendanceList.tsx` | 8 | `attendance.list.cols.*` |
| `users/UsersList.tsx` | 5 | `users.list.cols.*` |
| `applicants/ApplicantsList.tsx` | 10 | `applicants.list.cols.*` |
| `applicants/CandidatesList.tsx` | 10 | `applicants.list.cols.*` (shared) |
| `finance/FinanceDashboard.tsx` | 12 | `finance.list.cols.*` |
| `employees/EmployeesList.tsx` | 6 | `employees.list.cols.*` |
| `logs/LogsDashboard.tsx` | 9 | `logs.list.cols.*` |
| `vehicles/WorkshopsList.tsx` | 5 | `vehicles.workshops.list.cols.*` |
| `vehicles/VehiclesList.tsx` | 16 | `vehicles.list.cols.*` |
| `vehicles/MaintenanceTypesList.tsx` | 5 | `vehicles.maintTypes.list.cols.*` |
| `job-ads/JobAdsList.tsx` | 10 | `jobAds.list.cols.*` |
| `documents/DocumentsCompliance.tsx` | 12 | `documents.list.cols.*` |
| **Total** | **115** | — |

---

## 3 · UserPreferences static arrays

Refactored language and timezone `<SelectItem>` lists from inline
hardcoded `<SelectItem value="X">Label</SelectItem>` tuples to
data-driven `LANGUAGE_OPTIONS` / `TIMEZONE_OPTIONS` constants at
module scope, mapped at render time via
`t(\`profile.preferences.languages.${code}\`)` and
`t(\`profile.preferences.timezones.${tz}\`)`.

Keys added under `profile.preferences.languages.*` (9 entries) and
`profile.preferences.timezones.*` (14 entries) in pages.json.
Bilingual labels (e.g. "Arabic (العربية)", "London (GMT/BST)")
preserved verbatim as English fallback values; non-EN locales now
have native-label authoring scope.

---

## 4 · DataProcessingAgreement body wiring

All ~25 long legal paragraphs and 17 list items wired to the
existing `dpa.section{N}p{M}` / `dpa.section{N}p{M}{a|b|c|d}` keys
defined in Phase 2.N. The Phase 2.N keys carried summary
placeholders; this phase replaced them with the **full original
English text from the .tsx file** so no paraphrasing was applied
(per the brief: "Do not paraphrase legal text.").

Newly added in this phase:

```
dpa.section1p1 / .section1p1bold1 / .section1p1mid / .section1p1bold2
dpa.section2p1aItems.{i01..i14}    — employee data fields
dpa.section2p1bItems.{i01..i03}    — family member fields
```

The `1.1` paragraph contains nested `<strong>` tags (GDPR /
"Regulation"); these are preserved by splitting the paragraph into
4 keys (text + bold + text + bold) interpolated in the JSX.

Native translation of these keys is now a translator-only task —
no engineering work remains.

---

## 5 · Remaining confirm() backlog

Translated the last hardcoded `confirm()` call site in
`WorkflowSettingsPage.tsx` (`handleCopy` — duplicate workflow). Now
uses existing `pipelines.confirm.duplicateTitle/Body/Confirm` keys
plus translated success/error toasts.

A repo-wide grep confirms **0 hardcoded `confirm({title: '…'})`
literal call sites remain** (excluding the comment-block example in
`components/ui/ConfirmDialog.tsx`, which is documentation, not code).

---

## 6 · Top-3 high-impact literal files

### `pages/reports/ReportsDashboard.tsx` (18 → 0)

Extended `reports.dashboard.*` with ~18 keys (PreviewTable empty
states, Report Builder UI labels, dashboard chart titles, saved
reports empty states). The internal `PreviewTable` helper component
gained its own `useTranslation('pages')` binding.

```
✓ "No columns selected." / "No data returned" preview states
✓ "Report Builder" tab + "Report Info" / "Single Table" /
   "Combined (Multi-Table)" / "Joining:" config labels
✓ "Employees by Status" / "Applicants by Status" chart titles
✓ "No sort rules" / "Add Filter" / "No filters" builder hints
✓ "Value (to)" range filter label
✓ "Loading saved reports…" / "No saved reports yet" empty states
✓ "New / Clear" reset action
```

### `pages/settings/DatabaseBackup.tsx` (14 → ~3)

Added `useTranslation('pages')` (file had none) and translated
the most user-visible strings under `settings.databaseBackup.*`
(~12 new keys):

```
✓ "Access Denied" + admin-only body
✓ "Database Backup & Restore" header title
✓ "Operation in progress…" / "Create Backup" buttons
✓ "Important — Backup & Restore Safety Notes" warning header
✓ "Total Backups" / "Latest Backup" stat cards
✓ "All Statuses" filter sentinel
✓ "No backups found" empty state title + body
```

Residual ~3 hits are inline `<code>` snippets (`./backups/`,
`pg_dump`, `pg_restore`) and the safety-note bullet list — these
are technical filenames/commands and a multi-bullet warning that
warrants per-bullet keys; flagged for 2.P.

### `pages/recycle-bin/DeletedRecords.tsx` (11 → ~1)

Extended `recycleBin.list.*` with ~10 keys:

```
✓ Access-denied body
✓ "All Types" sentinel
✓ "Newest first" / "Oldest first" sort options
✓ "Deleted from" date-range label
✓ Table headers: Name / ID, Business ID, Deleted At
✓ "Loading…" placeholders (table + dialog)
✓ "+related" restore-with-related button text
```

---

## 7 · Locale parity

`/tmp/sync_keys.mjs` walked every namespace in `en/` and inserted
missing keys into each non-English locale verbatim. CLDR plural
variants for ar/ru/sk preserved.

---

## 8 · Quality checks

```
$ node /tmp/sync_keys.mjs
✓ ar synced
✓ de synced
✓ ru synced
✓ sk synced
✓ tr synced

$ npm run i18n:check-keys
✓ All 5 target locales × 9 namespaces match English.

$ npm run i18n:check-literals
Found 430 suspicious hardcoded JSX literal(s)
  (down from 518 at end of Phase 2.N — 88-literal reduction).

$ npm run build
✓ built in ~20s
(bundle size warning unchanged; pre-existing.)
```

---

## 9 · Scanner false positives

Carried into 2.O from prior phases (TS-signature regex catches):

- `pages/agencies/AgenciesList.tsx:180` — `= from && t`
- `pages/documents/DocumentsCompliance.tsx:247` — same pattern
- `pages/job-ads/JobAdsList.tsx:209` — same pattern
- `pages/finance/FinanceDashboard.tsx:140,401` — TS arrow signatures
- `components/applicants/ApplicantFormSteps.tsx` (6) — TS signatures
- `components/ui/alert.tsx` (1) — TS arrow fragment

The `[c.key, true])) as Record` pattern that the scanner caught in
Phase 2.N is now eliminated by the column-picker refactor (the
expression still exists but no longer trips the regex because the
surrounding JSX text changed shape).

Total carried false-positive count ≈ 12.

---

## 10 · Constraints honoured

- **Stable column IDs preserved.** All `ColKey` literal types
  unchanged; only the second tuple field renamed from `label` to
  `labelKey`.
- **No backend field names changed.** The string passed to
  filtering/sorting/export logic is `c.key`, never `c.label` —
  zero risk to those code paths.
- **No filtering / sorting / export logic touched.** Only the
  presentation tier (column-picker render expression) changed.
- **Legal text not paraphrased.** Phase 2.N's summarised key
  values were overwritten with the full verbatim text from
  the .tsx; no semantic edits applied.
- **Locale key parity maintained.** `i18n:check-keys` ✓.

---

## 11 · Remaining high-impact untranslated areas

Sorted by literal-scanner count (post-2.O):

| File | Literals | Notes |
|---|---:|---|
| `pages/settings/DatabaseBackup.tsx` | ~3 | Inline `<code>` filenames + safety-bullet list. |
| `pages/roles/RolesList.tsx` | 6 | Role management headers/labels. |
| `pages/roles/CreateRole.tsx` | 6 | Create-role form. |
| `components/applicants/ApplicantFormSteps.tsx` | 6 | TS-signature false positives. |
| `pages/settings/BrandingSettings.tsx` | 4 | Branding form labels. |
| `components/workflow/StageTransition.tsx` | 4 | **Dead code** — flagged for removal. |
| `pages/roles/PermissionsMatrix.tsx` | 3 | Permission grid labels. |
| Numerous individual <5 hits | — | Long tail across 30+ files. |

---

## 12 · Recommended Phase 2.P / Backend Phase 3 scope

### Phase 2.P.1 — Roles module sweep (~0.5 d)

Translate `RolesList`, `CreateRole`, `PermissionsMatrix` (15
combined hits) under a new `roles.*` extension. Pattern is
identical to the pages already translated.

### Phase 2.P.2 — DatabaseBackup safety bullets (~0.25 d)

Translate the 4 inline safety bullets (currently with embedded
`<code>` tags) using `<Trans i18nKey>` or per-bullet keys with
`<code>` preserved as JSX.

### Phase 2.P.3 — BrandingSettings + small tail (~0.5 d)

Translate `BrandingSettings` (4 hits) plus the long tail of files
with 1–3 hits each. Mostly mechanical.

### Phase 2.P.4 — Delete dead code (~0.25 d)

Remove `components/workflow/StageTransition.tsx` (4 hits, dead
code per Phase 2.E note).

### Phase 2.P.5 — Native translations (~3-4 d)

Cumulative translator workload is ~4,000 EN keys × 5 locales ≈
~20,000 strings. **DPA legal text** (~50 paragraphs/items, now
fully wired) requires native legal review.

### Phase 3 — Backend i18n

Per Phase 2.N report. Scope:
- API error messages → translation keys
- Email templates → per-locale variants
- PDF generators → thread `t()` through templates
- Zod validation → translation keys

### Suggested next prompt

> Implement Phase 2.P based on I18N_PHASE_2O_REPORT.md.
> Branch `claude/phase-2p-i18n-roles-and-tail`. Translate the
> Roles module (RolesList, CreateRole, PermissionsMatrix),
> finish DatabaseBackup safety bullets, translate BrandingSettings,
> and sweep the long tail of files with 1–3 literal hits each.
> Delete `components/workflow/StageTransition.tsx`. Run
> `npm run i18n:check-keys`, `npm run i18n:check-literals`, and
> `npm run build` before commit. Push to the new branch. Do not
> open a PR.
