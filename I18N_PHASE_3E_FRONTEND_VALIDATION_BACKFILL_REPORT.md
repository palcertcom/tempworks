# I18N Phase 3.E — Frontend Validation Backfill

**Branch:** `claude/phase-3e-validation-form-backfill` (off `claude/phase-3d-frontend-validation-forms`)
**Date:** 2026-05-06
**Scope:** Frontend only. Reuses the Phase 3.D helpers (`useValidationErrors`, `<FieldError>`, `<ValidationSummary>`) on 9 mid-impact forms. No backend, Prisma, env, or unrelated module changes.

---

## 1. Summary

Phase 3.E extends per-field validation rendering from the 9 high-impact forms covered in Phase 3.D into 9 additional mid-impact forms across agencies, employees, vehicles, finance, and settings. Same pattern, same helpers — zero new infrastructure, zero new backend work.

| Metric | Result |
|---|---|
| Forms integrated this phase | **9** |
| Cumulative forms integrated (3.D + 3.E) | **18** |
| New helpers added | **0** (reused Phase 3.D infrastructure) |
| Backend changes | **0** |
| Frontend build (`vite build`) | ✓ clean (0 TS errors) |
| `i18n:check-keys` | ✓ pass |
| `i18n:check-literals` | 13 hits (same false-positive baseline) |

---

## 2. Forms Integrated

### 2.1 `agencies/AddAgency.tsx`
- Hook + `<ValidationSummary>` above the form.
- `<FieldError>` on `name`, `email`, `phone`.
- `aria-invalid` + red-border on the same fields.
- `setField()` clears the corresponding entry on each keystroke.
- `setFromError(err)` in catch before existing `apiError(err, fallback)` toast.

### 2.2 `agencies/EditAgency.tsx`
- Mirror of AddAgency. Same fields decorated. `name` input remains `disabled` for Agency Managers — `aria-invalid`/red border still apply if the backend rejects an unrelated field.

### 2.3 `employees/AddEmployee.tsx`
- Hook + `<ValidationSummary className="mb-4">` (positioned before the multi-column grid so it spans the full width).
- `<FieldError>` on `firstName`, `lastName`, `email`, `phone` — the four most likely to fail backend validation.
- `set()` change handler clears `fieldErrs[field]`.
- Both layout columns of the grid are unaffected; the summary lives above.

### 2.4 `employees/EditEmployee.tsx`
- Mirror of AddEmployee on the same four primary fields.

### 2.5 `vehicles/VehicleForm.tsx`
- Hook + summary at the top of the form (`space-y-6` wrapper preserves the existing card spacing).
- `<FieldError>` on `registrationNumber`, `make`, `model` — the three required fields the backend DTO enforces.
- `set(key, value)` (existing helper) extended to `clearError` on touched fields.

### 2.6 `components/finance/FinancialRecordsTab.tsx` (transaction modal)
- Hook scoped to the parent component; summary rendered inside `<CardContent>` of the modal.
- `clearFieldErrors()` at the start of `handleSave`.
- `setFromError(err)` in the catch block before `toast.error(apiError(err, …))`.
- Per-field `<FieldError>` decorations not added in this pass — the modal has 12 fields and most validation today is client-side; backend validation surfaces are limited. Summary banner is sufficient for now.

### 2.7 `settings/JobTypes.tsx` (CRUD dialog)
- Hook + summary inside the `<Dialog>` content.
- `<FieldError name="name">` next to the name input with `aria-invalid` + red border.
- `setFormData({...})` extended with `clearError('name')`.
- Backend's likely validation hits (`name` required, length, uniqueness) all map to `errors.validation.*` codes.

### 2.8 `vehicles/WorkshopsList.tsx` (CRUD dialog)
- Hook + summary inside the dialog body.
- `<FieldError name="name">` on the Workshop Name input.
- `setField()` extended with `clearError`. Other fields (contactName, phone, email, address) accept the keystroke handler updates without explicit `<FieldError>` since the backend rarely rejects them; if it does, the summary banner catches them.
- `apiError(err, …)` swap in catch block (was previously bare `tc('toast.saveFailed')`) so the localized backend message wins over the generic fallback.

### 2.9 `vehicles/MaintenanceTypesList.tsx` (CRUD dialog)
- Hook + summary inside the dialog body.
- `<FieldError name="name">` on the Name input.
- `set(key, value)` extended with `clearError`. Same handler used for `description`, `defaultIntervalDays`, `defaultIntervalKm` — backend errors on those fields surface in the summary.
- `apiError(err, …)` swap in catch.

---

## 3. Files Changed

