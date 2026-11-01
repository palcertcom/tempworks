# Multi-Language / Internationalization Implementation Plan

> **Status:** Proposal — analysis only. No source code has been changed.
> **Target languages:** English (`en`), Slovak (`sk`), German (`de`), Russian (`ru`), Arabic (`ar`, RTL), Turkish (`tr`)
> **Default language:** English
> **RTL languages:** Arabic only

---

## 1. Executive Summary

The TempWorks codebase is a recruitment & compliance management platform built as:

- **Frontend:** React 18 + Vite 6 + `react-router` 7 + Tailwind CSS v4 + Radix UI + MUI 7
- **Backend:** NestJS 10 + Prisma 7 + PostgreSQL
- **Email:** Resend / Nodemailer with HTML templates built directly in `email.service.ts`

Today the application is **English-only with no i18n library installed**. UI text is hardcoded across ~172 `.tsx` files; backend exceptions, validation messages, and email templates are also English-only string literals; database-driven labels (document types, workflow stages, job types, transaction types, roles, permissions, notification rules, system settings) are stored as a single `name` column with no locale variants. There is an existing `User.preferredLanguage` field (default `"en"`) but it is purely cosmetic — nothing in the app reads it for translation today.

We recommend a **hybrid architecture**:

1. **Frontend** owns presentation translations using `i18next` + `react-i18next` + `i18next-browser-languagedetector` with JSON files in `src/i18n/locales/<locale>/<namespace>.json`.
2. **Backend** returns **stable error/validation codes** + machine-readable params; the frontend resolves them to localized messages. Email/notification subjects and bodies are rendered backend-side using a small **Accept-Language**-aware template lookup.
3. **Database-driven user-facing labels** (document types, workflow stage names, job types, transaction types, system settings) get an **optional `translations JSONB`** column (e.g. `{ "en": "...", "ar": "..." }`) plus a fallback to the existing `name`. No new tables required.
4. **RTL** is wired centrally in `App.tsx` by setting `<html dir lang>` from the active locale; Tailwind v4 logical utilities (`ms-*`, `me-*`, `ps-*`, `pe-*`, `text-start`, `text-end`, `start-*`, `end-*`) replace `ml-*`, `mr-*`, `pl-*`, `pr-*`, `text-left`, `text-right`, `left-*`, `right-*` over the course of the rollout.

The codebase is **ready for Phase 1** — the structure is clean, single-tree (`src/app`), and `ThemeContext` provides a pattern we can mirror for `LanguageContext`.

---

## 2. Current Codebase Findings

### 2.1 Project structure

| Layer        | Tech                                                               | Entry                                                  |
| ------------ | ------------------------------------------------------------------ | ------------------------------------------------------ |
| Frontend SPA | React 18 + Vite + `react-router@7` (`createBrowserRouter`)         | `src/main.tsx` → `src/app/App.tsx` → `src/app/routes.ts` |
| Layout       | `MainLayout` / `Sidebar` / `Topbar`                                | `src/app/components/layout/`                           |
| Pages        | ~80 page components grouped by feature                             | `src/app/pages/<feature>/`                             |
| UI kit       | shadcn-style components on Radix + MUI                             | `src/app/components/ui/`                               |
| Styles       | Tailwind v4 (via `@tailwindcss/vite`) + CSS variables for theming  | `src/styles/index.css`, `theme.css`                    |
| Backend      | NestJS modules per domain (auth, employees, documents, workflow…) | `backend/src/<domain>/`                                |
| ORM          | Prisma 7 (`backend/prisma/schema.prisma`, ~2040 lines, ~70 models) | `backend/prisma/`                                      |
| Email        | Single `EmailService` with hand-rolled HTML templates (`buildXTemplate`) | `backend/src/email/email.service.ts`                   |

`<html lang="en">` is hardcoded in `index.html`; there is no `dir` attribute.

### 2.2 Where UI text is hardcoded

UI strings are **literal JSX text** scattered across all pages and components. Representative samples:

- Sidebar nav labels — `src/app/components/layout/Sidebar.tsx`:
  `'Dashboard'`, `'Applicants'`, `'Candidates'`, `'Employees'`, `'Attendance Sheets'`, `'Vehicles'`, `'Documents & Compliance'`, `'Workflows'`, `'Agencies'`, `'Reports'`, `'Finance'`, `'Job Ads'`, `'Notifications'`, `'Users'`, `'Roles & Permissions'`, `'System Logs'`, `'Deleted Records'`, `'Settings'`.
- Topbar — `src/app/components/layout/Topbar.tsx`: search placeholder, `'just now'`, `'Xm ago'`, dropdown items, dialog titles.
- Login flow — `src/app/pages/public/LoginPage.tsx`: `'Welcome back!'` toasts, validation copy.
- Document statuses — `DocumentPreview.tsx`/`EmployeeDocumentExplorer.tsx`: `'Valid'`, `'Rejected'`, `'Pending Review'`, `'Verified By'`, `'Rejected By'`.
- User Preferences — `src/app/pages/profile/UserPreferences.tsx`: a hand-built language `<Select>` with values `'English' | 'Arabic' | 'Polish' | 'German' | 'French' | 'Spanish' | 'Italian' | 'Romanian' | 'Ukrainian'` (note: list does NOT match the i18n target list).

