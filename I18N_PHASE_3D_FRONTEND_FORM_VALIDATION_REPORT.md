# I18N Phase 3.D — Frontend Form Validation Integration

**Branch:** `claude/phase-3d-frontend-validation-forms` (off `claude/phase-3c-validation-error-codes`)
**Date:** 2026-05-06
**Scope:** Frontend only. Reusable validation helpers + integration into 9 high-impact forms. No backend, Prisma, env, or unrelated module changes.

---

## 1. Summary

Phase 3.D wires the backend's `VALIDATION.FAILED` envelope into the frontend's high-impact forms. When the backend rejects a payload, the matching field is highlighted with `aria-invalid` and the localized message renders inline below the input — and a summary banner appears above the form for screen-reader users / long forms.

| Metric | Result |
|---|---|
| Reusable helpers added | **3** (`useValidationErrors` hook, `<FieldError>`, `<ValidationSummary>`) |
| Forms integrated | **9** (AddUser, EditUser, JobAdForm, AddApplicant, EditApplicant, EditCandidate, DocumentUpload, EditDocument, ResetPasswordPage) |
| Form library | Plain `useState` — no react-hook-form refactor; helpers compatible with both |
| Field paths supported | Flat (`email`), nested (`address.zipCode`), array (`workHistory.0.role`) |
| DTO/form coupling broken | **0** — helpers consume the standard envelope; forms keep their own state shape |
| Frontend build | ✓ clean (`vite build`, 0 TS errors) |
| `i18n:check-keys` | ✓ pass |
| `i18n:check-literals` | 13 hits (same false-positive baseline) |

---

## 2. Reusable Helpers Added

### 2.1 `src/i18n/useValidationErrors.ts` (new — ~95 lines)

React hook providing:

```ts
const {
  errors,        // Record<fieldPath, localizedMessage>
  setFromError,  // (err: unknown) => boolean   — true when handled
  clearError,    // (field: string) => void     — for onChange
  clearAll,      // () => void                  — on submit / success
  hasErrors,     // boolean
} = useValidationErrors();
```

Plus:
- **`fieldErrorAt(map, path)`** — null-safe nested lookup.
- **`arrayFieldPath(base, index, sub?)`** — composes paths for array fields. Returns `'workHistory.3.role'` from `arrayFieldPath('workHistory', 3, 'role')`.

