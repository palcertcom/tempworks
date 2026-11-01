# Multi-Language Audit · Part 03 — Backend & Database

> **Scope:** every user-visible string emitted by the NestJS backend
> (`backend/src/**`) and every Prisma-modelled label that surfaces in the
> UI (`backend/prisma/schema.prisma`, `backend/prisma/seed.ts`).
>
> **Companions:** Part 01 (frontend routes) and Part 02 (frontend
> components). Read those first.
>
> **Read-only:** no source modified, no commit made.

---

## 1. Existing backend i18n footprint

Phase 4 already landed the plumbing. What's in place today:

| Concern                                | Detected                                                                                            |
| -------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Locale resolver                        | `backend/src/common/i18n/i18n.service.ts` — `resolve(req)` reads `?lang=` → `req.user.preferredLanguage` → `Accept-Language` → `en` |
| Coded-error envelope filter            | `backend/src/common/i18n/i18n-exception.filter.ts` — emits `{ statusCode, code, message, params? }` and maps Prisma `P2002`/`P2025` |
| Filter wired globally                  | `backend/src/main.ts` registers `new I18nExceptionFilter()` via `app.useGlobalFilters(…)`            |
| Module                                 | `backend/src/common/i18n/i18n.module.ts` (`@Global`)                                                 |
| Email subjects + body strings          | `backend/src/email/email-i18n.ts` — 9 templates × 6 locales (`activation`, `passwordReset` (+ admin variant), `twoFactor`, `passwordChanged`, `passwordExpired`, `accountLocked`, `welcome`, `applicationConfirmation`, `notification`) |
| Email service signatures               | `backend/src/email/email.service.ts` — every `sendXxx` accepts an optional `locale: EmailLocale`     |
| Per-locale `<html lang dir>`           | `baseTemplate(title, body, locale)` sets `dir="rtl"` for `ar` and `lang` to active locale            |
| DB translations columns                | `DocumentType.translations Json?`, `JobType.translations Json?`, `WorkflowStage.translations Json?` (+ idempotent SQL in `runStartupMigrations`) |
| Translation merge in reads             | `settings.controller.ts` — `GET /settings/job-types` and `GET /settings/document-types` merge `translations[locale]` via `I18nService.localized(row, locale, field)` |
| Frontend error helper                  | `src/i18n/apiError.ts` reads `code`/`params` from the envelope and resolves to `errors.json` keys     |

What's still **not** wired:

- The exception filter accepts both shapes (legacy `string` and coded `{code,message}`) but the **vast majority of services still throw legacy `throw new XxxException('English text')`** — only the auth flow has been converted.
- `class-validator` DTOs use **default messages** (no `message:` overrides at all). When validation fails, the response is the default English string.
- All other email senders (work-permit reminders, application confirmation, etc.) ignore locale because callers don't pass `user.preferredLanguage` through.
- In-app **notifications** persist `title` + `message` as English strings in the DB; no `titleKey`/`bodyKey`/`params` columns yet.
- Excel/PDF/CSV **export headers** are hardcoded English.
- Several DB-backed labels (`Workshop.name`, `MaintenanceType.name`, `FinanceTransactionType.name`, `WorkHistoryEventTypeSetting.label`, `NotificationRule.name`, `Role.description`, `Permission.name`, `JobAd.title`/`description`) have **no `translations` column yet**.

---

## 2. Methodology

For every concern below we recorded:

| Signal        | How |
| ------------- | --- |
| File path     | Source file emitting the string |
| Current text  | Verbatim English copy (truncated where long) |
| Coded?        | Already in `{ code, message, params }` form? (Phase 4 covered auth; nothing else.) |
| Recommended key | Proposed stable code under `errors.<group>.<KEY>` (frontend lookup) or namespace key for emails / notifications / exports |
| Strategy      | `frontend-translates` (codes only on the wire), `backend-resolves` (server emits per-locale text using recipient locale), or `db-translations` (JSONB column merged at read time) |
| Priority      | **High** = appears on the daily user path · **Medium** = list/detail flows · **Low** = admin/dev path |

The full string list runs to **150+ exceptions** plus templates. The
tables below give the per-file totals + representative samples and
recommend the keyspace for the bulk migration.

---

## 3. Backend exceptions — Table A

### 3.1 Coverage snapshot

| Metric                                                          | Count |
| --------------------------------------------------------------- | ----: |
| Files containing at least one `throw new XxxException(…)`       |    25 |
| Total `throw new …Exception('text')` legacy sites               |   158 |
| Sites already converted to `{ code, message, params }` (Phase 4) |    15 |
| Effective coverage                                               | ~9% |

### 3.2 Exception count per file (descending)

| File                                                 | Legacy throws | Strategy | Priority |
| ---------------------------------------------------- | ------------: | -------- | :------: |
| `backend/src/pipeline/pipeline.service.ts`           |            25 | frontend-translates | **High** |
| `backend/src/vehicles/vehicles.service.ts`           |            19 | frontend-translates | **High** |
| `backend/src/settings/settings.service.ts`           |            16 | frontend-translates | Medium |
| `backend/src/attendance/attendance.service.ts`       |            15 | frontend-translates | **High** |
| `backend/src/users/users.service.ts`                 |            14 | frontend-translates | **High** |
| `backend/src/applicants/applicants.service.ts`       |            10 | frontend-translates | **High** |
| `backend/src/workflow/workflow.service.ts`           |             7 | frontend-translates | Medium |
| `backend/src/finance/finance.service.ts`             |             7 | frontend-translates | **High** |
| `backend/src/employees/employees.service.ts`         |             7 | frontend-translates | **High** |
| `backend/src/employee-work-history/employee-work-history.service.ts` | 5 | frontend-translates | Medium |
| `backend/src/auth/auth.service.ts`                   |             5 | frontend-translates (most converted) | **High** |
| `backend/src/application-drafts/application-drafts.service.ts` |   4 | frontend-translates | Medium |
| `backend/src/agencies/agencies.service.ts`           |             4 | frontend-translates | **High** |
| `backend/src/roles/roles.service.ts`                 |             3 | frontend-translates | Medium |
| `backend/src/documents/documents.service.ts`         |             3 | frontend-translates | **High** |
| `backend/src/documents/documents.controller.ts`      |             3 | frontend-translates | **High** |
| `backend/src/users/users.controller.ts`              |             2 | frontend-translates | **High** |
| `backend/src/application-drafts/application-drafts.controller.ts` | 2 | frontend-translates | Medium |
| `backend/src/{vehicles,settings,finance,employees,backup,applicants,agencies}/…controller.ts` | 7 (one each) | frontend-translates | Medium |