### 2.3 Where backend strings are generated

- **Exceptions:** ~354 occurrences of `throw new XxxException('English text')` across `backend/src/**`. Examples in `auth/auth.service.ts`: `'Invalid credentials'`, `'Account locked due to repeated failed attempts. Try again later.'`.
- **Validation:** `class-validator` decorators with English `message:` overrides (~83 hits: `@IsEmail`, `@MinLength`, `@Matches`, `@IsNotEmpty`).
- **Email templates:** built in `EmailService` (`buildActivationTemplate`, `buildPasswordResetTemplate`, `buildPasswordChangedTemplate`, `buildPasswordExpiredTemplate`, `buildAccountLockedTemplate`, `buildWelcomeTemplate`, `buildApplicationConfirmationTemplate`, `buildNotificationTemplate`) — all inline English HTML with `<html lang="en">`.
- **Notifications:** built in `notifications/notification-events.ts` and `notifications.service.ts` — English title + message strings, persisted to DB as plain text.
- **Enums (canonical machine codes):**
  `UserStatus`, `EmployeeStatus`, `ApplicantStatus`, `DocumentStatus`, `WorkflowStageStatus`, `WorkPermitStatus`, `VisaStatus`, `ApplicantTier`, `Gender`, `AlertSeverity`, `AlertStatus`, `NotificationType`, `EntityType`, `WorkflowCategory`, `WorkflowStatus`, `CandidateProgressStatus`, `WorkflowAssignmentStatus`, `ApprovalDecision`, `AttendanceStatus`, `FuelType`, `MaintenanceStatus`, `IntervalMode`. These are uppercase codes — safe to translate purely on the frontend.
- **Database-driven labels (user-editable, currently single-language):**
  `Role.name`, `Permission` (likely with `description`), `DocumentType.name + description`, `JobType` (label/name), `WorkflowStage.name + description`, `WorkflowCategory` enum, `FinanceTransactionType`, `WorkHistoryEventTypeSetting`, `MaintenanceType`, `Workshop`, `NotificationRule.name`, `SystemSetting.value/description`. These cannot be solved by frontend translation alone.

### 2.4 Existing i18n support

```
$ grep -ril "i18next|react-i18next|next-intl|formatjs" → 0 hits
$ grep "Intl\."   → 2 files (Number/Currency formatting in finance views)
$ grep "locale"   → 4 files (mostly variable names, not i18n)
$ grep "dir=|rtl|ltr" → none for layout direction
```

Findings:

- **No i18n library** is installed (`package.json` has none of: `i18next`, `react-i18next`, `next-intl`, `formatjs`, `lingui`).
- `Intl.NumberFormat` is used in two places (`FinancialRecordsTab.tsx`, `FinanceDashboard.tsx`) for currency display, but with hardcoded `'en-US'`/`'USD'`.
- Date formatting uses `date-fns` 3.6.0 with default (English) locale.
- `User.preferredLanguage String? @default("en")` exists in schema and is editable in `UserPreferences.tsx`, but the value is **never read** for translation; it is treated as a profile attribute.
- No `dir="rtl"` / `dir="ltr"` toggling anywhere.
- No language switcher in the UI.

**Conclusion:** Greenfield i18n implementation. We do not need to migrate from a previous library.

---

## 3. Recommended Architecture

### 3.1 Frontend i18n stack

```
i18next                          ^23
react-i18next                    ^14
i18next-browser-languagedetector ^7
i18next-http-backend             ^2  (optional, lazy load namespaces)
```

Justification:

- React 18 + Vite + `react-router@7` is fully compatible with `react-i18next`.
- We are not on Next.js, so `next-intl` is not appropriate.
- `i18next` supports namespacing (one JSON per feature), interpolation, plurals, gender/context, and runtime language switching with re-render — all of which we need.
- `i18next-browser-languagedetector` covers `localStorage` + browser language detection out of the box (the user requirement).

### 3.2 File structure (proposed)

```
src/
  i18n/
    index.ts                         # init + export i18n instance
    config.ts                        # SUPPORTED_LOCALES, RTL_LOCALES, fallback
    LanguageContext.tsx              # provider + useLanguage() hook
    LanguageSwitcher.tsx             # UI component (used in Topbar + Login)
    formatters.ts                    # Intl.DateTimeFormat / NumberFormat helpers
    locales/
      en/
        common.json                  # buttons, generic labels, validation
        auth.json
        nav.json                     # sidebar + topbar nav
        dashboard.json
        employees.json
        applicants.json
        candidates.json
        agencies.json
        documents.json
        workflow.json
        finance.json
        vehicles.json
        attendance.json
        reports.json
        notifications.json
        settings.json
        roles.json
        users.json
        job-ads.json
        public.json                  # landing, login, apply, jobs
        enums.json                   # status / category / role label maps
        errors.json                  # backend error code → message map
      ar/ ...                        # same files, RTL
      sk/ ...
      de/ ...
      ru/ ...
      tr/ ...
```

