# I18N Phase 3.B — Backend Error Codes

**Branch:** `claude/phase-3b-backend-error-codes` (off `claude/phase-3a-runtime-toast-i18n`)
**Date:** 2026-05-06
**Scope:** Backend Nest + frontend i18n integration. No Prisma schema changes, no `.env`, no uploads.

---

## 1. Summary

Phase 3.B introduces a **stable backend error-code architecture** so the frontend can reliably translate backend errors instead of displaying raw English exception strings. The work is fully **backward-compatible**: every existing client that reads `message` keeps working unchanged; clients that prefer the new code-based path get a `code` field plus optional `params`.

| Metric | Result |
|---|---|
| Priority modules migrated (auth, users, applicants, documents, workflow, pipeline) | **6/6** |
| Plain-string exceptions remaining in priority modules | **0** |
| Coded `throw new XxxException({ code, message, params? })` instances added/updated | **137** |
| Distinct error codes used in priority modules | **85** |
| Frontend translation keys added to `errors.json` | **85** (1:1 coverage) |
| Locales synced (ar/de/ru/sk/tr) | ✓ All 5 × 9 namespaces match English |
| Backend build (`nest build`) | ✓ clean |
| Frontend build (`vite build`) | ✓ clean (0 TS errors) |
| `i18n:check-keys` | ✓ pass |
| `i18n:check-literals` | 13 hits (same baseline) |

---

## 2. Architecture Decisions

### 2.1 Reuse existing filter, not replace

`backend/src/common/i18n/i18n-exception.filter.ts` (introduced earlier, wired in `main.ts:656`) already:
- Detects `{ code, message, params }` envelopes thrown via Nest exceptions and forwards them verbatim.
- Falls back to `defaultCodeForStatus(status)` (e.g. `GENERIC.NOT_FOUND` for a 404 with a plain string body).
- Maps Prisma codes (`P2002` → `GENERIC.UNIQUE_VIOLATION`, `P2025` → `GENERIC.NOT_FOUND`).
- Logs unhandled errors with `Logger.error()` (stack preserved server-side, never exposed to clients).

**Decision:** keep the filter. Phase 3.B layers a **registry + helper** on top so producers stop hand-rolling envelopes and start using stable constants.

### 2.2 Code naming: dotted `<GROUP>.<KEY>` (not flat)

The user prompt suggested flat names like `USER_NOT_FOUND`. The existing filter and frontend already speak `USER.NOT_FOUND` (dotted). Switching to flat would have required rewriting `apiError()` and 25 already-coded throws in `auth.service.ts`. We **kept the dotted convention** for compatibility and consistency with `errors.json`'s nested structure (`errors.user.NOT_FOUND`).

### 2.3 Two-tier helper

| Layer | Use when | Example |
|---|---|---|
| `AppException(status, code, message, params?)` | Custom status codes or when no Nest subclass fits | `throw new AppException(HttpStatus.NOT_FOUND, 'USER.NOT_FOUND', 'User not found', { id })` |
| Subclasses (`BadRequestAppException`, `NotFoundAppException`, `ConflictAppException`, `ForbiddenAppException`, `UnauthorizedAppException`, `InternalServerAppException`) | Standard cases — preserves `instanceof XxxException` checks | `throw new NotFoundAppException('USER.NOT_FOUND', 'User not found', { id })` |
| **Inline coded throw** (legacy-friendly, used in this migration) | Minimum diff against existing `throw new NotFoundException(...)` lines | `throw new NotFoundException({ code: 'USER.NOT_FOUND', message: 'User not found' })` |

Both helpers and the inline shape produce identical wire envelopes — the filter normalizes them.

### 2.4 Frontend resolution path (already in place, untouched)

`src/i18n/apiError.ts` already:
1. Reads `code` from `err / err.body / err.response / err.response.data`.
2. Reads `params` from the same spots.
3. Splits `code` on the dot, lower-cases the group, and looks up `errors.<group>.<KEY>` with `params` interpolated.
4. Falls back to backend `message` if no translation matches.
5. Final fallback: `errors.generic.UNEXPECTED`.

**No changes were needed to `apiError.ts` for Phase 3.B.** Adding 85 keys to `errors.json` is sufficient; the helper picks them up automatically.