### 3.3 Recommended error-code keyspace

A compact, stable group → key mapping with a 1-liner per group; the
frontend's `errors.json` already follows this shape (`AUTH.*`,
`GENERIC.*`).

| Group       | Frontend key prefix     | Sample codes (recommended)                                                     |
| ----------- | ----------------------- | ------------------------------------------------------------------------------ |
| `AUTH`      | `errors.auth.*`         | `INVALID_CREDENTIALS`, `ACCOUNT_LOCKED`, `ACCOUNT_INACTIVE`, `ACCOUNT_PENDING`, `ACCOUNT_SUSPENDED`, `ACCOUNT_TERMINATED`, `TWO_FACTOR_INVALID`, `TWO_FACTOR_EXPIRED`, `TWO_FACTOR_TOO_MANY_ATTEMPTS`, `ACCESS_DENIED`, `CURRENT_PASSWORD_INCORRECT`, `ACTIVATION_INVALID`, `RESET_INVALID`, `PASSWORD_TOO_SHORT`, `PASSWORD_NEEDS_UPPER`, `PASSWORD_NEEDS_LOWER`, `PASSWORD_NEEDS_DIGIT` (already mostly in place) |
| `USERS`     | `errors.users.*`        | `NOT_FOUND`, `EMAIL_TAKEN`, `OVERRIDE_NOT_FOUND`, `ACTIVATION_LINK_INELIGIBLE`, `CANNOT_DELETE_LAST_ADMIN` |
| `EMPLOYEES` | `errors.employees.*`    | `NOT_FOUND`, `ALREADY_EXISTS`, `AGENCY_GRANT_NOT_FOUND`, `PHOTO_REQUIRED`      |
| `APPLICANTS`| `errors.applicants.*`   | `NOT_FOUND`, `RECAPTCHA_REQUIRED`, `RECAPTCHA_FAILED`, `WORKFLOW_NOT_AVAILABLE`, `CANDIDATE_NOT_FOUND`, `DELETE_REQUEST_PENDING`, `DELETE_REQUEST_NOT_FOUND`, `DELETE_REQUEST_ALREADY_REVIEWED` |
| `AGENCIES`  | `errors.agencies.*`     | `NOT_FOUND`, `CONTACT_NAME_REQUIRED`, `LOGO_FILE_REQUIRED`, `OVERRIDE_NOT_FOUND`, `USER_NOT_IN_AGENCY` |
| `DOCUMENTS` | `errors.documents.*`    | `FILE_REQUIRED`, `ENTITY_ID_REQUIRED`, `TYPE_NOT_FOUND`, `NO_TYPES_CONFIGURED`, `NO_USERS_TO_ATTRIBUTE` |
| `WORKFLOW`  | `errors.workflow.*`     | `WORKFLOW_NOT_FOUND`, `STAGE_NOT_FOUND`, `EMPLOYEE_STAGE_NOT_FOUND`, `WORK_PERMIT_NOT_FOUND`, `VISA_NOT_FOUND`, `STAGE_DOES_NOT_BELONG`, `STAGE_NOT_IN_WORKFLOW` |
| `PIPELINE`  | `errors.pipeline.*`     | `WORKFLOW_NOT_FOUND`, `USER_NOT_FOUND`, `USER_NO_ACCESS`, `STAGE_NOT_FOUND`, `CANDIDATE_NOT_FOUND`, `CANDIDATE_IDS_REQUIRED`, `BULK_LIMIT_EXCEEDED`, `ASSIGNMENT_NOT_FOUND`, `EMPLOYEE_NOT_FOUND`, `NO_WORKFLOW_ASSIGNMENT`, `STAGE_DOES_NOT_BELONG_TO_EMPLOYEE`, `STAGE_NOT_BELONG_WORKFLOW`, `PROGRESS_NOT_FOUND`, `NOTE_NOT_FOUND`, `STAGE_NOT_REQUIRES_APPROVAL` |
| `ATTENDANCE`| `errors.attendance.*`   | `INVALID_DATE_FORMAT`, `CHECKOUT_BEFORE_CHECKIN`, `BREAK_OUT_BEFORE_BREAK_IN`, `RECORDS_REQUIRED`, `INVALID_MONTH`, `INVALID_YEAR`, `NO_EMPLOYEES_MATCHING`, `PERIOD_ALREADY_LOCKED`, `LOCKED_PERIOD_NOT_FOUND`, `INVALID_DATE_RANGE`, `EITHER_DATES_OR_RANGE`, `NO_DATES_TO_PROCESS`, `TOO_MANY_DATES` |
| `FINANCE`   | `errors.finance.*`      | `INVALID_ENTITY_TYPE`, `RECORD_DELETED`, `INVALID_DEDUCTION_AMOUNT`, `INVALID_DEDUCTION_DATE`, `DEDUCTION_NOT_FOUND`, `ATTACHMENT_NOT_FOUND`, `FILE_REQUIRED` |
| `VEHICLES`  | `errors.vehicles.*`     | `NOT_FOUND`, `ACTIVE_DRIVER_NOT_FOUND`, `DOCUMENT_NOT_FOUND`, `MAINTENANCE_TYPE_NOT_FOUND`, `WORKSHOP_NOT_FOUND`, `MAINTENANCE_RECORD_NOT_FOUND`, `MAINTENANCE_ATTACHMENTS_MIGRATION_REQUIRED`, `FILE_REQUIRED` |
| `SETTINGS`  | `errors.settings.*`     | `JOB_TYPE_NOT_FOUND`, `JOB_TYPE_NAME_REQUIRED`, `TRANSACTION_TYPE_NOT_FOUND`, `TRANSACTION_TYPE_VALUE_REQUIRED`, `TRANSACTION_TYPE_LABEL_REQUIRED`, `EVENT_TYPE_NOT_FOUND`, `DOCUMENT_TYPE_NOT_FOUND`, `WORKFLOW_STAGE_NOT_FOUND`, `NOTIFICATION_RULE_NOT_FOUND`, `LOGO_FILE_REQUIRED` |
| `ROLES`     | `errors.roles.*`        | `NOT_FOUND`, `CANNOT_RENAME_SYSTEM_ROLE`, `CANNOT_DELETE_SYSTEM_ROLE`           |
| `WORK_HISTORY` | `errors.workHistory.*` | `ENTRY_NOT_FOUND`, `FILE_REQUIRED`, `ATTACHMENT_NOT_FOUND`                     |
| `BACKUP`    | `errors.backup.*`       | `CANNOT_DELETE_IN_PROGRESS`                                                    |
| `APPLICATION_DRAFTS` | `errors.drafts.*` | `NO_OPEN_DRAFT`, `DOCUMENT_NOT_FOUND`, `PHOTO_REQUIRED`, `FILE_REQUIRED`     |
| `GENERIC`   | `errors.generic.*`      | `UNEXPECTED`, `BAD_REQUEST`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `UNIQUE_VIOLATION`, `RATE_LIMITED` (already in `errors.json`) |

