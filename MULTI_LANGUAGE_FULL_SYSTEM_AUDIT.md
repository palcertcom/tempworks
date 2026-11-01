# Multi-Language Full System Audit (Consolidated)

> **Read-only summary.** Synthesizes the four detailed audits already in
> the repository:
>
> - [`MULTI_LANGUAGE_AUDIT_01_FRONTEND_ROUTES.md`](./MULTI_LANGUAGE_AUDIT_01_FRONTEND_ROUTES.md)
> — 105 routes / page components.
> - [`MULTI_LANGUAGE_AUDIT_02_COMPONENTS.md`](./MULTI_LANGUAGE_AUDIT_02_COMPONENTS.md)
> — layout, UI primitives, feature components, dialogs, forms, tables, toasts.
> - [`MULTI_LANGUAGE_AUDIT_03_BACKEND_DATABASE.md`](./MULTI_LANGUAGE_AUDIT_03_BACKEND_DATABASE.md)
> — backend exceptions, validation, emails, notifications, exports, DB-driven labels.
> - [`MULTI_LANGUAGE_AUDIT_04_RTL.md`](./MULTI_LANGUAGE_AUDIT_04_RTL.md)
> — frontend RTL/LTR risks (icons, positioning).
>
> **Read-only:** no source modified, no commit made.
> Date: 2026-05-05. Branch: `claude/phase-5-i18n-polish`.

---

## 1 · Current i18n Coverage

### Plumbing — ✅ complete

| Layer | What's wired | Source |
|---|---|---|
| Frontend stack | `i18next ^26.0.8`, `react-i18next ^17.0.6`, browser language detector `^8.2.1` | `package.json` |
| Provider / detection / persistence | `<LanguageProvider>` wrapping app; localStorage → navigator → htmlTag; `<html lang/dir>` synced on every change | `src/i18n/{LanguageContext,index,config}.tsx` |
| Languages | en, sk, de, ru, ar (RTL), tr; dev-only `pseudo` | `src/i18n/config.ts` |
| Namespaces (9) | `common, nav, auth, public, enums, errors, dashboard, ui, pages` | `src/i18n/locales/<lng>/*.json` |
| Total English keys | **889** (28 + 67 + 84 + 161 + 116 + 35 + 79 + 30 + 289) | Audit 01 §1 |
| Locale parity | All 5 target locales × 9 ns equal English | `npm run i18n:check-keys` |
| Lazy loading | Custom backend `import('./locales/${lng}/${ns}.json')` → one Vite chunk per (locale, namespace) | `src/i18n/index.ts` |
| Helpers | `formatDate / formatDateTime / formatNumber / formatCurrency`, `enumLabel(group, code)`, `apiError(err)`, `pseudo(...)` | `src/i18n/{formatters,enumLabel,apiError,pseudo}.ts` |
| Switcher | `<LanguageSwitcher>` mounted in Topbar + every public page | `src/i18n/LanguageSwitcher.tsx` |
| RTL | Tailwind v4 logical utilities everywhere; `RTL_LOCALES = ['ar']`; Arabic web-font in `index.html` | Audit 04 §1 |
| Backend filter | `I18nExceptionFilter` emits `{ statusCode, code, message, params }`; locale resolver reads `?lang=` → `User.preferredLanguage` → `Accept-Language` → `en` | `backend/src/common/i18n/*` |
| Email templates | 9 templates × 6 locales in `email-i18n.ts`; per-locale `<html lang dir>` | `backend/src/email/email-i18n.ts` |
| DB translations | `DocumentType`, `JobType`, `WorkflowStage` have `translations Json?`; idempotent migration runs at startup | `backend/prisma/{schema,run-i18n-translations-migration}.ts` |
| Tooling | `i18n:check-keys`, `i18n:check-literals`, `i18n:check` | `scripts/i18n-check-{keys,literals}.mjs` |
| Translator handoff | `src/i18n/README.md` | — |

### Content — ⚠️ partial

