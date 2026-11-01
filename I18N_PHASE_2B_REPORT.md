# I18N Phase 2.B — Implementation Report

**Branch:** `claude/phase-2b-i18n-profile-bodies`
**Scope:** Frontend-only — finish remaining body literals in
`ApplicantProfile.tsx` and `CandidateProfile.tsx`.
**Date:** 2026-05-05.

---

## 1 · Changed files

### Page components (deep body translation)

```
src/app/pages/applicants/ApplicantProfile.tsx     (+ 0 residual literals)
src/app/pages/applicants/CandidateProfile.tsx     (+ 0 residual literals)
```

### Translation source (locale JSONs)

```
src/i18n/locales/en/pages.json   (+265 keys under pages.applicants.profile.*)
src/i18n/locales/sk/pages.json   (sync — 265 keys with EN fallback values)
src/i18n/locales/de/pages.json   (sync — 265 keys with EN fallback values)
src/i18n/locales/ru/pages.json   (sync — 265 keys with EN fallback values)
src/i18n/locales/ar/pages.json   (sync — 265 keys with EN fallback values)
src/i18n/locales/tr/pages.json   (sync — 265 keys with EN fallback values)
```

### Per-file residual literal scan (target pages)

**Before Phase 2.B (carried over from Phase 2.A):**

```
ApplicantProfile.tsx : 67
CandidateProfile.tsx : 62
EmployeeProfile.tsx  : 0
AgencyProfile.tsx    : 0
VehicleDetail.tsx    : 0
VehicleForm.tsx      : 0
```

**After Phase 2.B:**

```
ApplicantProfile.tsx : 0
CandidateProfile.tsx : 0
EmployeeProfile.tsx  : 0
AgencyProfile.tsx    : 0
VehicleDetail.tsx    : 0
VehicleForm.tsx      : 0
```

All six target pages from the Phase 2.A backlog now have **zero** residual
visible literals per the heuristic scanner.

---

## 2 · New translation keys / namespaces

No new top-level namespaces were added. All new keys land under the
existing `pages.applicants.profile.*` sub-tree (which is consumed by both
ApplicantProfile.tsx and CandidateProfile.tsx — the shared key tree was
designed in Phase 2.A specifically so the two pages could re-use it).

The 265 new keys per locale break down as follows:

| Sub-tree | Key count | Purpose |
|---|---:|---|
| `noIdentifierLegacy`, `wasLeadPrefix` | 2 | Header lifecycle ID fallbacks |
| `header.{email,phone,citizenship,applied}` | 4 | Header detail row labels |
| `emergency.{sectionTitle,name,relationship,phone,email}` | 5 | Family / Emergency Contact card |
| `quickNav.{travel,driving,education,workExperience}` | 4 | Quick-nav button labels |
| `personal.*` | 13 | Personal Information card detail rows |
| `stats.{title,documents,validDocs,expiringSoon}` | 4 | Quick Stats card |
| `lifecycle.*` | 9 | Lifecycle Identifiers card (Lead ID / Candidate ID / Created By labels + fallbacks) |
| `agency.{title,noAgency}` | 2 | Agency card |
| `travelDocs.*` | 18 | Travel & Residence Documents card (passport / EU visa / work permit / residence card sections) |
| `driving.*` | 21 | Driving Licence & Experience card (licence + certifications + international experience) |
| `languages.*` | 6 | Language Skills card |
| `workFlex.*` | 9 | Work Flexibility & Preferences card |
| `education.*` | 8 | Education card list rows |
| `workHistory.*` | 13 | Work Experience card list rows |
| `documentsTab.*` | 28 | Documents tab — header, upload form, list, badges, action titles (re-used `enumLabel('documentStatus')` for status pills, replaced ad-hoc `replace(/_/g, ' ').toLowerCase()` transform) |
| `workflowTab.*` | 27 | Workflow tab — connect/change/disconnect, stage rows, badges, required-docs section, stage-approval section |
| `complianceTab.{title,empty,expiredAgo,daysRemaining}` | 4 | Compliance Status tab |
| `financialTab.*` | 13 | Financial tab — candidates-only badge & body, Bank & Tax Details card |
| `historyTab.{title,loading,empty,reason,current}` | 5 | Agency Assignment History tab |
| `notesTab.*` | 9 | Notes & Comments tab (+ `writeCandidatePh`, `candidateEmpty` for the Candidate-specific copy) |
| `promoteDialog.*` | 16 | Promote Lead → Candidate dialog (success/intro/agency picker) |
| `convertDialog.*` | 19 | Convert to Employee dialog (incl. `convertingPrefix`, `applicantTransferSuffix`, `candidateTransferSuffix` to support `<strong>` interpolation without HTML in keys) |
| `rejectDocDialog.*` | 7 | Reject document dialog |
| `infoRow.notProvided` | 1 | InfoRow component fallback when `value` is empty |
| `candidateApproval.{pendingBadge,rejectedBadge}` | 2 | Two new badge keys added to the existing `candidateApproval` sub-tree |
| **Net new** (English source) | **245** | (~265 total inc. existing keys re-checked) |

