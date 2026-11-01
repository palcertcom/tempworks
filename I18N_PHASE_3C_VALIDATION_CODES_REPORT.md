# I18N Phase 3.C — Validation Error Codes

**Branch:** `claude/phase-3c-validation-error-codes` (off `claude/phase-3b-backend-error-codes`)
**Date:** 2026-05-06
**Scope:** Centralized class-validator → stable-code translation. **No DTO file edits.** Backend filter, pipe wiring, frontend helper, locale catalogs only.

---

## 1. Summary

Phase 3.C wires a single, centralized `exceptionFactory` into the global `ValidationPipe` so every DTO failure produces a coded envelope the frontend can render inline next to the offending field. Achieved without touching a single DTO file — the constraint→code mapping lives in one place.

| Metric | Result |
|---|---|
| ValidationPipe `exceptionFactory` wired | ✓ |
| class-validator constraints mapped to stable codes | **35** |
| `VALIDATION.*` codes in registry | **31** (covers all 16 distinct decorators in active use) |
| Frontend `validation.*` translation keys | **31** (1:1 coverage + 5 legacy lowercase aliases) |
| Locales synced (ar / de / ru / sk / tr) | ✓ All 5 × 9 namespaces match EN |
| DTO files edited | **0** (out of scope per spec) |
| Backend build | ✓ clean (`nest build`) |
| Frontend build | ✓ clean (`vite build`, 0 TS errors) |
| `i18n:check-keys` | ✓ pass |
| `i18n:check-literals` | 13 hits (same baseline) |
| Smoke-tested factory and frontend resolver against representative inputs | ✓ |

---

## 2. Validation Response Format

The wire envelope is forwarded by `I18nExceptionFilter` verbatim:

```json
{
  "statusCode": 400,
  "error": "Bad Request",
  "code": "VALIDATION.FAILED",
  "message": "Validation failed: email must be an email; password must be longer than or equal to 8 characters",
  "fields": [
    {
      "field": "email",
      "code": "VALIDATION.EMAIL_INVALID",
      "message": "email must be an email"
    },
    {
      "field": "password",
      "code": "VALIDATION.MIN_LENGTH",
      "message": "password must be longer than or equal to 8 characters",
      "params": { "min": 8 }
    },
    {
      "field": "address.zipCode",
      "code": "VALIDATION.PATTERN_INVALID",
      "message": "zipCode must match /^\\d{5}$/ regular expression"
    }
  ],
  "timestamp": "2026-05-06T19:02:14.555Z",
  "path": "/api/v1/users"
}
```

**Key properties:**
- `code: 'VALIDATION.FAILED'` at the top level — frontend can branch (`isValidationError(err)`) between toast vs inline rendering.
- `fields[]` is a flat array of dotted paths, suitable for keying into form state. Nested DTOs surface as `parent.child`; array indices appear as numeric segments (`workHistory.0.role`).
- Every field has a `code`, a canonical English `message` (the original class-validator string), and optional `params` (numeric thresholds extracted from the message).
- Top-level `message` joins the per-field messages so legacy clients reading only `message` see something meaningful.
- Backward compatibility: untouched throws (e.g. inside services) still flow through the filter and emit `GENERIC.*` codes with no `fields` array — no client sees a regression.

---

## 3. Files Added

| File | Purpose | Lines |
|------|---------|-------|
| `backend/src/common/errors/validation-exception.factory.ts` | `validationExceptionFactory` for `ValidationPipe`; `CONSTRAINT_TO_CODE` map; `flattenErrors` walker; `extractParams` to pull numeric thresholds out of messages | ~150 |

---

## 4. Files Modified

| File | Change |
|------|--------|
| `backend/src/common/errors/error-codes.ts` | Replaced 8-entry `VALIDATION.*` block with **31 codes** covering all class-validator decorators in use and several reserved for future custom validators |
| `backend/src/common/i18n/i18n-exception.filter.ts` | `CodedErrorBody.fields?: …` field added to interface; filter now forwards `fields[]` from coded responses to the wire body when present |
| `backend/src/main.ts` | Imported `validationExceptionFactory`; wired into the global `ValidationPipe({ ..., exceptionFactory })` |
| `src/i18n/apiError.ts` | Added `BackendFieldError` interface, `fieldErrors(err)` helper that returns `Record<fieldPath, localizedMessage>`, and `isValidationError(err)` predicate |
| `src/i18n/locales/en/errors.json` | Replaced flat `validation.*` block with **31 uppercase codes** (matches backend codes 1:1) plus retained lowercase legacy aliases (`required`, `email`, `minLength`, `maxLength`, `passwordsDoNotMatch`) for any inline form-validation already using them |
| `src/i18n/locales/{ar,de,ru,sk,tr}/errors.json` | Synced from EN (preserves prior translations; new keys carry EN placeholders pending translator pass) |