### 3.3 Backend strategy: hybrid

| Concern                                | Where translated         | Mechanism                                                     |
| -------------------------------------- | ------------------------ | ------------------------------------------------------------- |
| API errors (400/401/403/404/409/422)   | **Frontend**             | Backend returns `{ code: "AUTH.INVALID_CREDENTIALS", params }`; FE resolves via `errors.json`. |
| `class-validator` messages             | **Frontend**             | Switch decorators to short codes (`'auth.email.invalid'`); a global `ValidationPipe` exception filter maps to `{ code, field, params }`. |
| Enum display labels                    | **Frontend**             | Codes already uppercase (`PENDING`, `ACTIVE`); FE `enums.json` maps to user-facing strings per locale. |
| Email subjects + bodies                | **Backend**              | Per-locale templates keyed by `{ locale, templateId }`; pick locale from recipient `User.preferredLanguage` (fallback `Accept-Language`, then `en`). |
| In-app notification title/body         | **Backend (hybrid)**     | Persist `eventType` + `params JSON` (already partially structured). Frontend resolves at render. Existing free-text notifications get a one-time backfill / on-the-fly fallback. |
| Document type / workflow stage names   | **Database (translations JSONB)** | Optional `translations Json?` column; frontend reads `translations[locale] ?? name`. |
| Roles / permissions                    | **Frontend**             | System role/permission codes are stable strings (`'System Admin'`, `'employees:read'`). Frontend `roles.json` translates the labels; only `description` may need DB translations. |
| Public job ads                         | **Database**             | `JobAd` is editor-authored content; add `titleTranslations Json?`, `descriptionTranslations Json?`. |
| System settings (display labels)       | **Frontend** (key-based) | Settings keys are stable; FE owns the labels. |

Locale resolution order on the backend:

1. Explicit `?lang=` query (for unauthenticated public endpoints).
2. Authenticated request → `req.user.preferredLanguage`.
3. `Accept-Language` header (parsed, matched against supported locales).
4. Fallback to `en`.

Implemented as a `LanguageInterceptor` + `i18n.service.ts` (NestJS), or via the existing `nestjs-i18n` package if we want a drop-in.

---

## 4. Frontend Implementation Plan

### 4.1 `src/i18n/config.ts`

```ts
export const SUPPORTED_LOCALES = ['en', 'sk', 'de', 'ru', 'ar', 'tr'] as const;
export type Locale = typeof SUPPORTED_LOCALES[number];

export const RTL_LOCALES: readonly Locale[] = ['ar'];
export const FALLBACK_LOCALE: Locale = 'en';

export const LOCALE_LABELS: Record<Locale, string> = {
  en: 'English',
  sk: 'Slovenčina',
  de: 'Deutsch',
  ru: 'Русский',
  ar: 'العربية',
  tr: 'Türkçe',
};

export const dirOf = (l: Locale) => (RTL_LOCALES.includes(l) ? 'rtl' : 'ltr');
```

### 4.2 `src/i18n/index.ts`

```ts
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { SUPPORTED_LOCALES, FALLBACK_LOCALE } from './config';

import enCommon  from './locales/en/common.json';
import enNav     from './locales/en/nav.json';
// ...repeat for every namespace × locale (or use http-backend for lazy loading)

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    fallbackLng: FALLBACK_LOCALE,
    supportedLngs: [...SUPPORTED_LOCALES],
    ns: ['common', 'nav', 'auth', 'dashboard', /* ... */],
    defaultNS: 'common',
    detection: {
      order: ['localStorage', 'navigator', 'htmlTag'],
      caches: ['localStorage'],
      lookupLocalStorage: 'tempworks.lang',
    },
    interpolation: { escapeValue: false },
    resources: {
      en: { common: enCommon, nav: enNav /* ... */ },
      // ar, sk, de, ru, tr
    },
    returnNull: false,
  });

export default i18n;
```

### 4.3 `src/i18n/LanguageContext.tsx`

```tsx
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import i18n from './index';
import { dirOf, SUPPORTED_LOCALES, type Locale } from './config';

interface LanguageContextType {
  locale: Locale;
  dir: 'ltr' | 'rtl';
  setLocale: (l: Locale) => void;
}

const LanguageContext = createContext<LanguageContextType | null>(null);

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(
    () => (SUPPORTED_LOCALES.find(l => l === i18n.language) ?? 'en') as Locale,
  );

  useEffect(() => {
    const dir = dirOf(locale);
    document.documentElement.lang = locale;
    document.documentElement.dir  = dir;
  }, [locale]);

  const setLocale = (l: Locale) => {
    void i18n.changeLanguage(l);
    localStorage.setItem('tempworks.lang', l);
    setLocaleState(l);
    // Also mirror to backend (optional): authApi.updatePreferredLanguage(l)
  };

  return (
    <LanguageContext.Provider value={{ locale, dir: dirOf(locale), setLocale }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error('useLanguage must be used within LanguageProvider');
  return ctx;
}
```

Wire it in `src/app/App.tsx` next to `ThemeProvider` / `AuthProvider`:

```tsx
<ThemeProvider>
  <LanguageProvider>
    <AuthProvider>
      ...
    </AuthProvider>
  </LanguageProvider>
</ThemeProvider>
```

### 4.4 Language switcher (sample)

```tsx
// src/i18n/LanguageSwitcher.tsx
import { Globe } from 'lucide-react';
import { useLanguage } from './LanguageContext';
import { SUPPORTED_LOCALES, LOCALE_LABELS } from './config';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from '../app/components/ui/dropdown-menu';

export function LanguageSwitcher() {
  const { locale, setLocale } = useLanguage();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex items-center gap-2 px-2 py-1 rounded-md hover:bg-accent">
        <Globe className="w-4 h-4" />
        <span className="text-sm">{LOCALE_LABELS[locale]}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {SUPPORTED_LOCALES.map(l => (
          <DropdownMenuItem key={l} onClick={() => setLocale(l)} aria-current={l === locale}>
            {LOCALE_LABELS[l]}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

Mounted in `Topbar.tsx` (next to the existing `Globe` icon already imported) and on `LoginPage.tsx` (top-right corner of the auth card).

### 4.5 Using translations

```tsx
import { useTranslation } from 'react-i18next';

export function EmployeesList() {
  const { t } = useTranslation('employees');
  return (
    <div>
      <h1>{t('list.title')}</h1>
      <button>{t('list.actions.addEmployee')}</button>
    </div>
  );
}
```

Status enums (`enums.json`):

```json
{
  "documentStatus": {
    "PENDING":        "Pending Review",
    "VERIFIED":       "Valid",
    "REJECTED":       "Rejected",
    "EXPIRED":        "Expired",
    "EXPIRING_SOON":  "Expiring Soon"
  }
}
```

Helper:

```ts
// src/i18n/enumLabel.ts
import i18n from './index';
export const enumLabel = (group: string, code: string) =>
  i18n.t(`${group}.${code}`, { ns: 'enums', defaultValue: code });
```

### 4.6 Date / number / currency

```ts
// src/i18n/formatters.ts
import i18n from './index';

const localeForIntl = () => (i18n.language === 'ar' ? 'ar' : i18n.language);

