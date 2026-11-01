# I18N Phase 2.E — Implementation Report

**Branch:** `claude/phase-2e-i18n-dashboard-shared`
**Scope:** Frontend-only — translate high-impact dashboard shared UI
(filters, carousel, layout toasts), wire `apiError()` across the
profile + pipelines toast/error paths, and localize confirmation
dialogs in the workflow management surface.
**Date:** 2026-05-05.

---

## 1 · Changed files

```
src/app/components/filters/FilterSystem.tsx        (5 → 0 user-visible literals)
src/app/components/ui/carousel.tsx                 (2 → 0 user-visible literals)
src/app/components/layout/Topbar.tsx               (apiError() polish)
src/app/pages/agencies/AddAgency.tsx               (Access Denied + logo toast)
src/app/pages/profile/Profile.tsx                  (toast sweep)
src/app/pages/profile/ChangePassword.tsx           (toast + strength + rules)
src/app/pages/pipelines/WorkflowsPage.tsx          (toast + confirm sweep)
src/app/pages/pipelines/WorkflowBoardPage.tsx      (error sweep)
src/app/pages/pipelines/WorkflowStageDetailsPage.tsx  (error sweep)

src/i18n/locales/en/common.json                    (+ filters.operator.*, permissions.*, toast.logoTooLarge)
src/i18n/locales/en/ui.json                        (+ carousel.*)
src/i18n/locales/en/pages.json                     (+ profile.toast.*, profile.changePassword.{strength,rules},
                                                     pipelines.{errors,toast,confirm}.*)
src/i18n/locales/{sk,de,ru,ar,tr}/common.json      (sync — English fallback)
src/i18n/locales/{sk,de,ru,ar,tr}/ui.json          (sync — English fallback)
src/i18n/locales/{sk,de,ru,ar,tr}/pages.json       (sync — English fallback)

I18N_PHASE_2E_REPORT.md                            (new)
```

### Per-file residual literal counts (touched)

| File | Before | After |
|---|---:|---:|
| `components/filters/FilterSystem.tsx` | 5 | 0 |
| `components/ui/carousel.tsx` | 2 | 0 |
| `components/layout/Topbar.tsx` | 0 (already i18n; raw `err.message` in toast) | 0 |
| `pages/agencies/AddAgency.tsx` | 1 ("Access Denied") | 0 (in scope; rest of file out of scope) |
| `pages/profile/Profile.tsx` | 0 visible-text literals; 7 raw English toasts | 0 raw toasts |
| `pages/profile/ChangePassword.tsx` | 0 visible-text literals; 5 raw toasts + 4 strength labels + 5 rule labels | 0 |
| `pages/pipelines/WorkflowsPage.tsx` | 0 visible-text literals; 8 raw English toasts/dialogs/errors | 0 |
| `pages/pipelines/WorkflowBoardPage.tsx` | 0 visible-text literals; 3 raw English errors | 0 |
| `pages/pipelines/WorkflowStageDetailsPage.tsx` | 0 visible-text literals; 1 raw English error | 0 |

### Repo-wide literal-scanner totals

| Stage | Total |
|---|---:|
| Phase 2.D end | 1088 |
| Phase 2.E end | 1079 |

The 9-literal reduction comes from FilterSystem (5), carousel (2),
AddAgency Access Denied (1), and a fix-up around the FilterSystem
internal "and" / "Yes/No" labels.

---

## 2 · Sidebar / Topbar / MainLayout audit

These three components were inspected first as Phase 2.E
sub-task 1. The literal scanner reports **0 hits** across all three:

```
src/app/components/layout/MainLayout.tsx : 0
src/app/components/layout/Sidebar.tsx    : 0
src/app/components/layout/Topbar.tsx     : 0
```

- `Sidebar.tsx` already uses `useTranslation('nav')` with `labelKey`
  on every `NavItem` / `NavChild`. All section headers, role badges,
  and "Coming soon" placeholders flow through `t()`.
- `Topbar.tsx` already uses `useTranslation('nav')` with subkeys
  `topbar.*`, `notifications.*`, `quickActions.*`,
  `notificationFilter.*`, and `changePassword.*`. The breadcrumb
  generator reads route-derived keys from `nav.json`.