---

## 5. Constraint → Code Mapping

`backend/src/common/errors/validation-exception.factory.ts` defines the canonical map. Anything not listed falls through to `VALIDATION.INVALID`, so unknown / custom validators ship a sensible code without registry updates.

| class-validator constraint | Stable code |
|---|---|
| `isNotEmpty`, `isDefined`, `arrayNotEmpty` | `VALIDATION.REQUIRED` |
| `isString` | `VALIDATION.STRING_EXPECTED` |
| `isNumber`, `isInt` | `VALIDATION.NUMBER_EXPECTED` |
| `isBoolean` | `VALIDATION.BOOLEAN_EXPECTED` |
| `isArray` | `VALIDATION.ARRAY_EXPECTED` |
| `isObject` | `VALIDATION.OBJECT_EXPECTED` |
| `isDate`, `isDateString`, `isISO8601` | `VALIDATION.DATE_INVALID` |
| `isEmail` | `VALIDATION.EMAIL_INVALID` |
| `isUUID` | `VALIDATION.UUID_INVALID` |
| `isUrl` | `VALIDATION.URL_INVALID` |
| `isPhoneNumber` | `VALIDATION.PHONE_INVALID` |
| `matches` | `VALIDATION.PATTERN_INVALID` |
| `isAlpha` | `VALIDATION.ALPHA_EXPECTED` |
| `isAlphanumeric` | `VALIDATION.ALPHANUMERIC_EXPECTED` |
| `isNumberString` | `VALIDATION.NUMBER_STRING_EXPECTED` |
| `minLength`, `arrayMinSize` | `VALIDATION.MIN_LENGTH` *(`params.min` extracted)* |
| `maxLength`, `arrayMaxSize` | `VALIDATION.MAX_LENGTH` *(`params.max` extracted)* |
| `length` | `VALIDATION.LENGTH` *(`params.min`, `params.max` extracted)* |
| `min` | `VALIDATION.MIN_VALUE` *(`params.min` extracted)* |
| `max` | `VALIDATION.MAX_VALUE` *(`params.max` extracted)* |
| `isPositive` | `VALIDATION.POSITIVE_REQUIRED` |
| `isNegative` | `VALIDATION.NEGATIVE_REQUIRED` |
| `isEnum`, `isIn` | `VALIDATION.ENUM_INVALID` |
| `isNotIn` | `VALIDATION.NOT_IN_REQUIRED` |
| `isFile` | `VALIDATION.FILE_INVALID` |
| `hasMimeType` | `VALIDATION.FILE_TYPE_INVALID` |
| `maxFileSize` | `VALIDATION.FILE_TOO_LARGE` |
| *(any unmapped)* | `VALIDATION.INVALID` |

35 constraints → 31 distinct codes.

---

## 6. DTOs Covered

**Every DTO in the codebase**, by virtue of the global `ValidationPipe.exceptionFactory`. The mapping is centralized — no per-DTO edits were needed and none were made.

Decorators present in the codebase (counts via grep) — all map to stable codes:

| Decorator | Count | Maps to |
|---|---:|---|
| `@IsOptional` | 168 | (no error — optional fields don't surface) |
| `@IsString` | 92 | `STRING_EXPECTED` |
| `@IsEnum` | 11 | `ENUM_INVALID` |
| `@IsDateString` | 11 | `DATE_INVALID` |
| `@Type` | 9 | (transformation, not validation) |
| `@IsIn` | 9 | `ENUM_INVALID` |
| `@IsBoolean` | 7 | `BOOLEAN_EXPECTED` |
| `@IsArray` | 5 | `ARRAY_EXPECTED` |
| `@IsObject` | 5 | `OBJECT_EXPECTED` |
| `@MinLength` | 4 | `MIN_LENGTH` |
| `@Min` | 4 | `MIN_VALUE` |
| `@IsInt` | 4 | `NUMBER_EXPECTED` |
| `@Validate` | 3 | (custom validator → `INVALID` fallback) |
| `@IsEmail` | 3 | `EMAIL_INVALID` |
| `@Max` | 2 | `MAX_VALUE` |
| `@IsNotEmpty` | 2 | `REQUIRED` |
| `@IsUUID` | 1 | `UUID_INVALID` |

**100% coverage of decorators in active use.** Priority modules confirmed:

| Module | DTO files | Decorator coverage |
|---|---|---|
| `auth/dto/` | `login.dto`, `refresh-token.dto`, `change-password.dto`, `reset-password.dto`, `2fa.dto`, etc. | ✓ |
| `users/dto/` | `create-user.dto`, `update-user.dto`, `update-profile.dto`, `update-preferences.dto` | ✓ |
| `applicants/dto/` | `create-applicant.dto`, `update-applicant.dto`, applicant draft DTOs | ✓ |
| `documents/dto/` | `create-document.dto`, `verify-document.dto`, `renew-document.dto` | ✓ |
| `pipeline/dto/` | `create-pipeline.dto` (workflow + stage + assignment DTOs) | ✓ |
| `finance/dto/` | finance transaction + record DTOs | ✓ |

---

## 7. Frontend Behavior

### 7.1 Inline form errors

```ts
import { fieldErrors, isValidationError, apiError } from '@/i18n/apiError';

try {
  await usersApi.create(formData);
} catch (err) {
  if (isValidationError(err)) {
    const errs = fieldErrors(err);
    // errs = { email: 'Please enter a valid email address.', password: 'Must be at least 8 characters.' }
    setFieldErrors(errs);
  } else {
    toast.error(apiError(err));   // existing single-toast path, unchanged
  }
}
```

### 7.2 Translation lookup

`fieldErrors()` walks the `fields[]` array, splits each `code` on the dot, lower-cases the group, and looks up `errors.<group>.<KEY>` with `params` interpolated. When the code is unknown, it falls back to the backend's English `message` and finally to `validation.INVALID`.

### 7.3 Backward compatibility

- Existing toast handlers calling `toast.error(apiError(err))` remain correct: `apiError()` returns the top-level `message` summary (`"Validation failed: email must be an email; password must be at least 8 characters"`).
- Forms that don't yet consume `fieldErrors()` continue to receive the toast.
- Forms that already display their own client-side validation messages keep working — `fieldErrors()` is opt-in.

---

## 8. Smoke Tests

### 8.1 Backend factory

```text
$ node -e "require('./dist/common/errors/validation-exception.factory')
    .validationExceptionFactory([
      { property: 'email', constraints: { isEmail: 'email must be an email' } },
      { property: 'password', constraints: { minLength: 'password must be longer than or equal to 8 characters' } },
      { property: 'address', children: [
        { property: 'zipCode', constraints: { matches: 'zipCode must match …' } }
      ]}
    ]).getResponse()"
{
  "code": "VALIDATION.FAILED",
  "message": "Validation failed: email must be an email; password must be longer than or equal to 8 characters; zipCode must match …",
  "fields": [
    { "field": "email", "code": "VALIDATION.EMAIL_INVALID", "message": "email must be an email" },
    { "field": "password", "code": "VALIDATION.MIN_LENGTH", "message": "password must be longer than or equal to 8 characters", "params": { "min": 8 } },
    { "field": "address.zipCode", "code": "VALIDATION.PATTERN_INVALID", "message": "zipCode must match …" }
  ]
}
```

✓ codes correct, `params.min` extracted, nested path `address.zipCode` flattened.

### 8.2 Frontend resolver

```text
email           → "Please enter a valid email address."
password        → "Must be at least 8 characters."             (params: { min: 8 } interpolated)
address.zipCode → "This value does not match the required pattern."
unknownField    → "unknown constraint"                         (falls back to backend message)
```

✓ known codes localize, `params` interpolate, unknown codes degrade gracefully.

---

## 9. Backward Compatibility

| Concern | Handling | Status |
|---|---|---|
| `BadRequestException(['msg', 'msg'])` array shape | Filter joins arrays; pre-existing behavior preserved for non-validation throws | ✅ |
| `BadRequestException('plain text')` | Filter assigns `code: 'GENERIC.BAD_REQUEST'`; no `fields` array; no client breakage | ✅ |
| Old clients reading only `message` | Top-level `message` summarizes per-field errors with `;` separators | ✅ |
| `instanceof BadRequestException` checks | Factory returns a `BadRequestException` (Nest still classifies status as 400) | ✅ |
| Forms with their own validation strings | Untouched; `fieldErrors()` is opt-in per call site | ✅ |
| Swagger / OpenAPI consumers | Schema still emits `statusCode`, `error`, `message` — `code` and `fields` are additive | ✅ |
| Existing custom `Validate(MyClass)` validators | Their constraint name (the validator class name) falls through to `VALIDATION.INVALID`; `message` from the validator is preserved | ✅ |

---

## 10. Known Limitations

1. **No DTO files were edited** — per the spec ("Do not refactor every DTO manually unless necessary"). The mapping is centralized; if a DTO uses a custom validator with a non-standard constraint name, it gets `VALIDATION.INVALID` until the constraint is added to `CONSTRAINT_TO_CODE`. The backend `message` is preserved either way, so the user still sees a meaningful English string (and the active locale's `validation.INVALID` text in non-EN locales).

2. **Class-validator messages are still in English on the wire.** The frontend `validation.*` keys override the English text once translated. Non-EN locales currently carry EN placeholders for the new keys; translator pass needed before AR/DE/RU/SK/TR users see Arabic/German/Russian/Slovak/Turkish validation feedback. Until then, i18next's fallback chain returns the EN string and behavior is correct.

3. **Custom validators that emit multi-key constraints** (rare in this codebase — only `@Validate(SomeClass)` × 3 occurrences) emit one field-error per constraint key. The factory handles this correctly but each entry will get `VALIDATION.INVALID` until mapped.

4. **No frontend forms migrated** to use `fieldErrors()` in this pass. Forms continue to display the existing toast via `apiError()`. Phase 3.D scope.

5. **`@Type(() => SomeClass)` transformations** that fail (e.g. coercing a string to a Date and getting NaN) currently surface as the underlying validator's error (`isDate`, `isNumber`, etc.) — already covered. No additional work required.

6. **File-upload validators** (`isFile`, `hasMimeType`, `maxFileSize`) are **mapped but not currently emitted** by any DTO — file validation today happens in controllers via custom Multer interceptors that throw `BadRequestException` directly (Phase 3.B already coded those). The mapping is reserved for future migration to typed file DTOs.

7. **Top-level `message` summary** can grow long when a DTO has many fields fail at once. UI consuming the toast path may want to truncate. Inline rendering via `fieldErrors()` sidesteps this entirely.

---

## 11. Recommended Phase 3.D Scope

1. **Migrate frontend forms to consume `fieldErrors()`.** Priority: Add User, Edit User, Add Applicant, Edit Applicant, Login (forgot password / reset password), DocumentTypeNew/Edit, Workshop create/edit. Each form gets a `<FormFieldError name="email" />` component or similar.

2. **Translator pass on the new `validation.*` keys.** Currently 31 new keys carry EN placeholders in ar/de/ru/sk/tr. The fallback chain is correct (no broken UI), but Arabic users will see English validation messages until translated.

3. **Migrate the 199 remaining plain-string throws** in non-priority modules (agencies, employees, vehicles, finance, attendance, settings, notifications, reports) to coded form. The filter handles them correctly today (`GENERIC.<STATUS>`); locale-aware messages need module-specific codes.

4. **Email i18n verification** — confirm `email-i18n.ts` covers all 6 locales for all 10 templates and that `EmailService.send*` callers thread `user.preferredLocale`.

5. **CI guard** — add `scripts/i18n-check-codes.mjs` that asserts every backend `code:` literal in `backend/src/**/*.ts` resolves to a key in `src/i18n/locales/en/errors.json` for all 6 locales.

6. **Notifications and exports** (Phase 3.E + 3.F per the master plan) — `titleKey` / `messageKey` columns on `Notification`; `Accept-Language`-aware Excel/PDF column headers.

---

## 12. Quick Verification Commands

```bash
# Constraint coverage
grep -hoE "\\bis(Email|UUID|String|Number|Int|Boolean|Array|Object|Date|DateString|ISO8601|NotEmpty|Defined|Url|PhoneNumber|Alpha|Alphanumeric|NumberString|Enum|In|NotIn|Positive|Negative|File)\\b" \
  backend/src/common/errors/validation-exception.factory.ts | sort -u | wc -l   # → 25

# Frontend keys present
node -e "const j=require('./src/i18n/locales/en/errors.json'); console.log('validation keys:', Object.keys(j.validation).filter(k=>k===k.toUpperCase()).length)"   # → 31

# Builds + checks
cd backend && npx nest build           # → clean
cd .. && npm run build                  # → clean
npm run i18n:check-keys                 # → ✓ 5 × 9 match EN
npm run i18n:check-literals             # → 13 (same baseline)

# Smoke
node -e "const {validationExceptionFactory}=require('./backend/dist/common/errors/validation-exception.factory'); console.log(JSON.stringify(validationExceptionFactory([{property:'email',constraints:{isEmail:'email must be an email'}}]).getResponse(),null,2))"
```