export const formatDate = (d: Date | string, opts?: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat(localeForIntl(), { dateStyle: 'medium', ...opts })
    .format(typeof d === 'string' ? new Date(d) : d);

export const formatNumber = (n: number, opts?: Intl.NumberFormatOptions) =>
  new Intl.NumberFormat(localeForIntl(), opts).format(n);

export const formatCurrency = (n: number, currency = 'EUR') =>
  new Intl.NumberFormat(localeForIntl(), { style: 'currency', currency }).format(n);
```

For date-fns, swap to its `locale` argument: `import { ar, sk, de, ru, tr, enUS } from 'date-fns/locale'` and pick by current locale.

> **Arabic numeric note:** Default `'ar'` BCP-47 emits Arabic-Indic digits. If product wants Latin digits in Arabic, use `'ar-EG-u-nu-latn'` or `'ar-u-nu-latn'`.

---

## 5. Backend Implementation Plan

### 5.1 Error code catalog

Convert all `throw new XxxException('English text')` to:

```ts
throw new UnauthorizedException({
  code: 'AUTH.INVALID_CREDENTIALS',
  message: 'Invalid credentials',     // English fallback retained for logs/non-i18n clients
  params: {},
});
```

Add `backend/src/common/filters/i18n-exception.filter.ts` that:

- normalizes any `HttpException` whose response is a string into the `{ code, message, params }` shape;
- preserves status codes;
- **leaves the English `message` in place** so existing non-i18n clients (Swagger, scripts) keep working.

Frontend `errors.json` example:

```json
{
  "AUTH.INVALID_CREDENTIALS": "Invalid email or password.",
  "AUTH.ACCOUNT_LOCKED":      "Your account is temporarily locked. Try again in {{minutes}} minutes.",
  "USERS.EMAIL_TAKEN":        "This email address is already registered.",
  "GENERIC.UNEXPECTED":       "Something went wrong. Please try again."
}
```

A small `apiError(error, t)` helper in `src/app/services/api.ts` resolves `error.code` against `t` and falls back to `error.message` then a generic message.

### 5.2 Validation messages

Rewrite `class-validator` decorators to short codes:

```ts
@IsEmail({}, { message: 'validation.email.invalid' })
@MinLength(8, { message: 'validation.password.minLength|min=8' })
```

A `ValidationPipe({ exceptionFactory })` converts the array of validation errors into:

```ts
{ code: 'VALIDATION_FAILED', errors: [{ field: 'password', code: 'validation.password.minLength', params: { min: 8 } }] }
```

Frontend resolves codes via `errors.json` / form-field labels.

### 5.3 Email templates

Add per-locale templates rather than translating HTML at runtime:

```
backend/src/email/templates/
  activation/
    en.html   sk.html   de.html   ru.html   ar.html   tr.html
  password-reset/
    ...
  welcome/
    ...
  application-confirmation/
    ...
```

`EmailService` resolves locale from:

1. Explicit `locale` argument (caller decides based on user/recipient context).
2. Recipient `User.preferredLanguage`.
3. `en` fallback.

Use a tiny mustache-style replacer (no new dependency) or adopt `handlebars` (small, already in many Nest projects). Subjects move to `backend/src/email/i18n/<locale>.json`. The `<html lang>` and `dir` attributes in each template must reflect the locale (`<html lang="ar" dir="rtl">`).

### 5.4 Notifications

`NotificationType` enum already exists. Persist:

```
{ type: 'DOCUMENT_EXPIRY', titleKey: 'notif.docExpiry.title',
  bodyKey: 'notif.docExpiry.body', params: { docName, daysLeft } }
```

The notifications table currently stores `title String` and `message String`. Either:

- **Recommended:** add `titleKey String?`, `bodyKey String?`, `params Json?` columns; keep `title`/`message` populated with English for backwards compatibility and search.
- Frontend prefers `titleKey + params` when present; otherwise renders the legacy free-text.

### 5.5 NestJS i18n option (alternative)

If the team wants a single library: `nestjs-i18n` provides:

- `I18nService` injectable
- `Accept-Language` resolver out of the box
- JSON file loader matching the same on-disk layout

Decision: **start with the lightweight code-based approach** for errors + notifications (less dependency surface, gives full control), and consider `nestjs-i18n` only if email templating grows complex.

---

## 6. Database Translation Strategy

### 6.1 What needs DB translation

User-editable, displayed-to-end-user labels currently stored in a single column:

| Model                            | Fields needing translation       |
| -------------------------------- | -------------------------------- |
| `DocumentType`                   | `name`, `description`            |
| `JobType`                        | `name` (or label field)          |
| `WorkflowStage`                  | `name`, `description`            |
| `FinanceTransactionType`         | `name`/`label`                   |
| `WorkHistoryEventTypeSetting`    | `label`                          |
| `MaintenanceType`                | `name`                           |
| `Workshop`                       | `name`                           |
| `NotificationRule`               | `name`                           |
| `JobAd`                          | `title`, `description`           |
| `SystemSetting`                  | `description` (display only)     |
| `Role.description`               | optional                         |
| `Permission.description`         | optional                         |

Stable codes (uppercase enums, role keys like `'System Admin'`, permission keys like `'employees:read'`) stay untouched and are translated **frontend-side**.

### 6.2 Recommended pattern: JSONB translations column

For each of the above models, add an optional column:

```prisma
model DocumentType {
  id           String  @id @default(uuid())
  name         String  @unique           // canonical English (still indexed/unique)
  description  String?
  // NEW
  translations Json?                     // { "ar": { "name": "جواز سفر", "description": "..." }, "sk": { ... } }
  // ...
}
```

Why JSONB over separate translation tables:

- Tens of models — separate tables would 2× the schema and require N joins per list query.
- Translation count is small (≤6 locales) and rarely queried independently.
- Editors can update all locales in a single record-level form.
- Postgres JSONB is indexable if needed (`->>'ar'`).

A small Nest helper:

```ts
function localized<T extends { name: string; translations?: any }>(
  row: T, locale: string, field: 'name' | 'description' = 'name',
): string {
  return row.translations?.[locale]?.[field] ?? row[field as keyof T] as string;
}
```

### 6.3 Use a separate table only for `JobAd`

Public-facing job postings benefit from a real translations table because:

- Each translation is a long body (1–10 KB).
- Translations may be authored independently and require versioning/audit.
- We may add a `published` flag per locale.

```prisma
model JobAd {
  id          String  @id @default(uuid())
  // English / canonical fields stay
  title       String
  description String?
  translations JobAdTranslation[]
}

model JobAdTranslation {
  id          String @id @default(uuid())
  jobAdId     String
  locale      String                              // 'en' | 'sk' | 'de' | 'ru' | 'ar' | 'tr'
  title       String
  description String
  publishedAt DateTime?
  jobAd       JobAd  @relation(fields: [jobAdId], references: [id], onDelete: Cascade)

  @@unique([jobAdId, locale])
  @@map("job_ad_translations")
}
```

### 6.4 Out of scope (translate frontend-side)

- Enum codes (`PENDING`, `ACTIVE`, `APPROVED`, …)
- Permission codes (`employees:read`, `documents:upload`, …)
- Built-in role names if they remain system-managed (`System Admin`, `HR Manager`, …) — translate via `roles.json`.

---

## 7. RTL / LTR Strategy

### 7.1 Direction switching

Centralized in `LanguageProvider` (section 4.3): on every locale change, set `document.documentElement.dir` and `document.documentElement.lang`. Tailwind v4 already supports the `rtl:` and `ltr:` variant prefixes; component overrides become possible (e.g. `rtl:rotate-180` for chevrons).

Add to `src/styles/index.css`:

```css
html[dir="rtl"] body { font-family: 'Noto Naskh Arabic', 'Cairo', system-ui, sans-serif; }
```

### 7.2 RTL-blocking patterns currently in code

A grep over `src/app/**.tsx` finds:

| Pattern                        | Hits | Action                                                                 |
| ------------------------------ | ---- | ---------------------------------------------------------------------- |
| `ml-*`, `mr-*`, `pl-*`, `pr-*` (directional spacing) | **806 lines, ~423 strict ml-/mr- usages** | Replace with `ms-*` / `me-*` / `ps-*` / `pe-*` (logical) |
| `text-left`, `text-right`      | 155  | Replace with `text-start` / `text-end`                                 |
| `absolute … left-* / right-*`  | 94   | Replace with `start-*` / `end-*`                                       |
| `lucide-react` chevron icons (`ChevronLeft`, `ChevronRight`) used for nav, sidebar collapse, breadcrumbs | many | Mirror in RTL via `rtl:rotate-180` on the icon, or pick the icon based on `dir` |

The bulk migration is mechanical. We can drive it with a codemod (see Phase 5) and audit the remaining cases manually.

### 7.3 Hot-spot components for manual RTL review

- `components/layout/Sidebar.tsx` — the sidebar should anchor to the **end** (right) in RTL; collapse arrow direction must flip.
- `components/layout/Topbar.tsx` — search icon position, dropdowns alignment (`align="end"` already works), notification bell, user menu.
- `components/ui/breadcrumb.tsx`, `pagination.tsx`, `dropdown-menu.tsx`, `dialog.tsx`, `sheet.tsx` (Radix) — most are dir-aware out of the box.
- Tables — `text-end` for numeric/currency columns; horizontal scroll arrows must mirror.
- Forms — keep error icons on the field's logical end (use `me-*` / `ms-*`).
- Charts (`recharts`) — axis labels, tooltip alignment; some manual tweaks per chart.
- PDFs (`@react-pdf/renderer`, `pdf-lib`) — separate work item; PDFs default to LTR. For Arabic PDFs we will need a font with Arabic shaping (e.g., Amiri/Noto Naskh) registered explicitly.
- `EmailService` HTML — locale-specific templates already include `dir="rtl"` for `ar`.

### 7.4 Tailwind RTL plugin

**Not required** with Tailwind v4 — logical utilities (`ms-*`, `me-*`, `text-start`, `text-end`, `start-*`, `end-*`) and the built-in `rtl:` variant cover all our needs. We may still add `tailwindcss-logical` for any utilities not yet logical-ized in v4 (rare).

---

## 8. Translation File Structure (final)

```
src/i18n/
  index.ts
  config.ts
  LanguageContext.tsx
  LanguageSwitcher.tsx
  formatters.ts
  enumLabel.ts
  locales/
    en/  common.json  nav.json  auth.json  dashboard.json
         employees.json  applicants.json  candidates.json  agencies.json
         documents.json  workflow.json  finance.json  vehicles.json
         attendance.json  reports.json  notifications.json  settings.json
         roles.json  users.json  job-ads.json  public.json
         enums.json   errors.json
    ar/  ... (same set, RTL-authored)
    sk/  ...
    de/  ...
    ru/  ...
    tr/  ...
```

### Sample `en/common.json`

```json
{
  "actions": {
    "save": "Save",
    "cancel": "Cancel",
    "edit": "Edit",
    "delete": "Delete",
    "add": "Add",
    "search": "Search",
    "filter": "Filter",
    "export": "Export",
    "back": "Back",
    "next": "Next",
    "previous": "Previous",
    "confirm": "Confirm"
  },
  "states": {
    "loading": "Loading…",
    "empty":   "No results",
    "error":   "Something went wrong"
  },
  "table": {
    "rowsPerPage": "Rows per page",
    "of": "of",
    "page": "Page {{current}} of {{total}}"
  }
}
```

### Sample `en/auth.json`

```json
{
  "login": {
    "title": "Welcome back",
    "subtitle": "Sign in to your TempWorks account",
    "email": "Email",
    "password": "Password",
    "submit": "Sign in",
    "forgot": "Forgot password?",
    "twoFactor": {
      "title": "Two-factor authentication",
      "description": "Enter the 6-digit code sent to {{email}}",
      "resend": "Resend code",
      "verify": "Verify"
    }
  },
  "toasts": {
    "welcomeBack": "Welcome back!",
    "loggedOut": "You have been signed out."
  }
}
```

### Sample `ar/auth.json` (RTL)

```json
{
  "login": {
    "title": "مرحبًا بعودتك",
    "subtitle": "سجّل الدخول إلى حساب TempWorks الخاص بك",
    "email": "البريد الإلكتروني",
    "password": "كلمة المرور",
    "submit": "تسجيل الدخول",
    "forgot": "نسيت كلمة المرور؟"
  }
}
```

### Sample `en/enums.json`

```json
{
  "documentStatus": {
    "PENDING":  "Pending Review",
    "VERIFIED": "Valid",
    "REJECTED": "Rejected",
    "EXPIRED":  "Expired",
    "EXPIRING_SOON": "Expiring Soon"
  },
  "applicantStatus": {
    "NEW": "New", "SCREENING": "Screening", "INTERVIEW": "Interview",
    "OFFER": "Offer", "ACCEPTED": "Accepted", "REJECTED": "Rejected",
    "WITHDRAWN": "Withdrawn", "ONBOARDING": "Onboarding"
  },
  "workPermitStatus": {
    "PENDING": "Pending", "APPLIED": "Applied", "APPROVED": "Approved",
    "REJECTED": "Rejected", "EXPIRED": "Expired", "CANCELLED": "Cancelled"
  }
}
```

---

## 9. Phased Roadmap

### Phase 1 — Foundation (1 sprint)

- Install `i18next`, `react-i18next`, `i18next-browser-languagedetector`.
- Create `src/i18n/{config,index,LanguageContext,LanguageSwitcher,formatters,enumLabel}.ts`.
- Wire `<LanguageProvider>` in `App.tsx`; remove hardcoded `<html lang="en">` (driven from JS now).
- Create empty namespaces for all 6 locales (English filled, others can stub-translate via fallback).
- Translate **public flow** end-to-end:
  - `LandingPage`, `LoginPage`, `ForgotPasswordPage`, `ResetPasswordPage`, `ActivationPage`,
  - `PublicEmployeeApplication`, `ApplicationSuccess`, `JobListings`, `JobDetail`, `DataProcessingAgreement`.
- Add `LanguageSwitcher` to login screen + Topbar.
- Unit-test direction toggling.

**Exit criteria:** Switching language on the login page changes copy + flips `dir` for `ar`. Backend untouched.

### Phase 2 — App chrome (1 sprint)

- Translate `Sidebar` nav labels, `Topbar` (search, notifications dropdown, user menu, dialogs).
- Translate generic UI in `components/ui/*` (e.g. confirm dialogs, pagination).
- Translate Dashboard widgets, common buttons, table headers, filter labels.
- Replace hardcoded `'en-US'` in finance components with locale-aware Intl helpers.
- Codemod pass 1: directional Tailwind classes → logical utilities for the layout components only.

### Phase 3 — Feature modules (2–3 sprints)

Translate page-by-page (one feature per PR keeps reviews tractable):

1. Employees (list, profile, add/edit, certifications, training, compliance timeline, performance)
2. Applicants & Candidates
3. Agencies
4. Documents & Compliance
5. Workflow / Pipelines
6. Finance
7. Vehicles + Workshops + Maintenance
8. Attendance
9. Reports
10. Notifications + Settings
11. Roles & Users
12. Job Ads + Recycle Bin + Logs

Each PR also runs the Tailwind directional codemod over the page tree and adds RTL screenshots.

### Phase 4 — Backend + DB-driven labels (1 sprint)

- Introduce `i18n-exception.filter.ts`; convert exceptions to `{ code, message, params }`.
- Introduce shared `errors.json` on the frontend.
- Migrate `class-validator` messages to keys; rebuild `ValidationPipe`.
- Per-locale email templates + subject map; locale resolved from `User.preferredLanguage`.
- Add `translations Json?` columns to: `DocumentType`, `JobType`, `WorkflowStage`, `FinanceTransactionType`, `WorkHistoryEventTypeSetting`, `MaintenanceType`, `Workshop`, `NotificationRule`. Provide an editing UI in their settings pages.
- Add `JobAdTranslation` table + UI tabs per locale on the JobAd form.
- Migrate notifications to `titleKey + bodyKey + params` (keep legacy fallback for old rows).

### Phase 5 — RTL polish & QA

- Full RTL pass: visual review of every page in `ar`. Expected hot spots: data tables (header alignment), charts (recharts axes/tooltip), date pickers, sidebar toggle arrow, breadcrumbs, drag-and-drop pipelines (`react-dnd`), masonry layouts, carousels.
- PDF rendering: register Arabic fonts in `@react-pdf/renderer` & `pdf-lib`; verify generated PDFs (offer letters, attendance sheets, finance exports).
- Pseudo-localization run for English to catch any remaining hardcoded strings (`[!!Sign in!!]` style).
- Performance check: bundle splitting per locale via dynamic `import('./locales/<locale>/...')`.
- Translator handoff: lock English keys; commission native translations for `sk`, `de`, `ru`, `ar`, `tr`.
- Regression suite: add one e2e test per locale covering login → dashboard → key form.

---

## 10. Example Code Snippets

### Translating a page (before / after)

```tsx
// before — src/app/components/layout/Sidebar.tsx
const allNavigationItems = [
  { icon: LayoutDashboard, label: 'Dashboard', path: '/dashboard', permission: null },
  { icon: UserCheck,       label: 'Applicants', path: '/dashboard/applicants', permission: 'applicants:read' },
  // ...
];
```

```tsx
// after
import { useTranslation } from 'react-i18next';

export function Sidebar(...) {
  const { t } = useTranslation('nav');
  const allNavigationItems = [
    { icon: LayoutDashboard, labelKey: 'dashboard',  path: '/dashboard', permission: null },
    { icon: UserCheck,       labelKey: 'applicants', path: '/dashboard/applicants', permission: 'applicants:read' },
    // ...
  ];
  // render: <span>{t(item.labelKey)}</span>
}
```

### Backend exception (before / after)

```ts
// before
throw new UnauthorizedException('Invalid credentials');

// after
throw new UnauthorizedException({
  code: 'AUTH.INVALID_CREDENTIALS',
  message: 'Invalid credentials',  // English fallback for non-i18n consumers
  params: {},
});
```

### Localized DB record read

```ts
const types = await prisma.documentType.findMany();
return types.map(t => ({
  ...t,
  name: t.translations?.[locale]?.name ?? t.name,
  description: t.translations?.[locale]?.description ?? t.description,
}));
```

### Logical Tailwind class swap

```tsx
// before
<div className="flex items-center pl-4 pr-2 ml-auto text-right">

// after
<div className="flex items-center ps-4 pe-2 ms-auto text-end">
```

### Mirrored chevron

```tsx
<ChevronRight className="rtl:rotate-180" />
```

---

## 11. Testing Checklist

Per-locale smoke (manual):

- [ ] Language switcher visible on login, persists across reload.
- [ ] `<html lang>` and `<html dir>` reflect the active locale.
- [ ] Login → dashboard works for all 6 locales.
- [ ] Sidebar, Topbar, breadcrumbs render correctly in RTL (Arabic).
- [ ] Toasts (sonner) flow from the correct edge in RTL.
- [ ] Date picker (`react-day-picker`) week starts on locale-correct day.
- [ ] Currency in Finance dashboard shows locale-correct format.
- [ ] Tables: numeric columns right/end-aligned; sort arrows mirrored.
- [ ] Forms: required-field asterisks on logical end; error icons positioned consistently.
- [ ] PDF exports render Arabic glyphs correctly (no boxes / reversed letters).

Automation:

- [ ] Add a Vitest pseudo-localization test that mounts a representative page tree and asserts no untranslated raw strings escape.
- [ ] Add an ESLint rule (`react/jsx-no-literals` configured for source files only) to fail PRs that introduce new hardcoded JSX text.
- [ ] Add a Playwright test that toggles each locale and snapshots key pages.
- [ ] Run `tsc --noEmit` after every namespace addition; all `t('foo.bar')` calls must resolve at runtime.
- [ ] Backend tests: hit each endpoint with `Accept-Language: ar` and assert the response shape includes `code` (not just English message).

---

## 12. Risks & Mitigations

| Risk                                                               | Mitigation                                                                                  |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Hardcoded strings scattered across ~172 component files            | Phase rollout per feature; ESLint rule on new code; pseudo-localization test gates merges.  |
| Backend English messages currently rendered directly in the UI     | Phase 4 introduces stable codes + frontend `errors.json`; preserve English fallback for non-i18n consumers. |
| Tables breaking in RTL (numeric columns, sort arrows, scroll)      | Convert all directional Tailwind classes to logical utilities; manual RTL audit per page.   |
| Mixed Arabic/English layouts (English brand strings inside Arabic UI) | Force-mark BiDi-sensitive spans with `<bdi>` and `direction:isolate` where needed.        |
| Date / currency formatting inconsistencies                         | Centralize via `formatters.ts`; replace all hardcoded `'en-US'` and `'USD'`.               |
| Database-driven labels (DocumentType, WorkflowStage…) untranslated | JSONB `translations` column + admin UI in Phase 4; fallback to canonical English.           |
| Roles / permissions labels untranslated                            | Translate codes via `roles.json`; only `description` columns get DB translations.           |
| Validation messages inconsistent between FE and BE                 | Single `validation.*` key namespace shared via stable codes; one source of truth.           |
| Email subjects in mixed locale when an admin sends to many users   | Resolve per-recipient locale; loop and personalize.                                         |
| PDF generation lacks Arabic shaping                                 | Register Arabic font (Amiri/Noto Naskh) explicitly; add unit test rendering an Arabic PDF.  |
| Bundle size grows with all locales pre-loaded                      | Lazy-load namespaces with `i18next-http-backend` or dynamic JSON imports.                   |
| Translation drift (English keys updated, others stale)             | CI script that diffs key sets across locales; missing keys → warning (not error) + log.     |
| `User.preferredLanguage` values inconsistent (`'English'` vs `'en'`) | Normalize on read; migration script to map free-text values to BCP-47 codes.              |

---

## 13. Final Recommendation

- **Library:** `i18next` + `react-i18next` + `i18next-browser-languagedetector` on the frontend; lightweight in-house exception filter + per-locale email templates on the backend.
- **Architecture:** hybrid — frontend owns presentation translation (errors, validations, enums); backend owns email/notification rendering; database stores translations as JSONB columns where editor-authored content varies (with a dedicated `JobAdTranslation` table for long content).
- **Direction:** flip `<html dir>` centrally from `LanguageProvider`. Use Tailwind v4 logical utilities — no plugin needed.
- **Default:** `en`. Detection order: `localStorage` → browser → `en`. Mirror the user's choice into `User.preferredLanguage` for backend email rendering.

The codebase is well-suited for a progressive rollout: routing is centralized, layout is encapsulated in three components, and there is no legacy i18n technology to migrate from. Phase 1 is safe to start without any backend changes.