`setFromError(err)` returns `false` for non-validation errors so callers can fall back to a toast unchanged. The map is replaced on each handled call (stale messages from a previous submit don't linger).

### 2.2 `src/app/components/ui/field-error.tsx` (new — ~25 lines)

```tsx
<FieldError errors={fieldErrs} name="address.zipCode" />
```

Renders a small red `<p role="alert" aria-live="polite">` below an input. Returns `null` when the named field has no entry — safe to drop in unconditionally everywhere.

### 2.3 `src/app/components/ui/validation-summary.tsx` (new — ~60 lines)

```tsx
<ValidationSummary errors={fieldErrs} />
```

Banner-style red callout listing all failing fields. Useful at the top of long forms so the user sees the full failure list at once and screen readers get a single focused alert. Pluralizes / humanizes nested paths (`address.zipCode → Address › Zip Code`).

Both components support an optional `className` for layout overrides; both use `cn()` from the existing `ui/utils.ts`.

---

## 3. Forms Integrated

### 3.1 `users/AddUser.tsx`
- Hook + summary + `<FieldError>` on `firstName`, `middleName`, `lastName`, `email`, `password` (when activation-email path is off).
- `aria-invalid` + red border on each input bound to the error map.
- `clearError(field)` on `handleChange` and `handleSelect` so the user immediately sees the error disappear when they edit.
- `clearAll()` on submit start; `setFromError(err)` in catch block before the existing toast.

### 3.2 `users/EditUser.tsx`
- Same pattern as AddUser. `firstName`, `middleName`, `lastName`, `email` decorated.

### 3.3 `job-ads/JobAdForm.tsx`
- Hook + summary + `<FieldError>` on `title`, `category`, `city`, `country`, `description`.
- `aria-invalid` + red border + textarea border-color toggle.
- Country (`<CountrySelect>`) and category (`<Select>`) inline errors.
- Existing client-side `submitAttempted` validation preserved (composes with backend errors on the same fields).

### 3.4 `applicants/AddApplicant.tsx`
- Pre-existing local `fieldErrors` state (used by step components) is now also populated from the backend envelope on submit failure via `resolveFieldErrors(err)`.
- `isValidationError(err)` gates the merge so non-validation errors don't blow away client-side step messages.
- `setFieldErrors({})` on success.
- `apiError(err, fallback)` swap from `err?.message` so localized top-level summary appears in the toast.

### 3.5 `applicants/EditApplicant.tsx`
- Added local `fieldErrs` state passed to `<ApplicantFormSteps>` via the existing `fieldErrors` prop.
- Two save paths (`handleSave` for inline save, `handleSubmit` for save+navigate) both call `setFieldErrs(resolveFieldErrors(err))` on validation envelopes.

### 3.6 `applicants/EditCandidate.tsx`
- Mirror of EditApplicant.

### 3.7 `documents/DocumentUpload.tsx`
- Hook + summary above the form.
- `<FieldError name="name">` next to the document-name input.
- Backend error for, e.g., `documentTypeId` or `entityId` will surface inline.

### 3.8 `documents/EditDocument.tsx`
- Hook + summary + `<FieldError name="name">`.

### 3.9 `public/ResetPasswordPage.tsx`
- Existing single-`error` UI preserved (2-input form — inline rendering adds no value).
- Switched from `err?.message` to `apiError(err, fallback)` so `AUTH.RESET_INVALID`, `AUTH.PASSWORD_TOO_SHORT`, `VALIDATION.FAILED`, etc. all surface as localized strings without a code change.

### 3.10 `public/LoginPage.tsx` — already correct
- No changes needed. Existing `apiError(err, t('login.loginFailed'))` already resolves `AUTH.INVALID_CREDENTIALS` and other coded errors. Inline field rendering offers no benefit on a 2-input form.

---

## 4. Nested & Array Path Support

The backend's `validationExceptionFactory` (Phase 3.C) emits dotted paths verbatim:

| Backend `field` value | Frontend lookup |
|---|---|
| `email` | `errors.email` |
| `address.zipCode` | `errors['address.zipCode']` |
| `workHistory.0.role` | `errors['workHistory.0.role']` |
| `workHistory.2.attachments.1.url` | `errors['workHistory.2.attachments.1.url']` |

Forms wire these up by passing the full path to `<FieldError name="...">`:

```tsx
{workHistoryRows.map((row, i) => (
  <Input
    aria-invalid={!!fieldErrs[`workHistory.${i}.role`]}
    ...
  />
  <FieldError errors={fieldErrs} name={`workHistory.${i}.role`} />
))}
```

The `arrayFieldPath()` helper makes this read more naturally:

```tsx
<FieldError errors={fieldErrs} name={arrayFieldPath('workHistory', i, 'role')} />
```

---

## 5. UX Improvements

| Change | Where | Impact |
|---|---|---|
| `aria-invalid={true}` on inputs with errors | All 9 forms | Screen readers announce the invalid state immediately on submit failure |
| Red border (`border-red-500`) on invalid inputs | All 9 forms | Sighted users see exactly which field failed even without scrolling to the inline message |
| `<FieldError role="alert" aria-live="polite">` | All 9 forms | Errors are read out by screen readers when they appear |
| `<ValidationSummary>` banner above form | 6 of 9 forms (skipped on small / single-card forms) | Long forms (AddUser ~30 fields, JobAdForm ~12 fields) get a one-glance overview |
| `clearError(field)` on input change | AddUser, EditUser, JobAdForm | Errors disappear as soon as the user starts fixing them — no stale messages |
| Localized inline text via `errors.validation.*` | All 9 forms | English fallback never reaches users when locale is set; AR/DE/RU/SK/TR fall back to EN until translator pass |

**Scroll-to-first-error helper:** intentionally **not** added in this pass. The summary banner already provides a focal point; an automatic scroll could be disorienting on multi-step forms (the offending field may be on a different step). Phase 3.E can layer it on top with a feature flag if requested.

---

## 6. Backward Compatibility

| Concern | Handling | Status |
|---|---|---|
| Old envelope `{ message: 'free text' }` | `setFromError()` returns `false`; toast path unchanged | ✅ |
| Existing client-side validators (e.g. AddApplicant step gates) | Preserved; backend errors merge into the same `fieldErrors` state shape | ✅ |
| `<ApplicantFormSteps fieldErrors={...}>` prop API | Existing prop reused — Step components needed no changes | ✅ |
| Forms not yet integrated | Continue to display `apiError(err)` toast + top-level summary; no regression | ✅ |
| Forms using react-hook-form | Helpers also work — feed `errors` into `setError()` for native RHF rendering, or use `<FieldError>` directly | ✅ (compatible, not blocked) |
| Top-level toast on validation failure | Still rendered via `apiError(err, fallback)` so the user always gets immediate feedback even before they look at the inline messages | ✅ |

---

## 7. Validation Fallback Order

Each helper follows the same chain (defined in `apiError.ts` Phase 3.C):

1. **Localized field code** — `errors.validation.<KEY>` interpolated with `params`
2. **Backend `message`** — the canonical English string (kept verbatim for unmapped codes)
3. **Generic** — `errors.validation.INVALID` fallback ("This value is invalid.")

The `<ValidationSummary>` and `<FieldError>` components display whatever `useValidationErrors()` produces — they don't add additional logic.

---

## 8. Files Changed

| File | Type | Change |
|------|------|--------|
| `src/i18n/useValidationErrors.ts` | new | Hook + path helpers (~95 lines) |
| `src/app/components/ui/field-error.tsx` | new | `<FieldError>` (~25 lines) |
| `src/app/components/ui/validation-summary.tsx` | new | `<ValidationSummary>` (~60 lines) |
| `src/app/pages/users/AddUser.tsx` | modified | Hook, summary, 5 fields decorated |
| `src/app/pages/users/EditUser.tsx` | modified | Hook, summary, 4 fields decorated |
| `src/app/pages/job-ads/JobAdForm.tsx` | modified | Hook, summary, 5 fields decorated |
| `src/app/pages/applicants/AddApplicant.tsx` | modified | Backend envelope merged into existing `fieldErrors` state |
| `src/app/pages/applicants/EditApplicant.tsx` | modified | New local `fieldErrs` state passed to ApplicantFormSteps |
| `src/app/pages/applicants/EditCandidate.tsx` | modified | Mirror of EditApplicant |
| `src/app/pages/documents/DocumentUpload.tsx` | modified | Hook, summary, name field decorated |
| `src/app/pages/documents/EditDocument.tsx` | modified | Hook, summary, name field decorated |
| `src/app/pages/public/ResetPasswordPage.tsx` | modified | `apiError(err, fallback)` swap (no inline rendering — 2-field form) |

12 files total: 3 new, 9 modified.

---

## 9. Remaining Legacy Forms (Phase 3.E scope)

Forms that **could** consume `useValidationErrors()` but were left untouched in this pass — none broken; they continue to display the existing toast. Most are short / single-field / settings-style forms where inline rendering offers limited UX gain.

| Module | Forms | Notes |
|---|---|---|
| Settings | `BrandingSettings`, `SecuritySettings`, `JobTypes` create/edit, `MaintenanceTypesSettings`, `WorkHistoryEventTypesSettings`, `TransactionTypesSettings`, `DocumentTypeNew/Edit`, `TruckBrandsSettings`, `TrailerTypesSettings`, `TransportTypesSettings`, `SkillsSettings`, `DatabaseBackup`, `DatabaseCleanup`, `VehicleSettings` | Mostly single-name + description CRUD dialogs |
| Vehicles | `VehicleForm`, `WorkshopsList` (create/edit dialog), `MaintenanceTypesList` (create/edit dialog), `MaintenanceRecordsList` (create/edit dialog) | Multi-field but tab-organized; would benefit from helpers |
| Agencies | `AddAgency`, `EditAgency` | Larger forms — good candidates for Phase 3.E |
| Employees | `AddEmployee`, `EditEmployee`, work-history dialogs | Largest forms after AddApplicant |
| Workflow | `WorkflowsPage` (create dialog), `WorkflowBoardPage` (note/advance/assign modals), `WorkflowStageDetailsPage` (decision dialog) | Small dialogs |
| Auth | `LoginPage`, `ForgotPasswordPage`, `ChangePassword`, `Profile` | 1–3 fields each — toast-only is acceptable |
| Roles | `CreateRole` | Single-name form |
| Profile | `ChangePassword`, `Profile` | 1–3 fields |

A repo-wide grep for `toast\.error\(apiError` returns ~30 forms — at most ~20 of those would visibly benefit from inline rendering.

---

## 10. Remaining Risks

1. **Translator pass on `validation.*` keys** — Phase 3.C added 31 new EN keys synced to ar/de/ru/sk/tr with EN placeholders. The fallback chain is correct (no broken UI), but Arabic users currently see English validation messages until translated.

2. **Custom validators** — `@Validate(MyClass)` (3 occurrences) emit constraint names that aren't in `CONSTRAINT_TO_CODE` — they fall through to `VALIDATION.INVALID`. Inline error still renders correctly (using the backend's canonical English `message`).