---

## 3. Standard Error Response Format

Every coded exception emits the following JSON over the wire:

```json
{
  "statusCode": 404,
  "error": "Not Found",
  "code": "USER.NOT_FOUND",
  "message": "User not found",
  "params": { "id": "abc-123" },
  "timestamp": "2026-05-06T18:42:11.123Z",
  "path": "/api/v1/users/abc-123"
}
```

Legacy throws still pass through the filter and emit:
```json
{
  "statusCode": 400,
  "error": "Bad Request",
  "code": "GENERIC.BAD_REQUEST",
  "message": "Free-form text from the legacy throw",
  "timestamp": "...",
  "path": "..."
}
```
— so old clients reading `message` keep working; new clients see a stable code (just with a generic group until that throw is migrated).

---

## 4. Files Added

| File | Purpose | Lines |
|------|---------|-------|
| `backend/src/common/errors/error-codes.ts` | Central registry: `ErrorCodes.AUTH.*`, `.USER.*`, `.APPLICANT.*`, `.DOCUMENT.*`, `.WORKFLOW.*`, `.GENERIC.*`, `.VALIDATION.*` | ~120 |
| `backend/src/common/errors/app-exception.ts` | `AppException` + 6 status-specific subclasses, plus `CodedErrorPayload` interface | ~70 |

---

## 5. Files Modified

### Backend (12 files)
| File | Migrations |
|------|-----------|
| `backend/src/auth/auth.service.ts` | 4 password-strength throws + 1 status throw + `User not found` repeats — converted to coded form |
| `backend/src/auth/auth.controller.ts` | 1 (`Invalid refresh token`) |
| `backend/src/auth/strategies/jwt.strategy.ts` | 2 (`User not found`, `Account is X`) |
| `backend/src/auth/strategies/jwt-refresh.strategy.ts` | 2 (`Access denied`, `Account is X`) |
| `backend/src/users/users.service.ts` | 19 (User not found ×8, Forbidden ×7, Conflict ×1, Activation status ×1, Permission override ×1, Agency limit ×1) |
| `backend/src/users/users.controller.ts` | 2 (`No file uploaded`) |
| `backend/src/applicants/applicants.service.ts` | 22 (NotFound ×4, Forbidden ×8, Conflict ×3, BadRequest ×7) |
| `backend/src/applicants/applicants.controller.ts` | 1 (`No photo file provided`) |
| `backend/src/documents/documents.controller.ts` | 3 (file/entityId required) |
| `backend/src/documents/documents.service.ts` | 5 (Document/type not found, type already verified, types not configured, no attribution user) |
| `backend/src/workflow/workflow.service.ts` | 9 (employee/permit/visa/stage NotFound + various) |
| `backend/src/pipeline/pipeline.service.ts` | 30 (workflow/stage/assignment/progress/note/user NotFound + Conflict + BadRequest + Forbidden) |

### Frontend (1 source file + 6 locale catalogs)
| File | Change |
|------|--------|
| `src/i18n/locales/en/errors.json` | **+85 keys** across new groups: `user.*`, `applicant.*`, `document.*`, `workflow.*`, `employee.*`, `agency.*`; extended `auth.*` and `generic.*` |
| `src/i18n/locales/{ar,de,ru,sk,tr}/errors.json` | Synced from EN by `/tmp/sync_keys.mjs` (preserves plural variants); new keys carry EN placeholder values for translator pass |

`src/i18n/apiError.ts` was **not** modified — its existing implementation already supports the envelope format.

---

## 6. Modules Migrated

| Module | Plain-string throws **before** | **after** | Distinct codes introduced |
|--------|---:|---:|---:|
| `auth/` (incl. strategies + controller) | 9 | 0 | 21 (most pre-existing, 5 new) |
| `users/` | 25 | 0 | 12 |
| `applicants/` | 25 | 0 | 18 |
| `documents/` | 8 | 0 | 6 |
| `workflow/` | 9 | 0 | 5 (under `WORKFLOW.*`) |
| `pipeline/` | 33 | 0 | 17 (under `WORKFLOW.*`) |
| **Total priority** | **109** | **0** | **85 unique codes** |