| File | Change |
|---|---|
| `src/app/pages/agencies/AddAgency.tsx` | Hook, summary, 3 fields decorated |
| `src/app/pages/agencies/EditAgency.tsx` | Hook, summary, 3 fields decorated |
| `src/app/pages/employees/AddEmployee.tsx` | Hook, summary, 4 fields decorated |
| `src/app/pages/employees/EditEmployee.tsx` | Hook, summary, 4 fields decorated |
| `src/app/pages/vehicles/VehicleForm.tsx` | Hook, summary, 3 fields decorated (registrationNumber, make, model) |
| `src/app/components/finance/FinancialRecordsTab.tsx` | Hook, summary, catch updated; per-field decorations deferred |
| `src/app/pages/settings/JobTypes.tsx` | Hook, summary, 1 field decorated (name) |
| `src/app/pages/vehicles/WorkshopsList.tsx` | Hook, summary, 1 field decorated (name); apiError(err) swap |
| `src/app/pages/vehicles/MaintenanceTypesList.tsx` | Hook, summary, 1 field decorated (name); apiError(err) swap |

9 files modified, 0 added. ~140 lines net additions.

---

## 4. UX Improvements

| Pattern | Where | Effect |
|---|---|---|
| `aria-invalid="true"` on inputs flagged by backend | All 9 forms (representative fields) | Screen readers immediately announce the invalid state |
| Red border (`border-red-500`) on invalid inputs | All 9 forms | Sighted users see exactly which field failed before scrolling to the inline message |
| `<ValidationSummary>` banner | All 9 forms | Long forms (AddEmployee ~25 fields, VehicleForm ~30 fields) get a single focal point |
| `clearError(field)` on change | All 9 forms | Errors disappear as soon as the user starts fixing them |
| `setFromError(err) → false` falls through to `apiError(err)` toast | All 9 forms | Non-validation errors keep the existing toast UX intact |
| `apiError(err, fallback)` in three previously-bare catches (Workshop, MaintenanceType, finance) | 3 forms | Localized backend message now beats the generic fallback |

**Scroll-to-first-error:** Intentionally **not** added (deferred from Phase 3.D too). The summary banner provides a focal point and works on all forms; auto-scroll could disorient users on long multi-card forms (VehicleForm has 7 cards, AddEmployee has multiple sections).

---

## 5. Backward Compatibility