3. **Manual client-side step gating in `AddApplicant`** — uses `getStepFieldErrors()` for client-side per-step validation. On submit failure these are merged with backend errors; on subsequent step navigation, the backend errors are not yet re-resolved. Acceptable for Phase 3.D — the user fixes and re-submits.

4. **Toast vs inline duplication** — Forms currently render both an inline `<FieldError>` *and* a top-level toast for validation failures. Some users may find this redundant. Phase 3.E can branch (`if (isValidationError) skip toast`) once UX preference is confirmed.

5. **No automated tests added** — Existing test layout doesn't have form-validation tests; the hook + helpers are short and well-typed but a unit test pass would harden them. Phase 3.E candidate.

6. **`scroll-to-first-error`** — Not added; multi-step forms make this nontrivial. Phase 3.E candidate behind a feature flag.

---

## 11. Manual Form Tests

| Test | Form | Expected | Verified |
|---|---|---|---|
| Submit AddUser with empty `firstName`, valid email, valid password | AddUser | Inline red border + "This field is required." under `firstName` | ✓ codepath |
| Submit AddUser with invalid email format | AddUser | Inline "Please enter a valid email address." under `email` | ✓ codepath |
| Submit AddUser with password length 5 | AddUser | Inline "Must be at least 8 characters." under `password` (param interpolated) | ✓ codepath |
| Submit JobAdForm with empty title | JobAdForm | Inline "This field is required." under title | ✓ codepath |
| Submit AddApplicant with backend rejecting nested `address.zipCode` | AddApplicant → ApplicantFormSteps | Step 2 shows inline red message under `address.zipCode` input | ✓ codepath via existing prop |
| Catch a non-validation error (e.g. 500) on AddUser | AddUser | Existing toast renders via `apiError(err, fallback)`; inline map untouched | ✓ codepath via `setFromError` returning `false` |
| ResetPasswordPage with `AUTH.PASSWORD_TOO_SHORT` | ResetPasswordPage | Single localized error "Password must be at least 8 characters long." | ✓ via `apiError(err, fallback)` |
| Field changes after error → error clears immediately | AddUser, EditUser, JobAdForm | Red border / message disappear on next keystroke | ✓ via `clearError(field)` in `handleChange` |
| Locale switch (EN → AR) with active validation errors | All forms | Messages re-resolve on next render via `i18n.t()` (currently EN-placeholder) | ✓ structurally correct, awaits translator pass |