### 3.4 Representative samples (verbatim text → recommended code)

| File / line                                                              | Current English text                                                                                              | Recommended code                                  | Priority |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | :------: |
| `agencies/agencies.service.ts:96`                                        | "Contact person name is required"                                                                                 | `AGENCIES.CONTACT_NAME_REQUIRED`                  | High     |
| `agencies/agencies.service.ts:336`                                       | "Permission override not found"                                                                                   | `AGENCIES.OVERRIDE_NOT_FOUND`                     | Medium   |
| `attendance/attendance.service.ts:266`                                   | "date must be in YYYY-MM-DD format"                                                                               | `ATTENDANCE.INVALID_DATE_FORMAT`                  | High     |
| `attendance/attendance.service.ts:285`                                   | "Check-out is earlier than Check-in"                                                                              | `ATTENDANCE.CHECKOUT_BEFORE_CHECKIN`              | High     |
| `attendance/attendance.service.ts:1147`                                  | "Period is already locked"                                                                                        | `ATTENDANCE.PERIOD_ALREADY_LOCKED`                | High     |
| `users/users.service.ts:192…624 (×11)`                                   | "User not found"                                                                                                  | `USERS.NOT_FOUND`                                 | High     |
| `users/users.service.ts:841`                                             | "Activation link is only available for PENDING or INACTIVE accounts"                                              | `USERS.ACTIVATION_LINK_INELIGIBLE`                | Medium   |
| `auth/auth.service.ts:874`                                               | "Password must contain at least one uppercase letter"                                                             | `AUTH.PASSWORD_NEEDS_UPPER`                       | High     |
| `auth/auth.service.ts:877`                                               | "Password must contain at least one lowercase letter"                                                             | `AUTH.PASSWORD_NEEDS_LOWER`                       | High     |
| `auth/auth.service.ts:880`                                               | "Password must contain at least one digit"                                                                        | `AUTH.PASSWORD_NEEDS_DIGIT`                       | High     |
| `employees/employees.service.ts:106…276 (×4)`                            | "Employee not found"                                                                                              | `EMPLOYEES.NOT_FOUND`                             | High     |
| `employees/employees.service.ts:175,200`                                 | "No grant for that employee/agency pair"                                                                          | `EMPLOYEES.AGENCY_GRANT_NOT_FOUND`                | Medium   |
| `applicants/applicants.service.ts:288`                                   | "reCAPTCHA verification required"                                                                                 | `APPLICANTS.RECAPTCHA_REQUIRED`                   | High     |
| `applicants/applicants.service.ts:297`                                   | "reCAPTCHA verification failed. Please try again."                                                                | `APPLICANTS.RECAPTCHA_FAILED`                     | High     |
| `applicants/applicants.service.ts:362`                                   | "This candidate is pending Tempworks approval and cannot enter the workflow yet"                                   | `APPLICANTS.WORKFLOW_NOT_AVAILABLE`               | Medium   |
| `applicants/applicants.service.ts:1006`                                  | "A delete request for this candidate is already pending review."                                                  | `APPLICANTS.DELETE_REQUEST_PENDING`               | Medium   |
| `pipeline/pipeline.service.ts:50,95`                                     | "Workflow not found"                                                                                              | `PIPELINE.WORKFLOW_NOT_FOUND`                     | High     |
| `pipeline/pipeline.service.ts:279`                                       | "User does not have access to this workflow"                                                                      | `PIPELINE.USER_NO_ACCESS`                         | Medium   |
| `pipeline/pipeline.service.ts:568`                                       | "candidateIds is required and must be non-empty"                                                                  | `PIPELINE.CANDIDATE_IDS_REQUIRED`                 | Medium   |
| `pipeline/pipeline.service.ts:571`                                       | "Refusing to process more than 500 candidates in a single bulk assign"                                            | `PIPELINE.BULK_LIMIT_EXCEEDED` (params: `max=500`) | Medium   |
| `vehicles/vehicles.service.ts:134…654 (×11)`                             | "Vehicle not found", "Document not found", "Maintenance record not found", etc.                                  | `VEHICLES.{NOT_FOUND, …}`                          | High     |
| `vehicles/vehicles.service.ts:676`                                       | "Maintenance record attachments require migration. Run: npm run db:migrate:enhance-maintenance-records"           | **Keep English** (developer error, not user-facing) | Low |
| `documents/documents.controller.ts:119,154`                              | "File is required"                                                                                                | `DOCUMENTS.FILE_REQUIRED`                         | High     |
| `documents/documents.controller.ts:120`                                  | "entityId is required"                                                                                            | `DOCUMENTS.ENTITY_ID_REQUIRED`                    | High     |
| `documents/documents.service.ts:270`                                     | "No document types configured"                                                                                    | `DOCUMENTS.NO_TYPES_CONFIGURED`                   | Medium   |
| `finance/finance.service.ts:292`                                         | "entityType must be APPLICANT, EMPLOYEE or AGENCY"                                                                | `FINANCE.INVALID_ENTITY_TYPE`                     | High     |
| `finance/finance.service.ts:483`                                         | "Deduction amount must be a positive number"                                                                      | `FINANCE.INVALID_DEDUCTION_AMOUNT`                | High     |
| `settings/settings.service.ts:201,215`                                   | "Job type not found"                                                                                              | `SETTINGS.JOB_TYPE_NOT_FOUND`                     | Medium   |
| `settings/settings.service.ts:393…425 (×3)`                              | "Document type not found"                                                                                         | `SETTINGS.DOCUMENT_TYPE_NOT_FOUND`                | Medium   |
| `roles/roles.service.ts:38`                                              | "Role not found"                                                                                                  | `ROLES.NOT_FOUND`                                 | Medium   |
| `roles/roles.service.ts:70`                                              | "Cannot rename system roles"                                                                                      | `ROLES.CANNOT_RENAME_SYSTEM_ROLE`                 | Medium   |
| `roles/roles.service.ts:100`                                             | "Cannot delete system roles"                                                                                      | `ROLES.CANNOT_DELETE_SYSTEM_ROLE`                 | Medium   |
| `workflow/workflow.service.ts:78,114,117,170,247,268,309`                | "Employee not found", "Workflow stage not found", "Work permit not found", "Visa not found"                       | `WORKFLOW.*`                                       | Medium   |
| `employee-work-history/…service.ts:100,118,141`                          | "Work history entry not found"                                                                                    | `WORK_HISTORY.ENTRY_NOT_FOUND`                    | Medium   |
| `application-drafts/…service.ts:113,170,256`                             | "No open draft"                                                                                                   | `DRAFTS.NO_OPEN_DRAFT`                            | Medium   |
| `backup/backup.service.ts:756`                                           | "Cannot delete a backup that is currently in progress."                                                           | `BACKUP.CANNOT_DELETE_IN_PROGRESS`                | Low      |