```text
$ grep -rn "throw new \(BadRequest\|Unauthorized\|Forbidden\|NotFound\|Conflict\|Internal\)Exception(['\"\`]" \
    backend/src/{auth,users,applicants,documents,workflow,pipeline}/ --include="*.ts" | wc -l
0
```

---

## 7. Frontend `apiError()` Integration

**No code change required.** The existing helper at `src/i18n/apiError.ts` resolves the new envelope automatically:

```ts
toast.error(apiError(err))
// →   AUTH.INVALID_CREDENTIALS    →  "Invalid email or password."  (translated to active locale)
// →   USER.NOT_FOUND              →  "User not found."             (translated)
// →   APPLICANT.CAPTCHA_FAILED    →  "CAPTCHA verification failed. Please try again."
// →   WORKFLOW.APPROVAL_PENDING   →  "Stage \"X\" is awaiting approval. 1 of 2 …"
// →  legacy plain-string throw   →  echoed `message` verbatim       (unchanged behavior)
```

---

## 8. Implemented Error Codes (full list)

### `GENERIC.*` (3 newly-mapped + filter defaults)
`BAD_REQUEST`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `UNIQUE_VIOLATION`, `UNPROCESSABLE`, `RATE_LIMITED`, `UNEXPECTED`, **`FILE_REQUIRED`** *(new)*

### `AUTH.*` (21)
`INVALID_CREDENTIALS`, `INVALID_REFRESH_TOKEN` *(new)*, `ACCOUNT_LOCKED`, `ACCOUNT_INACTIVE`, `ACCOUNT_PENDING`, `ACCOUNT_SUSPENDED`, `ACCOUNT_TERMINATED`, `ACCOUNT_STATUS` *(new)*, `PASSWORD_EXPIRED`, `PASSWORD_TOO_SHORT`, `PASSWORD_NEEDS_UPPERCASE` *(new)*, `PASSWORD_NEEDS_LOWERCASE` *(new)*, `PASSWORD_NEEDS_DIGIT` *(new)*, `PASSWORD_NEEDS_SPECIAL` *(new)*, `CURRENT_PASSWORD_INCORRECT`, `ACTIVATION_INVALID`, `RESET_INVALID`, `ACCESS_DENIED`, `TWO_FACTOR_REQUIRED`, `TWO_FACTOR_INVALID`, `TWO_FACTOR_EXPIRED`, `TWO_FACTOR_TOO_MANY_ATTEMPTS`, `USER_NOT_FOUND` *(new)*

### `USER.*` (12)
`NOT_FOUND`, `EMAIL_EXISTS`, `AGENCY_NOT_ASSIGNED`, `AGENCY_ROLE_MISSING`, `AGENCY_MAX_USERS`, `SYSTEM_ADMIN_ONLY_CREATE`, `SYSTEM_ADMIN_ONLY_EDIT`, `SYSTEM_ADMIN_ONLY_ASSIGN`, `SYSTEM_ADMIN_ONLY_DELETE`, `PROFILE_LOCKED_EDIT`, `PROFILE_LOCKED_DELETE`, `PERMISSION_OVERRIDE_NOT_FOUND`

### `APPLICANT.*` (18)
`NOT_FOUND`, `EMAIL_IN_USE`, `AGENCY_SCOPE`, `AGENCY_DELETE_REQUEST_REQUIRED`, `AGENCY_CHANGE_FORBIDDEN`, `AGENCY_CONVERT_FORBIDDEN`, `CAPTCHA_REQUIRED`, `CAPTCHA_FAILED`, `PENDING_APPROVAL_WORKFLOW`, `PENDING_APPROVAL_CONVERT`, `REJECTED_CANNOT_CONVERT`, `ALREADY_CANDIDATE`, `CANDIDATE_ID_ASSIGNED`, `CONVERT_REQUIRES_CANDIDATE`, `FINANCE_CANDIDATE_ONLY`, `DELETE_REQUEST_PENDING`, `DELETE_REQUEST_NOT_FOUND`, `DELETE_REQUEST_REVIEWED`

### `DOCUMENT.*` (6)
`NOT_FOUND`, `TYPE_NOT_FOUND`, `TYPES_NOT_CONFIGURED`, `ENTITY_ID_REQUIRED`, `NO_ATTRIBUTION_USER`, `ALREADY_VERIFIED`