- `MainLayout.tsx` is a wrapper with no visible text.

The only remaining gap was a single submit-error toast in `Topbar`
that read the raw backend `err.message`. Phase 2.E routes it through
`apiError()` for consistent error-code → translation lookup:

```diff
-const msg = Array.isArray(err?.message)
-  ? err.message.join(', ')
-  : (err?.message || t('changePassword.errorGeneric'));
-toast.error(msg);
+toast.error(apiError(err, t('changePassword.errorGeneric')));
```

**Verdict for Phase 2.E sub-task 1:** the dashboard shared layout +
navigation + breadcrumbs + profile menu + notification menu + quick
actions are already fully translated from earlier phases. No new keys
were needed — only the one toast polish.

---

## 3 · Shared table/list UI — `FilterSystem.tsx`

The advanced filters dropdown is shared across every list page
(applicants, candidates, employees, agencies, vehicles, etc.). It
was the highest-frequency shared-UI hotspot still emitting English
literals.

### New `common.filters.*` sub-tree (~26 keys)

```
filtersLabel, rulesTitle, savedFilters, searchColumns, searchColumnPh,
logic, and, or, addFilter, savePreset, savePresetTitle, presetName,
presetNamePh, valuePh, valueAnd, selectValue,
operator.{contains, equals, startsWith, endsWith,
          greaterThan, lessThan, greaterThanOrEqual, lessThanOrEqual,
          between, before, after, notEquals, in, is}
```

### Refactor

- `useTranslation('common')` added to both the outer `FilterSystem`
  and the inner `FilterRuleBuilder` component.
- 7 hard-coded operator-list arrays (text/number/date/enum/boolean)
  now build `label` from `t('filters.operator.<key>')`.