### 3.5 Strategy

**Frontend translates** is the right strategy for every entry above. The
backend already has the exception filter — the only job is to
**convert each `throw new XxxException('text')` to
`throw new XxxException({ code, message: 'text', params? })`**
and add the matching key to `errors.json` (and its 5 locale siblings).

The English `message:` field stays in the envelope so:

- non-i18n consumers (Swagger, scripts, legacy clients) keep working unchanged
- the frontend has a fallback if the locale lacks the code

**Estimated effort:** ~1 engineer-day of mostly-mechanical sweeps (143
sites). Highest-value modules first: `auth` (mostly done), `users`,
`employees`, `applicants`, `documents`, `vehicles`, `finance`,
`attendance`, `pipeline`. The remainder can land in later passes.

---

## 4. Validation messages — Table B

### 4.1 Coverage snapshot

The codebase **does not use `class-validator` `message:` overrides
anywhere**. The `grep` for DTO message overrides returned **0 hits**.
Every DTO under `backend/src/**/dto/*.ts` (51 files) relies on the
default English messages emitted by `class-validator` (e.g. `"name must
be a string"`, `"email must be an email"`).

### 4.2 What that means

When validation fails, the response is a 400 with `message: string[]`
(default Nest behaviour). The current `I18nExceptionFilter` doesn't
extract field names or codes from those defaults — it only joins them
into one comma-separated string.

### 4.3 Recommended approach

Two complementary moves:

1. **Reshape validation responses.** Replace the default
   `ValidationPipe` configuration in `main.ts` so failures emit:
   ```json
   {
     "code": "VALIDATION_FAILED",
     "message": "Validation failed",
     "errors": [
       { "field": "email", "code": "validation.email.invalid", "params": {} },
       { "field": "password", "code": "validation.minLength", "params": { "min": 8 } }
     ]
   }
   ```
   The frontend can then render each field error from `errors.validation.*`.
2. **Add a key namespace** `errors.validation.*` to the existing
   `errors.json` files (already has `required`, `email`, `minLength`,
   `maxLength`, `passwordsDoNotMatch` — extend with the rest of the
   class-validator default set).

### 4.4 Recommended `errors.validation.*` keys

These cover the 16 most-used class-validator decorators in this
codebase:

| Decorator                       | Key                                  | English                                                |
| ------------------------------- | ------------------------------------ | ------------------------------------------------------ |
| `@IsString`                     | `validation.string`                  | `Must be text.`                                         |
| `@IsNotEmpty`                   | `validation.required` *(exists)*     | `This field is required.`                              |
| `@IsEmail`                      | `validation.email` *(exists)*        | `Please enter a valid email address.`                   |
| `@IsUrl`                        | `validation.url`                     | `Please enter a valid URL.`                            |
| `@IsBoolean`                    | `validation.boolean`                 | `Must be true or false.`                                |
| `@IsInt` / `@IsNumber`          | `validation.number`                  | `Must be a number.`                                     |
| `@Min` / `@IsPositive`          | `validation.min`                     | `Must be at least {{min}}.`                             |
| `@Max`                          | `validation.max`                     | `Must be at most {{max}}.`                              |
| `@Length`                       | `validation.length`                  | `Must be between {{min}} and {{max}} characters.`       |
| `@MinLength`                    | `validation.minLength` *(exists)*    | `Must be at least {{min}} characters.`                   |
| `@MaxLength`                    | `validation.maxLength` *(exists)*    | `Must be at most {{max}} characters.`                    |
| `@IsEnum`                       | `validation.enum`                    | `Must be one of: {{values}}.`                            |
| `@IsUUID`                       | `validation.uuid`                    | `Must be a valid identifier.`                            |
| `@IsDateString`                 | `validation.date`                    | `Must be a valid date.`                                  |
| `@Matches` (regex)              | `validation.pattern`                 | `Doesn't match the expected pattern.`                    |
| `@IsPhoneNumber`                | `validation.phone`                   | `Must be a valid phone number.`                          |
| `@IsArray` / `@ArrayNotEmpty`   | `validation.array`                   | `Must be a non-empty list.`                              |
| `@ValidateNested`               | n/a (returns nested errors)          | —                                                        |

### 4.5 Mapping default → key (auto)

Rather than add `message: 'validation.xxx'` to every decorator (which
would mean editing 51 DTO files), we recommend a small `mapDefault`
helper in the new `ValidationPipe` `exceptionFactory`:

```ts
// pseudo-code
new ValidationPipe({
  exceptionFactory: (errors) => ({
    code: 'VALIDATION_FAILED',
    message: 'Validation failed',
    errors: errors.flatMap((e) => Object.entries(e.constraints ?? {}).map(([rule, msg]) => ({
      field: e.property,
      code: ruleToKey(rule),                  // 'isEmail' → 'validation.email'
      params: extractParams(rule, e),         // { min: 8 }
    }))),
  }),
});
```

This lets the 51 DTOs stay untouched and still emit coded errors. New
DTOs that want a custom message can opt in with
`@IsX({ message: 'validation.specialCase' })`.

### 4.6 Priority

**Medium.** Validation failures are user-visible but happen on form
submission, where the frontend can fall back gracefully today
(`apiError(err)` returns the joined English message). Lower urgency
than the auth / data-action exceptions in §3.

---

## 5. Email / Notification / Export strings — Table C

### 5.1 Email templates

| Template id                | Subject + body locales | Status                         | Notes |
| -------------------------- | :--------------------: | ------------------------------ | ----- |
| `activation`               | en, sk, de, ru, ar, tr | 🟢 Phase 4                     | Subject & body strings under `email-i18n.ts > activation`. |
| `passwordReset`            | en, sk, de, ru, ar, tr | 🟢 Phase 4                     | |
| `passwordResetAdmin`       | en, sk, de, ru, ar, tr | 🟢 Phase 4                     | Variant when admin initiates the reset. |
| `twoFactor`                | en, sk, de, ru, ar, tr | 🟢 Phase 4                     | Includes `{{minutes}}` plural-safe by interpolation. |
| `passwordChanged`          | en, sk, de, ru, ar, tr | 🟢 Phase 4                     | |
| `passwordExpired`          | en, sk, de, ru, ar, tr | 🟢 Phase 4                     | |
| `accountLocked`            | en, sk, de, ru, ar, tr | 🟢 Phase 4                     | |
| `welcome`                  | en, sk, de, ru, ar, tr | 🟢 Phase 4                     | |
| `applicationConfirmation`  | en, sk, de, ru, ar, tr | 🟢 (subject + intro localized) | Body still mixes en strings for "Personal Information", "Driving License", "Education" section headings. |
| `notification`             | en, sk, de, ru, ar, tr | 🟡 partial                     | Greeting + signoff localized; `title` and `message` come from caller (still English). |

#### Caller side (bottlenecks)

| Caller                                                     | Passes locale? | Source of locale | Status |
| ---------------------------------------------------------- | :------------: | ---------------- | ------ |
| `auth.service.ts > sendAccountLockedEmail`                 | y              | `user.preferredLanguage` | 🟢 |
| `auth.service.ts > sendTwoFactorCode` (login)              | y              | `user.preferredLanguage` | 🟢 |
| `auth.service.ts > sendTwoFactorCode` (resend)             | y              | `record.user.preferredLanguage` | 🟢 |
| `auth.service.ts > sendActivationEmail`                    | n              | n/a              | 🟡 |
| `auth.service.ts > sendPasswordResetEmail`                 | n              | n/a              | 🟡 |
| `auth.service.ts > sendPasswordChangedConfirmation`        | n              | n/a              | 🟡 |
| `auth.service.ts > sendPasswordExpiredNotification`        | n              | n/a              | 🟡 |
| `auth.service.ts > sendWelcomeEmail`                       | n              | n/a              | 🟡 |
| `applicants.service.ts > sendApplicationConfirmation`      | n              | n/a              | 🟡 |
| `notifications.service.ts > sendNotificationEmail`         | n              | n/a              | 🟡 |

**Strategy:** thread `user.preferredLanguage` through every caller. Where the recipient is an applicant (no User row yet), use `Accept-Language` from the originating request. Where the recipient is a list of users (e.g. role-broadcast notifications), loop and personalize per recipient.

### 5.2 In-app notifications (`Notification` table)

`backend/src/notifications/notifications.service.ts` writes
`Notification.title` and `Notification.message` straight as English
strings. Examples from the codebase:

| File / line                                           | Title literal                                                   | Message literal                                                              |
| ----------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `notifications.service.ts:135`                        | `${vehicle.registrationNumber}: ${check.label} Expiring Soon`   | `${check.label} expires in ${daysUntil} days`                                 |
| `notifications.service.ts:216`                        | `${vehicle.registrationNumber}: Service Due Soon`               | `Service due in ${kmRemaining} km`                                            |
| `notifications.service.ts:280`                        | `🚨 ${vehicle.registrationNumber}: Compliance Overdue`          | `Vehicle has expired compliance. Service immediately.`                        |
| `notifications.service.ts:349`                        | `${record.vehicle.registrationNumber}: Scheduled Maintenance`   | `${maintenanceType?.name ?? 'Maintenance'} scheduled in ${daysUntil} days at ${workshop?.name ?? 'workshop'}` |
| `finance.service.ts:330–340`                          | `New Financial Record Added`                                    | `A new financial record was added for ${entityName}: ${dto.transactionType}…` |
| `documents.service.ts:375…390`                        | (varies by event)                                               | (varies)                                                                      |

#### Recommended persistence change (Phase 4 follow-on)

Add three columns to the `Notification` model:

```prisma
model Notification {
  // existing fields
  titleKey   String?      // e.g. 'notifications.vehicle.expiring.title'
  bodyKey    String?      // e.g. 'notifications.vehicle.expiring.body'
  params     Json?        // { registration: 'AB12CDE', label: 'MOT', daysUntil: 30 }
  // legacy free-text title/message remain for backwards compatibility
}
```

The frontend renders preferentially:
```ts
// pseudo-code
notification.titleKey
  ? t(notification.titleKey, notification.params)
  : notification.title;     // legacy fallback
```

#### Recommended frontend keyspace

A new `notifications.json` namespace, sectioned by event family:

```jsonc
{
  "vehicle": {
    "expiringSoon":   { "title": "{{registration}}: {{label}} expiring soon",
                        "body":  "{{label}} expires in {{daysUntil}} days" },
    "serviceDueSoon": { "title": "{{registration}}: Service due soon",
                        "body":  "Service due in {{kmRemaining}} km" },
    "complianceOverdue": { "title": "🚨 {{registration}}: Compliance overdue",
                           "body":  "Vehicle has expired compliance. Service immediately." },
    "maintenanceScheduled": { "title": "{{registration}}: Scheduled maintenance",
                              "body":  "{{type}} scheduled in {{daysUntil}} days at {{workshop}}" }
  },
  "finance": {
    "recordCreated":  { "title": "New financial record added",
                        "body":  "A new financial record was added for {{entity}}: {{type}} — {{currency}} {{amount}}" },
    "recordUpdated":  { … },
    "recordDeleted":  { … },
    "highBalance":    { … }
  },
  "documents": {
    "uploaded":       { "title": "Document uploaded",
                        "body":  "{{user}} uploaded {{name}} for {{entity}}" },
    "expiringSoon":   { … },
    "expired":        { … }
  }
}
```

**Strategy:** **backend-resolves** the persisted `titleKey/bodyKey/params` at write time (so the row is locale-agnostic), the frontend resolves them at read time using the viewer's locale.

**Priority:** Medium — high-volume but already partially observable as plain English in the bell drop-down.

### 5.3 Email subjects sent via notifications

`sendNotificationEmail(to, name, title, message, eventType?, locale?)`
forwards the caller's `title` as the subject. Today every caller passes
English. After §5.2 lands, callers should pass `t(eventKey + '.title', params, recipientLocale)` instead.

### 5.4 Excel / PDF / CSV exports

Five backend services generate exports. Headers and section labels are
all hardcoded English.

| Service                                              | Format            | Hardcoded labels (samples)                                                                                  | Strategy            | Priority |
| ---------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------- | ------------------- | :------: |
| `attendance/attendance.service.ts`                   | Excel (`exceljs`) | `Attendance Summary`, `Timesheet Detail`, `Date`, `Check-in`, `Check-out`, `Hours`, `Notes`                | backend-resolves    | High     |
| `employees/employees.service.ts`                     | Excel             | `Employees`, `Employee Number`, `First Name`, `Last Name`, `Email`, `Citizenship`, `License Number`, …      | backend-resolves    | High     |
| `applicants/applicants.service.ts`                   | Excel             | `Applicants`, `Status`, `Years Experience`, `Citizenship`, …                                                | backend-resolves    | High     |
| `finance/finance.service.ts`                         | Excel (2 sheets)  | `Financial Records`, `Deductions`, `Date`, `Amount`, `Currency`, `Status`, `Description`, `Payroll Ref`, … | backend-resolves    | High     |
| `reports/reports.service.ts`                         | Excel + PDF       | Field labels live in a per-data-source `LABELS` table inside the file (see `reports.service.ts` lines 52–80) — `First Name`, `Last Name`, `Status`, `Years Exp.`, etc. | backend-resolves | Medium   |
| `vehicles/vehicles.service.ts`                       | PDF (`pdfkit`)    | Page headers, column titles                                                                                  | backend-resolves    | Medium   |

**Recommended approach for exports:**

1. Resolve the **request locale** via `I18nService.resolve(req)` at the
   controller entry point.
2. Pass it down to the service.
3. Replace each hardcoded string with `tExport(locale, '<key>')` (a tiny
   in-memory map living next to the service, similar to
   `email-i18n.ts`). For reports, the `LABELS` table can be keyed by
   locale with English as the default.

**Out of scope for now:** translating the **data** inside exports
(employee names, document statuses) — those should follow the
`enumLabel` and DB-translation strategies the frontend uses.

**Priority:** High for `attendance`, `employees`, `applicants`,
`finance` exports — these are the most-downloaded files. Medium for
`reports` (admin-driven) and `vehicles` PDF.

---

## 6. Database-driven labels — Table D

### 6.1 Coverage today