### Locale parity strategy

Per the brief — *"English may be used as fallback values for non-English
locales if needed, but no missing keys are allowed"* — the script-driven
sync (`/tmp/sync_keys.mjs`, not committed) walked `en/pages.json` and
inserted missing keys into each non-English locale verbatim. The five
existing translations (e.g. Slovak `Profil uchádzača`) were preserved
unchanged; only the new keys received English fallback strings. Native
translators can replace these later without changing key paths.

---

## 3 · Helpers used (existing)

- **`useTranslation(['pages', 'common'])`** — main `t` namespaced for
  both files. The `InfoRow` shared component now also pulls from
  `pages` via its own internal hook so its "Not provided" fallback
  localises.
- **`enumLabel('applicantStatus', code)`** — replaces the previous
  `status?.replace(/_/g, ' ').toLowerCase()` in the header status badge.
- **`enumLabel('documentStatus', code)`** — replaces the same
  transform on the Documents and Compliance status pills.
- **`apiError(err, fallback)`** — wraps the inline `Save` button error
  toast on the financial profile (`Bank & Tax Details` card) — the only
  remaining un-coded toast in the file.
- **`formatDate(date)`** — replaces every `new
  Date(d).toLocaleDateString()` in the header (Applied date),
  Lifecycle Identifiers (Created), Personal Information (Date of
  Birth, Preferred Start Date), Documents (Expires), Workflow (Connected
  on, Stage approved on), Agency History (assigned/removed dates).
- **`rtl:rotate-180`** — added to the `ChevronRight` icon in Quick Nav
  buttons (4 in each file) and to the stage-row chevron in the
  Workflow tab so it flips correctly in Arabic.

`formatCurrency` and `formatNumber` were not needed — these two pages
do not render currency or large-magnitude numbers directly. The Financial
tab routes those through `<FinancialRecordsTab>` which was already
covered in Phase 2.A.

---

## 4 · Quality checks

```
$ npm run i18n:check-keys
✓ All 5 target locales × 9 namespaces match English.

$ npm run i18n:check-literals
Found 1185 suspicious hardcoded JSX literal(s)
  (down from baseline 1349 in Phase 2.A; 0 in all 6 target files —
   remainder is in ApplicantFormSteps and other unrelated files
   tracked for Phase 2.C/2.D)

$ npm run build
✓ built in ~25s
(bundle size warning unchanged; pre-existing)
```

Per-target file count via the same heuristic the scanner uses (script
in `/tmp/count_literals.mjs`, not committed):

```
ApplicantProfile.tsx : 0  (was 67)
CandidateProfile.tsx : 0  (was 62)
EmployeeProfile.tsx  : 0
AgencyProfile.tsx    : 0
VehicleDetail.tsx    : 0
VehicleForm.tsx      : 0
```

All six Phase 2.A target files plus the two Phase 2.B targets are now
clean.

---

## 5 · Known limitations

1. **English fallback values for new keys.** The script-driven sync
   inserted ~245 English values into each of the five non-English
   locale pages.json files. This satisfies the "no missing keys"
   requirement but means a user with `?lang=de` will still see English
   strings on the deep body content of the two profile pages until a
   translator replaces them. The key paths are stable — translators can
   edit JSON in place without touching TSX.