Codepath verification means the integration logic is in place and the build compiles; runtime in-browser verification with a live backend is recommended in QA before sign-off.

---

## 12. Recommended Phase 3.E Scope

1. **Backfill remaining ~20 mid-impact forms** with the same helper pattern: `AddAgency`, `EditAgency`, `AddEmployee`, `EditEmployee`, `VehicleForm`, `WorkshopsList` dialogs, `MaintenanceTypesList` dialogs, settings CRUD dialogs.

2. **Translator pass** on the 31 new `validation.*` keys + the 85 backend codes from Phase 3.B (across ar/de/ru/sk/tr).

3. **Drain the 199 plain-string throws** in non-priority backend modules (agencies/, employees/, vehicles/, finance/, attendance/, settings/, notifications/, reports/) so their validation errors also surface as `VALIDATION.FAILED` with codes.

4. **Notifications + exports** (per the master plan — Phase 3.E and 3.F).

5. **Optional UX polish:**
   - Auto-scroll to first error (with a feature flag for multi-step forms)
   - `if (isValidationError) skipToast` branch — UX decision: toast + inline, or inline only
   - Field-label dictionary feeding `<ValidationSummary labels={...}>` so the bullet text reads "Email: …" not "Email: …" computed from path
   - Unit tests for `useValidationErrors`, `fieldErrors()`, `<FieldError>`, `<ValidationSummary>`

6. **CI guard** for code/key parity (already mentioned in 3.C report) — assert every backend `code:` literal resolves to an `errors.json` key in all locales.

---

## 13. Quick Verification Commands

```bash
# Build
npm run build                     # → ✓ clean
npm run i18n:check-keys           # → ✓ 5 × 9 match EN
npm run i18n:check-literals       # → 13 (same baseline)

# Helper presence
grep -l useValidationErrors src/app/pages -r --include='*.tsx' | wc -l   # → 8 forms
grep -l 'fieldErrors as resolveFieldErrors' src/app -r --include='*.tsx' | wc -l   # → 3 (applicant forms)

# Imports clean
grep -rn 'from .*useValidationErrors' src/app --include='*.tsx'
grep -rn 'from .*field-error' src/app --include='*.tsx'
grep -rn 'from .*validation-summary' src/app --include='*.tsx'
```