| Model                                | User-visible field(s)         | `translations Json?` already? | Read-time merge in services? |
| ------------------------------------ | ----------------------------- | :---------------------------: | :--------------------------: |
| `DocumentType`                       | `name`, `description`         |              ✅              |  ✅ (`/settings/document-types`) |
| `JobType`                            | `name`, `description`         |              ✅              |  ✅ (`/settings/job-types`)      |
| `WorkflowStage`                      | `name`, `description`         |              ✅              |  ❌ not yet                     |
| `Role`                               | `name`, `description`         |              ❌              |  n/a                            |
| `Permission`                         | `name`                        |              ❌              |  n/a                            |
| `FinanceTransactionType`             | `name`                        |              ❌              |  n/a                            |
| `WorkHistoryEventTypeSetting`        | `label`                       |              ❌              |  n/a                            |
| `MaintenanceType`                    | `name`, `description`         |              ❌              |  n/a                            |
| `Workshop`                           | `name`                        |              ❌              |  n/a                            |
| `NotificationRule`                   | `name`                        |              ❌              |  n/a                            |
| `JobAd`                              | `title`, `description`        |              ❌              |  n/a                            |
| `SystemSetting`                      | `description`                 |              ❌              |  n/a                            |
| `Workflow`                           | `name`, `description`         |              ❌              |  n/a                            |
| `StageTemplate`                      | `name`, `description`         |              ❌              |  n/a                            |

Phase 4 added the column on three models and read-side merging on two
controllers. The remaining 11 models still serve `name`/`description`
as raw English.

### 6.2 Recommendation per model

| Model                          | Strategy                                  | Why |
| ------------------------------ | ----------------------------------------- | --- |
| `DocumentType`                 | **JSONB translations** (already there) + admin UI to edit | Editable by admins; small set; read-heavy. |
| `JobType`                      | **JSONB translations** (already there) + admin UI | Same. |
| `WorkflowStage`                | **JSONB translations** (already there) + add merge to all read endpoints | Same. |
| `FinanceTransactionType`       | **JSONB translations** + add column      | Same; small set, admin-editable. |
| `WorkHistoryEventTypeSetting`  | **JSONB translations** + add column      | Tiny set, infrequently updated. |
| `MaintenanceType`              | **JSONB translations** + add column      | Same. |
| `Workshop`                     | **JSONB translations** + add column      | Workshop names tend to be proper nouns; admins may still want a localized form. |
| `NotificationRule.name`        | **frontend translation file**             | The 4 seeded rule names ("Passport Expiry Warning", …) are stable; admins rarely add new ones. Map to `enums.notificationRule.<key>` instead. |
| `Role`, `Permission`           | **frontend translation file**             | System role/permission codes are stable strings; translate in `enums.role.*` / `enums.permission.*`. Custom roles created by admins are rare and can fall back to the canonical English `name`. |
| `SystemSetting.description`    | **frontend translation file**             | Setting keys are stable; map description text to `pages.settings.descriptions.<key>`. |
| `JobAd`                        | **dedicated translation table**           | Long editor-authored content (descriptions can be 1–10 KB). Translations need versioning and per-locale `publishedAt`. Recommended schema: |
| `Workflow.name`/`description`  | **JSONB translations** + add column      | Editor-authored but short. |
| `StageTemplate`                | **JSONB translations** + add column      | Same. |

#### Proposed `JobAdTranslation` schema

```prisma
model JobAdTranslation {
  id          String    @id @default(uuid())
  jobAdId     String
  locale      String                                  // 'en' | 'sk' | 'de' | 'ru' | 'ar' | 'tr'
  title       String
  description String    @db.Text
  publishedAt DateTime?
  jobAd       JobAd     @relation(fields: [jobAdId], references: [id], onDelete: Cascade)

  @@unique([jobAdId, locale])
  @@map("job_ad_translations")
}
```

The current `JobAd` keeps its English `title`/`description` columns as
the canonical row + fallback. The frontend public job listings prefer
`translations[locale]` if a published row exists for that locale.

### 6.3 Seed data review (`backend/prisma/seed.ts`)

The seed inserts 14 document types, 10 job types, 4 notification rules
and 8 system roles. Their names/descriptions are reasonable English
defaults but **not localized**. Recommend:

- Add a one-time backfill that, when seeding for a fresh DB, inserts a
  `translations` JSONB pre-populated with the same content keyed under
  `en`. That makes future admin edits per-locale frictionless.
- For the 8 seeded roles, mirror the names into `enums.role.<id>` in
  the frontend — System Admin / HR Manager / Compliance Officer /
  Recruiter / Agency Manager / Agency User / Finance / Read Only.