| Surface | Coverage | Source |
|---|---:|---|
| Public flow (login / forgot / reset / activate / apply / jobs / DPA / landing) | **100% chrome, 100% body** (DPA legal body intentionally English) | Audit 01 §2 |
| Layout (Sidebar, Topbar, dashboard chrome, language switcher, change-password modal) | **100%** | Audit 02 §2 |
| UI primitives (shadcn/Radix) — 11 with their own text | **100%** translated | Audit 02 §3 |
| UI primitives — 39 pass-through | n/a (no text of their own) | Audit 02 §3 |
| Routes / page components (105) — strict (zero hardcoded literals) | **15 / 105 = 14%** | Audit 01 §3 |
| Routes / page components — pragmatic (chrome translated, body partial) | **49 / 105 = 47%** | Audit 01 §3 |
| Feature components (`src/app/components/{applicants,attendance,employees,finance,filters,workflow}`) | 9 of 11 untranslated; 231 hardcoded literals (138 in `ApplicantFormSteps.tsx` alone) | Audit 02 §4 |
| Toasts | **~3%** (18 wrapped in `t()` + 1 `apiError`) of 602 invocations across 74 files | Audit 02 §8 |
| Tables (column headers / empty states) | **0%** of 30 tables — status badges already use `enumLabel` | Audit 02 §7 |
| `confirm({ … })` callers (delete/restore/lock dialogs) | ~30 callers pass English literals; default labels translated | Audit 02 §5.1 |
| Backend exceptions | **15 / 158 ≈ 9%** coded; 143 legacy `throw new XxxException('text')` remain | Audit 03 §3 |
| `class-validator` `message:` overrides | **0** of 51 DTOs | Audit 03 §4 |
| Email callers passing `recipient.preferredLanguage` | 3 / 10 | Audit 03 §5.1 |
| In-app notification persistence | 0% — written as English `title` + `message` strings | Audit 03 §5.2 |
| Excel / PDF / CSV export headers | 0% across 5 services (attendance, employees, applicants, finance, reports, vehicles) | Audit 03 §5.4 |
| DB-driven label translations | 3 / 14 models have `translations Json?` | Audit 03 §6.1 |
| RTL — physical Tailwind classes (`ml-/mr-/pl-/pr-/text-left/text-right/rounded-l/rounded-r/border-l/border-r-N`) | **0** residual occurrences (Phase 5 codemod clean) | Audit 04 §3 |
| RTL — directional icons (`Chevron*`, `Arrow*`) with `rtl:rotate-180` | **13 / 93** files; **80 backlog** | Audit 04 §1 |

### Estimated overall translated percentage

Aggregating across surfaces (each weighted by visible frequency):

| Stratum | Weight | Coverage | Contribution |
|---|---:|---:|---:|
| Frontend page chrome (47% pragmatic) | 25% | 47% | 11.8 |
| Public flow (full) | 5% | 100% | 5.0 |
| Layout / nav / dashboard chrome | 10% | 100% | 10.0 |
| UI primitives (own text) | 5% | 100% | 5.0 |
| Frontend page bodies (forms / detail panels / dialog literals) | 20% | 14% | 2.8 |
| Tables (headers / empty states) | 5% | 0% | 0.0 |
| Toasts | 5% | 3% | 0.2 |
| Confirm-dialog literals | 2% | ~10% | 0.2 |
| Backend exceptions (auth-only coded) | 5% | 9% | 0.5 |
| Validation messages | 3% | 0% | 0.0 |
| Email templates + caller locale | 5% | 100% × 30% threading = ~30% | 1.5 |
| In-app notifications | 3% | 0% | 0.0 |
| Exports | 2% | 0% | 0.0 |
| DB-driven labels | 3% | 21% (3/14) | 0.6 |
| RTL physical classes | 2% | 100% | 2.0 |
| **Total** | **100%** | — | **≈ 39.6%** |