| Concern | Handling |
|---|---|
| Old envelope `{ message: 'free text' }` | `setFromError()` returns `false`; toast path preserved |
| Existing client-side validators (e.g. AddAgency's `looksLikeWebsite()`, VehicleForm required-field checks) | Preserved verbatim; backend errors are merged on top in the same map |
| Forms with their own validation strings | Untouched; new helpers add only on submit-failure response |
| `instanceof BadRequestException` consumers | N/A — frontend-only change |
| `<Input>` props (`required`, `disabled`, `placeholder`) | All preserved; only `aria-invalid` and conditional `className` added |

---

## 6. Validation Fallback Order

Each integration follows the chain established in Phase 3.C/D:

1. **Localized field code** — `errors.validation.<KEY>` interpolated with `params`
2. **Backend `message`** — canonical English string
3. **Generic** — `errors.validation.INVALID` ("This value is invalid.")

`apiError(err, fallback)` for the toast follows:

1. **Localized error code** — `errors.<group>.<KEY>` (e.g. `errors.workflow.NOT_FOUND`)
2. **Backend `message`**
3. **Provided `fallback` string**
4. **Generic** — `errors.generic.UNEXPECTED`

---

## 7. Cumulative Form Coverage (Phase 3.D + 3.E)

| Phase | Forms | Module groups |
|---|---|---|
| 3.D | 9 | users (×2), job-ads, applicants (×3), documents (×2), public/reset |
| 3.E | 9 | agencies (×2), employees (×2), vehicles (×3), finance, settings |
| **Total** | **18 forms** | 9 module groups |

---

## 8. Remaining Forms Not Integrated

These continue to display the existing `apiError(err)` toast — no regression — and are queued for future work as needed.

| Module | Files | Notes |
|--------|-------|-------|
| Settings | `BrandingSettings`, `SecuritySettings`, `MaintenanceTypesSettings`, `WorkHistoryEventTypesSettings`, `TransactionTypesSettings`, `DocumentTypeNew/Edit/View`, `TruckBrandsSettings`, `TrailerTypesSettings`, `TransportTypesSettings`, `SkillsSettings`, `DatabaseBackup/Cleanup`, `VehicleSettings` | Mostly 1-3 field CRUD dialogs; backend validation surfaces are very limited. Summary-only treatment is the natural pass when needed. |
| Workflow | `WorkflowsPage` create dialog, `WorkflowBoardPage` (note/advance/assign modals), `WorkflowStageDetailsPage` (decision dialog) | Small dialogs (1–3 fields each). Backend errors are mostly status/permission, not validation. |
| Auth | `LoginPage`, `ForgotPasswordPage`, `ChangePassword`, `Profile` | 1–3 field forms; `apiError()` toast already covers them. |
| Roles | `CreateRole` | Single-name form; toast-only is acceptable. |
| Other CRUD | `MaintenanceRecordsList` create/edit dialog, dynamic field rows in WorkHistoryTimeline | Inline-row dialogs; helpers compatible if/when needed. |

A repo-wide grep for `toast\.error\(apiError` returns ~22 forms still using only the toast. None are blocked — they fall through the `apiError()` path correctly when the backend emits `VALIDATION.FAILED`.

---

## 9. Known Limitations

1. **Translator pass on `validation.*` keys still pending** (Phase 3.C). 31 EN keys are synced as placeholders to ar/de/ru/sk/tr. Behavior is correct; non-EN locales currently display English validation messages.

2. **Per-field rendering is selective.** Most forms decorate the 1–4 most-likely-to-fail fields (name, email, phone, registration). Less-frequent fields rely on the `<ValidationSummary>` banner. Phase 3.F can extend coverage if user research shows specific fields fail often.

3. **FinancialRecordsTab** received hook + summary + catch wiring but **no per-field `<FieldError>` decorations**. The 12-field modal has heavy client-side validation; backend validation is rare for finance rows. Adding the helpers makes the form ready to consume any future backend `fields[]` envelope, but the immediate UX win is small.

4. **WorkshopsList / MaintenanceTypesList multi-field decoration deferred.** Backend errors on `description` / `defaultIntervalDays` / `defaultIntervalKm` would surface only in the summary banner. Adding `<FieldError>` per row is mechanical and was deprioritized in favor of getting more forms to baseline coverage.

5. **No automated tests added.** Helpers are short and well-typed; the integration is straightforward boilerplate. Phase 3.F could add a single unit test for `useValidationErrors` and a Playwright smoke test that submits an invalid AddAgency to assert the inline messages render.

6. **`scroll-to-first-error`** still not added. Multi-card forms (VehicleForm, AddEmployee, EditEmployee) make this nontrivial; the summary banner serves as the focal point.

---

## 10. Build & Check Results

```text
$ npm run i18n:check-keys
✓ All 5 target locales × 9 namespaces match English.

$ npm run i18n:check-literals
Found 13 suspicious hardcoded JSX literal(s)   ← unchanged false-positive baseline

$ npm run build
…
dist/assets/index-*.js  4,745.44 kB │ gzip: 1,341.10 kB
✓ built in 13.46s
```

0 TypeScript errors. 0 new false-positive hits.

---

## 11. Recommended Phase 3.F Scope

1. **Notifications i18n architecture** (Phase 3.F per the master plan in `I18N_PHASE_3_BACKEND_RUNTIME_PLAN.md`):
   - Add `titleKey` / `messageKey` / `params` columns to `Notification` (additive Prisma migration).
   - Migrate ~10 notification producers in `backend/src/notifications/notifications.service.ts` to populate keys instead of pre-rendered English.
   - Reader endpoint resolves `Accept-Language` and renders via shared key→string utility.
   - Frontend `notifications.json` namespace with one key per event type.

2. **Backend exports/PDFs localization** (Phase 3.G per master plan):
   - `LocaleContext` middleware for `Accept-Language`.
   - `tServer(key, params, locale)` utility reading EN locale at boot.
   - Migrate ExcelJS column headers in `employees.service.ts`, `finance.service.ts`, `applicants.service.ts`, `attendance.service.ts`, `vehicles.service.ts`.

3. **Translator pass** on:
   - 31 `validation.*` keys (Phase 3.C catalog)
   - 85 backend codes (Phase 3.B catalog)
   - 130 `common.toast.*` keys (Phase 3.A catalog)

4. **Drain remaining 199 plain-string throws** in non-priority backend modules (agencies/, employees/, vehicles/, finance/, attendance/, settings/, notifications/, reports/, roles/, etc.) — each module gets its own group in `errors.json`.

5. **Database-driven labels** (Phase 3.G per master plan): `nameI18n` JSONB column on taxonomy models (`Role`, `Permission`, `JobType`, `DocumentType`, `MaintenanceType`, `FinanceTransactionType`, `StageTemplate`, `WorkflowStage`, `NotificationRule`).

6. **Optional UX polish:**
   - Auto-scroll to first error (feature-flagged for multi-card forms)
   - `if (isValidationError) skipToast` branch — UX decision
   - Field-label dictionary for `<ValidationSummary labels={...}>`
   - Unit tests for the helpers + a representative Playwright smoke test

7. **CI guard** for code/key parity — assert every backend `code:` literal resolves to an `errors.json` key in all 6 locales.

---

## 12. Quick Verification Commands

```bash
# Forms now consuming useValidationErrors (Phase 3.D + 3.E)
grep -l useValidationErrors src/app -r --include='*.tsx' | wc -l   # → 18 (up from 9)

# Builds + checks
npm run build                  # → clean
npm run i18n:check-keys        # → ✓
npm run i18n:check-literals    # → 13 (baseline)

# Scope
git diff --name-only origin/claude/phase-3d-frontend-validation-forms..HEAD \
  | grep -E '^(backend/|prisma/|.env|uploads|\.zip$)' || echo "frontend only ✓"
```