- For the 4 notification rules ("Passport Expiry Warning", "Work Permit
  Expiry Critical", "Driving License Expiry", "New Application
  Received") map to `enums.notificationRule.<key>`. Admins won't see
  raw English on a non-English UI.

### 6.4 Sample document type seed → key map

Suggested mapping (frontend `enums.documentType.*`):

| Seed `name` (canonical en) | Stable key                  |
| -------------------------- | --------------------------- |
| Passport                   | `enums.documentType.PASSPORT` |
| National ID Card           | `enums.documentType.NATIONAL_ID` |
| Driving License            | `enums.documentType.DRIVING_LICENSE` |
| Work Permit                | `enums.documentType.WORK_PERMIT` |
| Visa                       | `enums.documentType.VISA` |
| Medical Certificate        | `enums.documentType.MEDICAL_CERTIFICATE` |
| CPC Certificate            | `enums.documentType.CPC` |
| Tachograph Card            | `enums.documentType.TACHOGRAPH` |
| DBS Check                  | `enums.documentType.DBS` |
| Proof of Address           | `enums.documentType.PROOF_OF_ADDRESS` |
| National Insurance Letter  | `enums.documentType.NATIONAL_INSURANCE` |
| Employment Contract        | `enums.documentType.EMPLOYMENT_CONTRACT` |
| Reference Letter           | `enums.documentType.REFERENCE_LETTER` |
| Training Certificate       | `enums.documentType.TRAINING_CERTIFICATE` |
| DVLA Check                 | `enums.documentType.DVLA_CHECK` |

Strategy is **hybrid**: the JSONB column lets admins override per
deployment; the frontend `enums.documentType.*` covers the seeded set
without admin intervention; the merge is `translations[locale]?.name ??
t('enums.documentType.<KEY>', { defaultValue: row.name })`.

### 6.5 Migration list

| New column / table                                | SQL summary                                                     |
| ------------------------------------------------- | --------------------------------------------------------------- |
| `finance_transaction_types.translations`          | `ADD COLUMN IF NOT EXISTS "translations" JSONB`                  |
| `work_history_event_type_settings.translations`   | same                                                             |
| `maintenance_types.translations`                  | same                                                             |
| `workshops.translations`                          | same                                                             |
| `notification_rules.translations`                 | same                                                             |
| `system_settings.translations`                    | same (only for `description`; `key` and `value` are not display) |
| `workflows.translations`                          | same                                                             |
| `stage_templates.translations`                    | same                                                             |
| `job_ad_translations`                             | new table per §6.2                                               |

All can be wrapped in `runStartupMigrations` (idempotent `ADD COLUMN IF
NOT EXISTS`) so existing instances upgrade automatically.

---

## 7. Strategy decision summary

| Concern                                  | Where translation happens     | Why |
| ---------------------------------------- | ----------------------------- | --- |
| API exception messages                   | **Frontend** (codes only on the wire) | Backend remains locale-agnostic; one English fallback per code; full pluralization on the client; existing `apiError(err)` already implements this. |
| Validation messages                      | **Frontend** (codes from a remapped `ValidationPipe`) | Same reasoning + zero changes to 51 DTO files. |
| Email subjects + bodies                  | **Backend**                   | Recipient locale resolved server-side from `User.preferredLanguage`; templates rendered to HTML before send. |
| In-app notification persisted text       | **Backend writes keys, frontend translates** | Notification rows are read by every recipient; persisting English would freeze the language at write time. |
| Excel/PDF/CSV export labels              | **Backend**                   | Whoever clicked "Export" wins; exporter locale = request locale. |
| User-editable label tables               | **DB JSONB translations**      | Admins set per-locale text; frontend reads with merge + English fallback. |
| Long editor-authored content (`JobAd`)   | **Dedicated translation table** | Per-locale publication, audit, versioning. |
| Seeded role / permission / notification-rule names | **Frontend `enums.*`** | Stable codes shipped in source; admins can't accidentally drift. |

---

## 8. Prioritized backlog

### High priority (next pass)

1. Convert the ~143 remaining legacy `throw new XxxException('text')` in
   `users`, `applicants`, `employees`, `agencies`, `documents`,
   `vehicles`, `finance`, `attendance`, `pipeline` to coded form.
   Frontend: extend `errors.json` with the new code groups.
2. Replace the global `ValidationPipe` `exceptionFactory` so 400s emit
   `{ code: 'VALIDATION_FAILED', errors: [{ field, code, params }] }`.
   Add `errors.validation.*` keys.
3. Thread `user.preferredLanguage` through every email caller in
   `auth.service.ts` (5 sends), `applicants.service.ts` (1 send),
   `notifications.service.ts` (1 send).
4. Localize the Excel/PDF export headers in `attendance`, `employees`,
   `applicants`, `finance`. Use `I18nService.resolve(req)` at the
   controller and pass into the export builder.

### Medium priority

5. Migrate notifications persistence to `titleKey + bodyKey + params`,
   with backwards-compatible legacy `title`/`message`. Add
   `notifications.<event>.{title,body}` to the frontend.
6. Add `translations Json?` columns to the eight remaining label
   models (§6.5). Enable admin editing on the relevant Settings pages.
7. Add `enums.documentType.*`, `enums.notificationRule.*`,
   `enums.role.*`, `enums.permission.*` sub-trees in the existing
   `enums.json`.

### Low priority

8. `JobAdTranslation` table + admin UI (long editor-authored content,
   currently English-only — only matters for the public `/jobs` flow).
9. `reports.service.ts` field-label localization (admin-only path).
10. PDF font registration for Arabic shaping (`@react-pdf/renderer` /
    `pdfkit`).

---

## 9. Final answers

- **Backend i18n status:** ✅ plumbing complete (filter, locale resolver,
  email templates, DB translations columns on 3 models). ⚠️ content
  still ~91% English: 143/158 exceptions un-coded, 0 validation
  messages keyed, 7/9 email senders ignore recipient locale, 100% of
  notification persistence is English, 100% of export headers are
  English, 11 of 14 label models have no `translations` column.
- **Top exception files to convert:** `pipeline.service.ts` (25),
  `vehicles.service.ts` (19), `settings.service.ts` (16),
  `attendance.service.ts` (15), `users.service.ts` (14),
  `applicants.service.ts` (10).
- **Top notification surfaces:** vehicle compliance / maintenance,
  finance record events, document upload/expiry. All four already
  follow a stable event-key pattern, which makes the migration to
  `titleKey/bodyKey/params` mostly mechanical.
- **DB models to extend with `translations`:**
  `FinanceTransactionType`, `WorkHistoryEventTypeSetting`,
  `MaintenanceType`, `Workshop`, `NotificationRule`,
  `SystemSetting.description`, `Workflow`, `StageTemplate`. Plus a new
  `JobAdTranslation` table.
- **Suggested next prompt:**

  > Implement Phase A of the backend audit: convert all legacy
  > `throw new XxxException('text')` in `users.service.ts`,
  > `applicants.service.ts`, `employees.service.ts`,
  > `agencies.service.ts`, `documents.service.ts`,
  > `vehicles.service.ts`, `finance.service.ts`,
  > `attendance.service.ts` and `pipeline.service.ts` to
  > `{ code, message, params? }` form. Add the matching codes to the
  > 6 `errors.json` locale files. Run `npm run i18n:check-keys` and
  > the backend build before commit. Push to a new branch.