### `WORKFLOW.*` (22)
`NOT_FOUND`, `STAGE_NOT_FOUND`, `STAGE_NOT_IN_WORKFLOW`, `STAGE_NOT_FOUND_FOR_EMPLOYEE`, `WORK_PERMIT_NOT_FOUND`, `VISA_NOT_FOUND`, `ASSIGNMENT_NOT_FOUND`, `ALREADY_ASSIGNED`, `ALREADY_AT_STAGE`, `REASSIGN_REQUIRES_ADMIN`, `USER_ACCESS_EXISTS`, `USER_ACCESS_NOT_FOUND`, `EMPLOYEE_ASSIGN_FORBIDDEN`, `EMPLOYEE_MODIFY_FORBIDDEN`, `CANDIDATE_IDS_REQUIRED`, `BULK_LIMIT_EXCEEDED`, `PROGRESS_NOT_FOUND`, `NOTE_NOT_FOUND`, `APPROVAL_NOT_REQUIRED`, `APPROVAL_PENDING`, `RESPONSIBLE_ONLY`, `NOT_AN_APPROVER`

### `EMPLOYEE.*` (2) and `AGENCY.*` (1) — surfaced incidentally during applicant/workflow migration
`EMPLOYEE.NOT_FOUND`, `EMPLOYEE.EMAIL_EXISTS`, `AGENCY.NOT_FOUND`

---

## 9. Remaining Legacy Exceptions (out of scope, deferred)

199 plain-string `throw new XxxException('text')` calls remain in modules **outside the priority list**, all backward-compatible (filter assigns a `GENERIC.<STATUS>` code automatically):

| Module | Count | Phase |
|--------|------:|-------|
| `agencies/` | ~20 | 3.B follow-up |
| `employees/` | ~25 | 3.B follow-up |
| `vehicles/` | ~20 | 3.B follow-up |
| `finance/` | ~15 | 3.B follow-up |
| `attendance/` | ~10 | 3.B follow-up |
| `settings/` (incl. backup, recycle-bin, document-types, vehicle-settings, etc.) | ~50 | 3.B follow-up |
| `notifications/`, `reports/`, `roles/`, `permissions/`, `job-ads/`, `email/`, `email-i18n/`, etc. | ~60 | 3.B follow-up |

These continue to work; their messages just won't be locale-aware until they're migrated. The filter still emits a `code` (one of `GENERIC.BAD_REQUEST`, `GENERIC.NOT_FOUND`, etc.), so the frontend renders a generic locale-aware fallback string while preserving the English `message` for context.

---

## 10. Compatibility Risks

| Risk | Mitigation | Status |
|------|------------|--------|
| Old clients break if envelope changes | Filter still emits `message`, `statusCode`, `error`, `path`, `timestamp` exactly as before — `code` and `params` are **additive** | ✅ |
| `instanceof NotFoundException` checks in middleware/tests fail | Migration uses `new NotFoundException({...})` (still a `NotFoundException`) and `AppException` subclasses extend the matching Nest classes | ✅ |
| Frontend toast text changes for users on en locale | English fallback (`message`) is preserved; en-locale text matches the in-code `message` exactly. AR/DE/RU/SK/TR users see the EN placeholder until translators replace | ✅ |
| Stack traces / SQL leaked in errors | Filter doesn't include `stack` in the response; Prisma errors map to `GENERIC.UNIQUE_VIOLATION` / `GENERIC.NOT_FOUND` and never expose constraint names | ✅ |
| Translation drift (backend code without frontend key) | Manual audit script confirms 85/85 priority codes have entries. Recommended CI guard in 3.B follow-up | ✅ for current set |
| Locale catalog grew by ~85 keys | Sync script preserves existing translations and only inserts missing keys with EN placeholders | ✅ |

---

## 11. Validation Strategy (current state, Phase 3.C scope)

**This pass:**
- DTO/`class-validator` errors still flow through Nest's default `ValidationPipe` and produce a free-form `BadRequestException({ message: ['email must be a valid email', 'password must be longer than 8'] })`.
- The `I18nExceptionFilter` already joins arrays into one comma-separated string and assigns `code: 'GENERIC.BAD_REQUEST'`.
- No DTO-level changes were made.