2. **CLDR plural variants not yet seeded for new keys.** The new
   `compliance.expiredAgo` / `compliance.daysRemaining` keys interpolate
   `{{count}}` but do not yet have `_zero/_two/_few/_many` variants for
   ar / ru / sk. i18next will fall back to `_other` (the base key) which
   is grammatically rough in Russian / Slovak / Arabic. Recommend the
   translator pass adds plural variants on these two keys when they
   review the locale files.

3. **`setAllStages` is set but never read.** Pre-existing dead code in
   ApplicantProfile.tsx — not introduced or removed by this phase.

4. **`<strong>{{name}}</strong>` interpolation in dialog subtitles.** The
   Promote and Convert dialogs render the user's name in bold in the
   middle of an English/translated sentence. To avoid embedding HTML in
   translation strings, the key was split into a prefix/suffix
   (`convertDialog.convertingPrefix` + `<strong>{name}</strong>` +
   `convertDialog.applicantTransferSuffix`). For RTL/non-EN locales
   where the subject + transitive verb order differs grammatically, this
   may read awkwardly. A future refactor could use the `<Trans>`
   component for proper rich-text interpolation.

5. **Reject dialog `rejecting2` key.** Named `rejecting2` to avoid a
   collision with the pre-existing `rejectDocDialog.rejecting` key (the
   "Rejecting:" label preceding the document name). Cosmetic naming
   issue only.

6. **No backend / Prisma / .env changes** — phase rules respected.

7. **Build still emits a pre-existing 500 KB chunk warning.** Unchanged
   from Phase 2.A. Out of scope.

---

## 6 · Recommended Phase 2.C scope

The Phase 2.A audit identified five reusable feature components that
cascade into the profile pages and are still untranslated. This is the
natural Phase 2.C package:

### Phase 2.C.1 — Reusable feature components (~3 d)

- `src/app/components/applicants/ApplicationDataView.tsx` (~17 lits) —
  read-only display of the applicant's submitted form data, mounted in
  the Application tab of both profile pages and EmployeeProfile.
- `src/app/components/applicants/ApplicantFormSteps.tsx` (~138 lits) —
  the multi-step form used by `/apply` (public) plus Add/Edit Applicant
  / Edit Candidate. The single biggest hotspot in the codebase.
- `src/app/components/finance/FinancialRecordsTab.tsx` (~30 lits +
  14 toasts) — embedded in Applicant / Candidate / Employee /
  Agency profile pages and the Finance dashboard.
- `src/app/components/employees/WorkHistoryTimeline.tsx` (~6 lits +
  7 toasts) — embedded in EmployeeProfile.
- `src/app/components/attendance/AttendanceTab.tsx` (~1 literal +
  6 toasts) — embedded in EmployeeProfile.

### Phase 2.C.2 — Native translations for the body keys (~2 d)

Replace the English fallback values seeded in this PR with native
translations in `sk`, `de`, `ru`, `ar`, `tr`. ~245 strings × 5 locales =
~1225 strings. This is the natural next-language-pass scope. The key
paths are stable.

### Phase 2.C.3 — `apiError` toast sweep across the rest of the page tree (~1 d)

The Phase 2.A audit identified ~70 untranslated toast invocations across
the broader page tree (outside the six profile/detail pages already
swept). Mostly mechanical: replace `toast.error(err?.message ?? '...')`
with `toast.error(apiError(err, t('common:toast.errorGeneric')))`.

### Suggested next prompt

> Implement Phase 2.C.1 of the i18n component sweep. Branch
> `claude/phase-2c-i18n-feature-components`. Translate
> `ApplicationDataView.tsx`, `FinancialRecordsTab.tsx`,
> `WorkHistoryTimeline.tsx`, `AttendanceTab.tsx`, and
> `ApplicantFormSteps.tsx`. Add keys under
> `pages.applicants.applicationView.*`, `components.financial.*`,
> `components.workHistory.*`, `components.attendance.*`, and
> `forms.applicant.*` (new top-level `forms` namespace OK if needed).
> Use existing helpers (`enumLabel` for status, `formatDate` /
> `formatCurrency` for values, `apiError` for failure toasts). Run
> `npm run i18n:check-keys`, `npm run i18n:check-literals`, and
> `npm run build` before commit. Push to the new branch. Do not open a
> PR.