- All section headers ("Filter Rules", "Saved Filters", "Search
  Columns"), placeholders, the "AND/OR" toggle, "Add Filter", "Save
  Preset", and the formatted-value `Yes`/`No` labels go through the
  existing `common.actions.*` and `common.filters.*` keys.
- Pagination, "Clear All", "Cancel", "Save", "Apply" reuse the
  pre-existing `common.actions.*` keys (no new keys for those).

The "=" operator label is intentionally left as a literal — it's a
math symbol that doesn't need translation.

---

## 4 · Carousel aria labels (`components/ui/carousel.tsx`)

`<span class="sr-only">Previous slide</span>` / `Next slide` were the
only visible literals in the shared carousel. New `ui.carousel.*`
keys cover both. `useTranslation('ui')` was added to
`CarouselPrevious` and `CarouselNext`.

---

## 5 · ConfirmDialog audit + targeted refactor

The shared `<ConfirmDialogHost>` component was already i18n-ready
(its fallback labels read from `ui.confirmDialog.*`). The work
here is on the **callers** that pass English `title`/`description`
props.

`grep -rn "await confirm({" src/ | wc -l` shows **48 call sites**.
Translating every caller is a multi-day effort across product
surfaces. Phase 2.E translates the ones in the touched workflow
files only — `WorkflowsPage.handleCopy()` and
`ManageAccessModal.handleRemove()` — and adds a reusable key tree
so other callers can follow the pattern without inventing new keys:

```
pages.pipelines.confirm.duplicateTitle / duplicateBody / duplicateConfirm
pages.pipelines.confirm.revokeTitle    / revokeBody    / revokeConfirm
```

**Remaining untouched `confirm()` callers** (carried to Phase 2.F):

- `agencies/AgenciesList.tsx`, `EditAgency.tsx`, `AgencyUsersManagement.tsx`
- `users/UsersList.tsx`, `EditUser.tsx`
- `employees/EmployeeProfile.tsx` (multiple sites)
- `applicants/ApplicantsList.tsx`, `ApplicantProfile.tsx` (multiple)
- `vehicles/VehiclesList.tsx`, `VehicleDetail.tsx`
- `documents/DocumentsList.tsx`
- + ~30 others.

These all pass English `title` / `description` strings directly. They
do not appear in the literal scanner because the scanner only matches
JSX text, but they are user-visible.

---

## 6 · Toast / error sweep

### `apiError(err, fallback)` rolled out

Replaced the `err?.message || 'English'` and `Array.isArray(...)
.join(', ')` pattern with `apiError(err, t(...))` in:

- `Topbar.tsx` — change-password failure
- `Profile.tsx` — load profile, update profile, photo upload, 2FA toggle (4 sites)
- `ChangePassword.tsx` — submit failure
- `WorkflowsPage.tsx` — load list, duplicate, load access, grant, revoke (5 sites)
- `WorkflowBoardPage.tsx` — load board, assign candidate (2 sites)
- `WorkflowStageDetailsPage.tsx` — submit approval (1 site)

### New translation keys

- `pages.profile.toast.*` (8 keys: load/update/photo/2FA × success/fail)
- `pages.profile.changePassword.{strength,rules}.*` (4 + 5 keys)
- `pages.pipelines.errors.*` (9 keys)
- `pages.pipelines.toast.*` (3 keys: duplicated, accessGranted, accessRevoked)
- `common.toast.logoTooLarge`
- `common.permissions.{accessDenied,noPermission}`

`AddAgency.tsx` "Access Denied" + "You don't have permission…" copy
was lifted into the new `common.permissions.*` sub-tree so other
guard screens can reuse it without new keys.

The `ChangePassword` strength meter (`Weak`/`Fair`/`Good`/`Strong`)
and the 5 password validation rule labels are now translatable.

---

## 7 · Locale parity strategy

`scripts/i18n-check-keys.mjs` enforces strict key parity. The
`/tmp/sync_keys.mjs` helper (carried over from Phase 2.D, plural-
variant-safe) walked every namespace in `en/` and inserted missing
keys into each non-English locale verbatim, preserving existing
translations and CLDR plural variants.

Net new keys this phase: ~62 (English source). Distribution:

| Sub-tree | Keys |
|---|---:|
| `common.filters.operator.*` + scaffolding | 26 |
| `common.toast.logoTooLarge` | 1 |
| `common.permissions.*` | 2 |
| `ui.carousel.*` | 2 |
| `pages.profile.toast.*` | 8 |
| `pages.profile.changePassword.{strength,rules}.*` | 9 |
| `pages.pipelines.errors.*` | 9 |
| `pages.pipelines.toast.*` | 3 |
| `pages.pipelines.confirm.*` | 6 |
| **Total** | **~66** |

Times 5 non-EN locales = **~330 strings** awaiting native translation.
Key paths are stable.

---

## 8 · RTL polish

No new directional icons or layouts were introduced in this phase.
The `FilterSystem` dropdown already uses logical Tailwind classes
(`start-0`, `ms-1`, `ms-auto`, `ms-1`). The carousel's left/right
navigation buttons keep their absolute positioning per the upstream
shadcn/ui convention; the touched files do not flip them. RTL
behavior unchanged.

---

## 9 · Quality checks

```
$ npm run i18n:check-keys
✓ All 5 target locales × 9 namespaces match English.

$ npm run i18n:check-literals
Found 1079 suspicious hardcoded JSX literal(s)
  (down from 1088 at end of Phase 2.D — 9-literal reduction
   in FilterSystem / carousel / AddAgency).

$ npm run build
✓ built in ~26s
(bundle size warning unchanged; pre-existing.)
```

---

## 10 · Known limitations

1. **`StageTransition.tsx` is dead code.** Identified during the
   audit — defined but not imported anywhere
   (`grep -rln "StageTransition" src/` → only the file itself).
   Skipped translation; flagged for deletion in a future cleanup
   PR. The 4 literals it contains remain as English.

2. **48 `confirm()` callers still pass English props.** Phase 2.E
   translates 2 of them; the rest are tracked for Phase 2.F
   (mechanical sweep — title/description/confirmText replacements).

3. **`AddAgency.tsx` form body still untranslated** (≈ 30
   literals). The page-level guard ("Access Denied") was the
   in-scope literal for this phase; the full form refactor is
   per-page work that belongs to a per-page sweep, not the shared-
   UI sweep.

4. **`FilterSystem.tsx` column labels stay backend-supplied.** The
   `Column.label` strings flow in from each calling page and are
   typed `string`. Calling pages choose whether to pre-translate
   or not. No change here.

5. **`PROFICIENCY_LEVELS` / `LANGUAGES` / `SKILL_LEVELS` keys**
   added in Phase 2.D still carry English fallback values in
   non-EN locales. Phase 2.F native-translation pass should cover
   these together with the ~330 new strings from this phase.

6. **Build still emits pre-existing 500 KB chunk warning.**
   Unchanged.

---

## 11 · Remaining high-impact untranslated areas

Sorted by literal-scanner count (heuristic — TypeScript-signature
false positives included for transparency):

| File | Literals | Notes |
|---|---:|---|
| `components/finance/FinancialRecordsTab.tsx` | 30 | Pre-Phase-2.C target; deferred. |
| `components/applicants/ApplicantPdfExport.tsx` | 23 | PDF export labels — print-only artifact. |
| `components/applicants/ApplicationDataView.tsx` | 17 | Read-only applicant data viewer. |
| `components/employees/WorkHistoryTimeline.tsx` | 6 | Embedded in EmployeeProfile. |
| `components/applicants/ApplicantFormSteps.tsx` | 6 | All TS-signature false positives (Phase 2.C/D). |
| `components/employees/EmployeePdfDocument.tsx` | 4 | PDF export labels. |
| `components/workflow/StageTransition.tsx` | 4 | Dead code. |
| `components/attendance/AttendanceTab.tsx` | 1 | Embedded in EmployeeProfile. |
| `pages/agencies/AddAgency.tsx` | 30+ | Form body. |
| ~48 `confirm()` callers | — | English title/description props. |

---

## 12 · Recommended Phase 2.F scope

### Phase 2.F.1 — `confirm()` caller sweep (~1.5 d)

Mechanical translation of the 46 remaining `confirm()` call sites
across agencies / users / employees / applicants / vehicles /
documents pages. Pattern is uniform: replace English `title` /
`description` / `confirmText` props with `t('…')` lookups under each
page's existing namespace, e.g.:

```diff
-await confirm({ title: 'Archive workflow?', confirmText: 'Archive' })
+await confirm({ title: t('pipelines.confirm.archiveTitle'),
+               confirmText: t('common:actions.archive') })
```

A small registry of reusable phrases (`Are you sure?`, `This cannot
be undone.`, `Archive`, `Restore`, `Delete`) under `common.confirm.*`
would cut the new-key count significantly.

### Phase 2.F.2 — `FinancialRecordsTab.tsx` (~1.5 d)

The single biggest remaining literal hotspot (30 literals). Embedded
in 4 pages (Applicant / Candidate / Employee / Agency profile).
Translate via `pages.financial.*` keys, route every error toast
through `apiError`, format currency through `formatCurrency`.

### Phase 2.F.3 — `AddAgency.tsx` form body (~1 d)

Translate the 30+ form-field labels and section headings via
`pages.agencies.add.*` keys. Toasts already partially covered by
this phase; remaining error paths → `apiError`.

### Phase 2.F.4 — Native translations for the ~330 new keys (~2 d)

Replace the English fallback values in `sk/de/ru/ar/tr` for the keys
introduced in Phase 2.D and 2.E (filters operator labels, profile
toasts, pipelines errors / dialogs, password rules, etc.).

### Phase 2.F.5 — Delete dead code (~0.25 d)

Remove `components/workflow/StageTransition.tsx` (unused) and any
other `grep`-confirmed-orphan files surfaced during the audit.

### Suggested next prompt

> Implement Phase 2.F.1 of the i18n component sweep. Branch
> `claude/phase-2f-i18n-confirm-sweep`. Translate the title /
> description / confirmText props at every `await confirm({…})` call
> site outside the dialogs already covered in Phases 2.A–2.E. Add a
> `common.confirm.*` sub-tree of reusable phrases (`areYouSure`,
> `cannotBeUndone`, `archive`, `restore`, etc.) and lift per-action
> bodies into per-page namespaces. Run `npm run i18n:check-keys`,
> `npm run i18n:check-literals`, and `npm run build` before commit.
> Push to the new branch. Do not open a PR.