> **Estimated translated percentage: ~40% system-wide.**
> Two view-points are useful: a daily-use **chrome view** (login →
> dashboard → list pages → primary CTAs render in user's language) is
> closer to **65–70%**; a **strict view** (every user-visible string
> flows through `t()` / `apiError` / `enumLabel`) is **~14%**.

---

## 2 · Top 10 Untranslated Areas

Ranked by `(literal count) × (visibility) × (cascade reach)`.

| # | Area | What ships in English today | Source |
|---|---|---|---|
| 1 | **`components/applicants/ApplicantFormSteps.tsx`** — multi-step applicant form | 138 hardcoded literals: section headers, field labels, placeholders, validation hints, declaration text. Reused by `/apply` + Add/Edit Applicant + Edit Candidate | Audit 02 §4 |
| 2 | **`pages/applicants/ApplicantProfile.tsx`** + **`CandidateProfile.tsx`** | 72 + 69 literals: tabs, KPI rows, action buttons, add-note / convert / finance / workflow-assignment dialogs | Audit 01 §4 |
| 3 | **Toasts** — 602 invocations across 74 files | Only ~3% wrapped in `t()` / `apiError`. Worst-translated surface in the app, visible after every save / delete / upload | Audit 02 §8 |
| 4 | **Backend exceptions** — 143 legacy `throw new XxxException('text')` | 25 in `pipeline`, 19 in `vehicles`, 16 in `settings`, 15 in `attendance`, 14 in `users`, 10 in `applicants` | Audit 03 §3 |
| 5 | **Tables** — column headers + empty states across 30 list pages | 0% of headers translated; status badges already use `enumLabel` so data side is OK | Audit 02 §7 |
| 6 | **`pages/employees/EmployeeProfile.tsx`** (22) and tabs `EmployeeComplianceTimeline` (17) / `EmployeeTrainingHistory` (12) / `EmployeePerformanceReview` (12) / `EmployeeCertifications` (8) | Profile-detail page that's used many times per day per recruiter | Audit 01 §4, Tier 3 |
| 7 | **`pages/vehicles/VehicleDetail.tsx`** (39) + **`VehicleForm.tsx`** (21) + maintenance settings | Heaviest non-applicant detail pages | Audit 01 §4 |
| 8 | **`components/finance/FinancialRecordsTab.tsx`** | 30 literals + 14 untranslated toasts; cascades into ApplicantProfile / CandidateProfile / EmployeeProfile / FinanceDashboard | Audit 02 §4 |
| 9 | **Settings sub-pages** — 20 of 23 settings routes untranslated | 4% pragmatic coverage; DocumentTypeNew / Edit / View, JobTypes, DatabaseBackup, SecuritySettings, SystemInformation, … | Audit 01 §3, Tier 4 |
| 10 | **`confirm({ ... })` callers** — ~30 pages pass English `title/description/confirmText` to the otherwise-translated `ConfirmDialog` | "Delete applicant?" / "Restore record?" / "Lock period?" all English even though the dialog frame is translated | Audit 02 §5.1 |

Honourable mentions: `pages/users/EditUser.tsx` (25), `pages/employees/EditEmployee.tsx` (27), `pages/agencies/EditAgency.tsx` (18), `pages/documents/{DocumentUpload,EditDocument,DocumentPreview}.tsx`, `pages/workflow/WorkflowAnalytics.tsx` (19), `pages/profile/UserPreferences.tsx` (24).

---

## 3 · Top 10 RTL Risks

| # | File / area | Failure mode in Arabic | Source |
|---|---|---|---|
| 1 | `components/ui/breadcrumb.tsx` | `›` separator points the wrong way on **every** page | Audit 04 §5 |
| 2 | `components/ui/sheet.tsx` | `side="right"` drawer anchors to physical right; should anchor to logical end. Slide-in animation reversed | Audit 04 §3, §5 |
| 3 | `components/ui/sidebar.tsx` | Conditional `left-0`/`right-0` on `side` prop is physical, not logical; collapse-offcanvas math is hard-coded | Audit 04 §5 |
| 4 | `components/ui/{dropdown-menu,context-menu,menubar}.tsx` | Sub-menu `›` chevron points away from the sub-menu | Audit 04 §5 |
| 5 | `components/ui/carousel.tsx` | Prev/Next must SWAP roles (Embla `direction: 'rtl'`), not just rotate icons | Audit 04 §5 |
| 6 | `pages/roles/PermissionsMatrix.tsx` | `sticky left-0` frozen "Module / Action" column anchors to visual left in Arabic, leaving the wrong column scrolling behind data | Audit 04 §3 |
| 7 | Page-header back-arrow on **~50 pages** | Single `<ArrowLeft/>` in agencies / users / employees / settings / vehicles / documents / workflow / pipelines / profile / compliance / job-ads — points wrong way (suggests "forward") in Arabic | Audit 04 §3 |
| 8 | Workflow / pipeline stage progression arrows (`workflow/{Timeline,Overview,StageDetail}.tsx`, `pipelines/WorkflowBoardPage.tsx`, `components/workflow/StageTransition.tsx`) | "→" denotes time/stage progression — must point left in Arabic to read as "next" | Audit 04 §5 |
| 9 | `pages/applicants/{Add,Edit}Applicant.tsx`, `EditCandidate.tsx`, `Applicant/CandidateProfile.tsx` | 5–6 directional icons each (back, breadcrumb, profile-tab carousel) — none flipped | Audit 04 §3 |
| 10 | `pages/documents/DocumentsCompliance.tsx`, `pages/attendance/AttendanceSheet.tsx`, `pages/logs/LogsDashboard.tsx` | 6–8 directional icons each (pagination + breadcrumb + back); calendar / period-picker direction inverts | Audit 04 §4 |

**Aggregate RTL stats** (Audit 04 §3):
- Physical Tailwind direction classes remaining: **0**
- Files with directional icon **and** missing `rtl:rotate-180`: **80 of 93**
- Residual physical `left-N`/`right-N` positioning: 4 files (sheet, sidebar, carousel, PermissionsMatrix)

---

## 4 · Backend / Database Gaps

### 4.1 Exceptions

| Module | Legacy throws | Priority |
|---|---:|---|
| `pipeline.service.ts` | 25 | High |
| `vehicles.service.ts` | 19 | High |
| `settings.service.ts` | 16 | Medium |
| `attendance.service.ts` | 15 | High |
| `users.service.ts` | 14 | High |
| `applicants.service.ts` | 10 | High |
| `workflow.service.ts` / `finance.service.ts` / `employees.service.ts` | 7 each | High / Medium |
| `agencies.service.ts` / `roles.service.ts` / `documents.service.ts` (+ controllers) | 3–5 each | Medium |
| **Total un-coded** | **143** | — |

Recommended keyspace already drafted in Audit 03 §3.3: groups
`AUTH / USERS / EMPLOYEES / APPLICANTS / AGENCIES / DOCUMENTS / WORKFLOW / PIPELINE / ATTENDANCE / FINANCE / VEHICLES / SETTINGS / ROLES / WORK_HISTORY / BACKUP / DRAFTS / GENERIC`. Frontend `errors.json` already uses this shape for the `AUTH.*` and `GENERIC.*` groups.

### 4.2 Validation

- **0** of 51 DTOs override `class-validator` `message:`.
- Recommend a single `ValidationPipe.exceptionFactory` rewrite that emits `{ code: 'VALIDATION_FAILED', errors: [{ field, code, params }] }` and a `mapDefault(rule)` helper (`isEmail` → `validation.email`, `minLength` → `validation.minLength`, …). DTOs stay untouched. Add `errors.validation.*` keys (16 needed; 5 already present).

### 4.3 Emails

- 9 templates × 6 locales done (`email-i18n.ts`).
- 7 of 10 callers ignore recipient locale (don't pass `user.preferredLanguage`): all of `auth.service.ts > {sendActivation, sendPasswordReset, sendPasswordChanged, sendPasswordExpired, sendWelcome}`, `applicants.service.ts > sendApplicationConfirmation`, `notifications.service.ts > sendNotificationEmail`.
- `applicationConfirmation` body still mixes English section labels.

### 4.4 In-app notifications

- 100% English persistence — `Notification.title` and `Notification.message` are written as concatenated English strings (`"${vehicle}: ${label} Expiring Soon"`).
- Recommended schema change: add `titleKey String?`, `bodyKey String?`, `params Json?` columns; frontend resolves preferentially with English fallback.
- New frontend namespace `notifications.json` proposed in Audit 03 §5.2 (sectioned `vehicle.* / finance.* / documents.*`).

### 4.5 Exports

- 5 services emit Excel/PDF/CSV with English headers: `attendance`, `employees`, `applicants`, `finance`, `reports`, `vehicles` (PDF).
- Strategy: resolve request locale at controller; pass to export builder; replace hardcoded headers with `tExport(locale, key)` (per-service in-memory map, mirroring `email-i18n.ts`).

### 4.6 DB-driven labels

| Status | Models |
|---|---|
| ✅ has `translations Json?` + read-time merge | `DocumentType`, `JobType`, `WorkflowStage` (3) |
| ⚠ needs `translations Json?` (small editable label tables) | `FinanceTransactionType`, `WorkHistoryEventTypeSetting`, `MaintenanceType`, `Workshop`, `NotificationRule`, `SystemSetting.description`, `Workflow`, `StageTemplate` (8) |
| ⚠ needs dedicated translation table | `JobAd` (long editor-authored content; new `JobAdTranslation` per Audit 03 §6.2) |
| Use frontend `enums.*` instead | `Role`, `Permission` (stable codes; admin-created roles fall back to canonical English) |

`runStartupMigrations` in `backend/src/main.ts` already supports idempotent `ADD COLUMN IF NOT EXISTS` — extending it for the 8 new columns is mechanical.

---

## 5 · Recommended Phase 2 Roadmap

> Numbering restarts at "Phase 2" of post-foundation work; independent of
> the original 5-phase plumbing plan. Each phase below is a single
> deliverable that can ship as one PR.

### Phase 2.A — Frontend high-traffic body translation (≈ 3.5 d)

- New `common` keys: `common.{table.*, filters.*, toast.*, form.*}` (Audit 02 §10).
- Sweep `apiError(err, t('toast.errorGeneric'))` across all 70+ files that toast.
- Translate the four profile pages: `ApplicantProfile`, `CandidateProfile`, `EmployeeProfile`, `AgencyProfile` (~225 literals).
- Translate `VehicleDetail` + `VehicleForm` (60 literals).
- Sweep `confirm({ ... })` literals on the ~30 callers.
- **Outcome:** pragmatic coverage 47% → ~58%; strict 14% → ~30%.

### Phase 2.B — The applicant form + reusable feature components (≈ 3 d)

- Extract `forms` namespace; populate `forms.applicant.*` (sections, fields, validations, declarations).
- Translate `ApplicantFormSteps.tsx` (138 literals — biggest single hotspot).
- Translate `FinancialRecordsTab`, `WorkHistoryTimeline`, `AttendanceTab`, `FilterSystem`, `ApplicationDataView`, `StageTransition`.
- **Outcome:** strict 30% → ~50%.

### Phase 2.C — Tables + toasts standardization (≈ 1.5 d)

- Add `tables` namespace; per-module column headers under `tables.<module>.*`.
- Wire `common.table.*` into all 30 list pages (rows-per-page, "of", page X of Y, selected counts, empty state).
- Standardize toast messages on `common.toast.{created,updated,deleted,…,<entity>}` keys.
- **Outcome:** toast translation rate 3% → ~80%; table chrome 0% → 100%.

### Phase 2.D — RTL icons + UI primitives (≈ 3.25 d) — see Audit 04 §6

- **RTL-A** direction-aware `<ChevronStart/End>` and `<ArrowStart/End>` wrappers (1 d).
- **RTL-B** mechanical icon-flip codemod across 80 backlog files (1 d).
- **RTL-C** `sheet.tsx`, `sidebar.tsx`, `carousel.tsx`, `PermissionsMatrix.tsx` logical-positioning sweep (½ d).
- **RTL-D** Arabic end-to-end QA (½ d).
- **RTL-E** CI guard `i18n:check-rtl` script (¼ d).

### Phase 2.E — Backend exception coding (≈ 1.5 d) — see Audit 03 §8

- Convert 143 legacy `throw new XxxException('text')` to `{ code, message, params? }` form.
- Extend `errors.json` × 6 locales with the new code groups.
- Group order: `users` → `employees` → `applicants` → `documents` → `vehicles` → `finance` → `attendance` → `pipeline` → `agencies` → `settings` → `roles` → tail.

### Phase 2.F — Validation pipe + email caller-locale threading (≈ 1 d)

- Replace global `ValidationPipe.exceptionFactory` to emit field-level codes.
- Add 16 `errors.validation.*` keys.
- Thread `user.preferredLanguage` through 7 email callers; finish localizing `applicationConfirmation` body sections.

### Phase 2.G — In-app notification keys + export header localization (≈ 1.5 d)

- Add `Notification.{titleKey,bodyKey,params}` columns; backwards-compatible read-side fallback.
- New `notifications.json` (vehicle / finance / documents events).
- Localize Excel/PDF export headers in `attendance`, `employees`, `applicants`, `finance`. Use `I18nService.resolve(req)` at controller entry.

### Phase 2.H — DB-driven label expansion (≈ 1 d)

- Add `translations Json?` to 8 remaining label models via `runStartupMigrations` idempotent SQL.
- Wire merge in their controllers (mirror the existing `/settings/{document-types,job-types}` pattern).
- Add `enums.{documentType,notificationRule,role,permission}.*` sub-trees in `enums.json`.

### Phase 2.I — Settings long-tail + admin sweeps (≈ 1.5 d)

- Mostly mechanical: wire `useTranslation('pages')` into the 20 untranslated settings pages, mapping existing English chrome to `pages.settings.*` keys (which Phase 3 already populated).
- Extend `pages.settings.descriptions.<key>` for `SystemSetting.description` rows.

### Phase 2.J — `JobAd` translation table + Arabic PDF font (≈ 2 d, low priority)

- New `JobAdTranslation` table (`jobAdId, locale, title, description, publishedAt`).
- Public `/jobs` and `/jobs/:slug` prefer `translations[locale]`.
- Register an Arabic-shaping font in `@react-pdf/renderer` and `pdfkit` for export quality.

### Effort summary

| Phase | Effort | Owner | Dependencies |
|---|---|---|---|
| 2.A — Profile bodies + toast sweep | 3.5 d | frontend | none |
| 2.B — Applicant form + reusable components | 3 d | frontend | 2.A common keys |
| 2.C — Tables + toast standardization | 1.5 d | frontend | 2.A |
| 2.D — RTL icons + primitives | 3.25 d | frontend | none (parallelizable) |
| 2.E — Backend exception coding | 1.5 d | backend | none |
| 2.F — Validation + email locale | 1 d | backend | 2.E |
| 2.G — Notifications + exports | 1.5 d | backend | 2.E |
| 2.H — DB-label expansion | 1 d | backend | none |
| 2.I — Settings long-tail | 1.5 d | frontend | 2.A common keys |
| 2.J — JobAd translation + PDF fonts | 2 d | full-stack | low priority |
| **Total** | **~19.75 d** | | — |

After Phase 2.A–2.I (excluding 2.J): pragmatic coverage **~95%**, strict
coverage **~85%**, RTL backlog **0**, backend exceptions **100% coded**.

---

## 6 · Next Implementation Prompt (Exact)

Copy-paste the block below as the next user prompt. It scopes Phase 2.A
(highest user-visible win, no backend changes, parallel-safe).

> **Implement Phase 2.A of the consolidated audit. Branch
> `claude/phase-2a-i18n-profile-bodies`.**
>
> 1. **Common keys.** Extend `src/i18n/locales/en/common.json` (and the
>    five locale siblings — `sk, de, ru, ar, tr`) with these new
>    sub-trees, then run `npm run i18n:check-keys` to confirm parity:
>    - `actions.{saveChanges, saveAndContinue, submit, create, update,
>      delete, remove, archive, restore, approve, reject, duplicate,
>      copy, refresh, exportCsv, exportExcel, exportPdf, columns,
>      selectAll, clearAll, clearFilters, yes, no}`
>    - `states.{saving, submitting, uploading, empty, noResults,
>      tryAgain, comingSoon, notImplemented}`
>    - `table.{rowsPerPage, of, page, selected_one, selected_other,
>      clearSelection, exportSelected, noResults}` (plus CLDR plural
>      variants `selected_zero`, `selected_two`, `selected_few`,
>      `selected_many` for `ar` / `ru` / `sk`)
>    - `filters.{all, active, inactive, from, to, search,
>      advancedFilters, clear}`
>    - `toast.{created, updated, deleted, restored, archived,
>      published, saved, copied, exportStarted, exportComplete,
>      exportFailed, uploadStarted, uploadComplete, uploadFailed,
>      networkOffline, errorGeneric, permissionDenied}`
>    - `form.{required, optional, fieldRequired, selectOption,
>      saving, saveSuccess}`
>
> 2. **`apiError` toast sweep.** Across the 74 files that call
>    `toast.<level>(...)` (Audit 02 §8), replace every literal-string
>    error toast with
>    `toast.error(apiError(err, t('common.toast.errorGeneric')))` and
>    every literal-string success toast with `t('common.toast.<verb>',
>    { entity: t('common.entities.<name>') })` where appropriate.
>    Don't introduce new helpers — use the existing `apiError` from
>    `src/i18n/apiError.ts`.
>
> 3. **Profile bodies (5 files).** Translate to use
>    `useTranslation('pages')` and extend the `pages.applicants.profile.*`,
>    `pages.candidates.profile.*`, `pages.employees.profile.*`,
>    `pages.agencies.profile.*`, `pages.vehicles.detail.*` sub-trees:
>    - `src/app/pages/applicants/ApplicantProfile.tsx` (72 literals)
>    - `src/app/pages/applicants/CandidateProfile.tsx` (69 literals)
>    - `src/app/pages/employees/EmployeeProfile.tsx` (22 literals)
>    - `src/app/pages/agencies/AgencyProfile.tsx` (16 literals)
>    - `src/app/pages/vehicles/VehicleDetail.tsx` (39 literals)
>
>    Use `enumLabel(group, code)` for status badges,
>    `formatDate / formatCurrency / formatNumber` for any rendered
>    value. New keys go under the **existing** `pages` namespace — no
>    new top-level namespaces in this PR.
>
> 4. **Confirm-dialog sweep.** For every `confirm({ title: '...',
>    description: '...', confirmText: '...', cancelText: '...' })` in the
>    five files above, replace the literal strings with `t(...)` calls
>    pointing at the appropriate `pages.<module>.profile.dialogs.*`
>    keys.
>
> 5. **Acceptance.** Before commit:
>    - `npm run build` — green.
>    - `npm run i18n:check-keys` — 0 missing across 6 locales × 9 namespaces.
>    - `npm run i18n:check-literals` — strictly fewer literals on the
>      five touched files than baseline; the script's overall total
>      should drop by **≥ 200**.
>    - `npm run dev` and visually verify with `?lang=pseudo` that every
>      visible string on the five pages is wrapped in `[!! ... !!]`.
>
> 6. **Don't touch.** Backend code, RTL primitives (`sheet.tsx`,
>    `sidebar.tsx`, `carousel.tsx`, `PermissionsMatrix.tsx`),
>    `ApplicantFormSteps.tsx`, settings pages, validation pipe — those
>    are later phases.
>
> Commit and push to `claude/phase-2a-i18n-profile-bodies`. Do not open
> a PR.

---

## 7 · Final Answers

- **Estimated translation coverage:** ~40% system-wide; ~65–70% chrome-view; ~14% strict.
- **Top untranslated area in one sentence:** the multi-step applicant form (`ApplicantFormSteps.tsx`, 138 literals) plus the four profile pages (`ApplicantProfile / CandidateProfile / EmployeeProfile / AgencyProfile`, 179 combined).
- **Top RTL risk in one sentence:** the breadcrumb chevron + 80 page-level back-arrow / pagination icons that lack `rtl:rotate-180`, surfacing on virtually every dashboard page in Arabic.
- **Biggest backend gap:** 143 legacy un-coded exceptions and a `ValidationPipe` that emits English `class-validator` defaults — together they mean 90%+ of API errors never get translated even though the filter and resolver are in place.
- **Biggest DB gap:** 11 of 14 user-visible label models still serve raw English; `JobAd` long-form content has no translation table.
- **Recommended next step:** Phase 2.A (≈ 3.5 d, frontend-only, parallel-safe). Lifts pragmatic coverage from 47% to ~58% and removes ~225 hardcoded literals from the four highest-traffic detail pages. Exact prompt in §6.