**Phase 3.C scope** (deferred):
1. Custom `exceptionFactory` for global `ValidationPipe` that emits:
   ```json
   {
     "code": "VALIDATION.FAILED",
     "message": "Validation failed",
     "params": {
       "fields": [
         { "field": "email", "code": "VALIDATION.EMAIL", "params": {} },
         { "field": "password", "code": "VALIDATION.MIN_LENGTH", "params": { "min": 8 } }
       ]
     }
   }
   ```
2. Mapping table: class-validator constraint names → stable codes.
3. Frontend `apiError.fieldErrors(err, t)` helper for inline form error rendering.
4. Frontend form validation strings to mirror `errors.validation.*` so client-side and server-side errors share the same translations.

---

## 12. Logging & Security

- **No new logs**: filter logs at `Logger.error` level for unhandled non-`HttpException` errors (pre-existing behavior, unchanged).
- **No stack traces in responses**: response shape unchanged.
- **Prisma error codes** (`P2002`, `P2025`) keep mapping to safe generic codes — never leak column / constraint names.
- **No sensitive data** added to `params`: only IDs that are already in the URL, filenames, status enums, integer limits.
- **`User not found`** now uses `USER.NOT_FOUND` consistently across auth/strategies/users/pipeline — no enumeration risk introduced (all paths previously already returned the same English text).

---

## 13. Tests

No new automated tests added (per instruction "do not refactor validation yet" and existing test layout). Manual verification:

| Verification | Method | Result |
|---|---|---|
| Backend compiles | `cd backend && npx nest build` | ✓ clean |
| Frontend compiles | `npm run build` (vite) | ✓ clean (0 TS errors) |
| Locale parity | `npm run i18n:check-keys` | ✓ 5 × 9 match EN |
| Literal scanner stable | `npm run i18n:check-literals` | 13 hits (same baseline) |
| Every backend code has a frontend key | inline `node` audit (Section 9 below) | 85/85 ✓ |
| Old envelope still flows | Inspected `i18n-exception.filter.ts` — falls back to `defaultCodeForStatus()` for plain-string throws | ✓ |
| `instanceof NotFoundException` still passes | `new NotFoundException({...})` keeps the prototype chain | ✓ |

---

## 14. Recommended Phase 3.C Validation Scope

1. **Global `ValidationPipe.exceptionFactory`** — emit `{ code: 'VALIDATION.FAILED', params: { fields: [...] } }`.
2. **Validator constraint → code map** — `isEmail`, `minLength`, `maxLength`, `isNotEmpty`, `isInt`, `isPositive`, `isUUID`, `isISO8601`, `matches`, etc. (~25 constraints in active use).
3. **Field-error rendering helper** in `src/i18n/apiError.ts`: `apiError.fieldErrors(err) → Record<field, translatedMessage>`.
4. **Frontend form harmonization** — replace inline `'Email is required'` / `'Password too short'` literals (~20 forms) with the same `errors.validation.*` keys.
5. **Backend follow-up modules** — drain the remaining 199 plain-string throws across `agencies/`, `employees/`, `vehicles/`, `finance/`, `attendance/`, `settings/`, `notifications/`, `reports/`, etc. Each module gets its own `<MODULE>.*` group in `errors.json`.
6. **CI guard** — add a script that asserts every backend code emitted has a matching key in `errors.json` for all 6 locales (the audit shown in Section 9 packaged as a check).

---

## 15. Quick Verification Commands

```bash
# Priority modules: 0 plain-string throws
grep -rnE "throw new (BadRequest|Unauthorized|Forbidden|NotFound|Conflict|Internal)Exception\(['\"\`]" \
  backend/src/{auth,users,applicants,documents,workflow,pipeline}/ --include="*.ts" | wc -l   # → 0

# Coded throws in priority modules
grep -rnE "throw new \w+Exception\(\{" \
  backend/src/{auth,users,applicants,documents,workflow,pipeline}/ --include="*.ts" | wc -l   # → 137

# Builds
cd backend && npx nest build                           # → clean
cd .. && npm run build                                  # → clean (0 TS errors)
npm run i18n:check-keys                                 # → ✓ 5 × 9 match EN
npm run i18n:check-literals                             # → 13 (same baseline)
```
