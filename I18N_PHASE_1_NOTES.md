# i18n — Phase 1 Notes

This branch lays the frontend internationalization foundation defined in
`MULTI_LANGUAGE_IMPLEMENTATION_PLAN.md`. The backend is **untouched**: no
controllers, services, prisma schema or environment variables were changed.

## What was implemented

### Stack
- `i18next ^26`, `react-i18next ^17`, `i18next-browser-languagedetector ^8`
  (all installed via `npm install …`).
- Default language: **English (`en`)**.
- Supported locales: `en`, `sk`, `de`, `ru`, `ar`, `tr`.
- `ar` runs in RTL; everything else in LTR.

### New files
- `src/i18n/config.ts` — locale list, RTL list, BCP-47 normalizer, storage key.
- `src/i18n/index.ts` — `i18next` initialization (statically imports every JSON).
- `src/i18n/LanguageContext.tsx` — `<LanguageProvider>` + `useLanguage()` hook.
  Sets `<html lang>` / `<html dir>` whenever the locale changes.
- `src/i18n/LanguageSwitcher.tsx` — compact / labelled dropdown switcher.
- `src/i18n/formatters.ts` — `formatDate`, `formatDateTime`, `formatNumber`,
  `formatCurrency` based on `Intl.*` and the active locale.
- `src/i18n/enumLabel.ts` — `enumLabel(group, code)` helper (uses `enums` namespace).
- `src/i18n/locales/<locale>/{common,nav,auth,public,enums,errors}.json`
  — six locales × six namespaces = 36 JSON files. English fully populated;
  all other locales contain the same keys with native translations.

### Wiring
- `src/main.tsx` — imports `./i18n` once at startup so initialization runs
  before any component calls `useTranslation`.
- `src/app/App.tsx` — wraps the app in `<LanguageProvider>` next to
  `<ThemeProvider>` and `<AuthProvider>`.
- `index.html` — keeps `lang="en" dir="ltr"` only as a no-JS fallback;
  `LanguageProvider` rewrites both attributes on mount and on every change.
- `src/app/components/layout/Topbar.tsx` — `<LanguageSwitcher />` is mounted
  alongside the existing icon buttons; the static "Language: English" item
  was removed from the user dropdown.

### Pages translated in Phase 1
All ten public/auth pages now render via `useTranslation`:

- `LandingPage.tsx`
- `LoginPage.tsx`
- `ForgotPasswordPage.tsx`
- `ResetPasswordPage.tsx`
- `ActivationPage.tsx`
- `PublicEmployeeApplication.tsx` (header + button labels + toasts; the form
  itself comes from `ApplicantFormSteps` and is part of Phase 2)
- `ApplicationSuccess.tsx`
- `JobListings.tsx` (chrome, filters, pagination, salary/date formatting)
- `JobDetail.tsx` (chrome, breadcrumbs, salary/date formatting)
- `DataProcessingAgreement.tsx` (header, footer, language switcher; the long
  legal body is left in English by design — translations require legal review)

A `LanguageSwitcher` is also placed on each public/auth page (top-right).
Login, forgot, reset and activation use the labelled variant; the rest use
the compact variant.

### Persistence and detection
`i18next-browser-languagedetector` is configured with:

```ts
detection: {
  order: ['localStorage', 'navigator', 'htmlTag'],
  caches: ['localStorage'],
  lookupLocalStorage: 'tempworks.lang',
}
```

Picking a language from the switcher writes the BCP-47 code to
`localStorage['tempworks.lang']` and calls `i18n.changeLanguage(...)`. On
reload, the detector picks the persisted value first, then the browser
language, then falls back to `en`.

`config.normalizeLocale()` accepts BCP-47 tags (`en-US`), short codes
(`en`) and legacy free-text values (e.g. the existing `User.preferredLanguage`
strings such as `'English'` or `'German'`). Unknown values fall back to `en`.

## How to add a new translation key

1. Pick a namespace under `src/i18n/locales/<locale>/`.
2. Add the key to **all six** locale files for that namespace. English first;
   then `sk`, `de`, `ru`, `ar`, `tr`. Use plain values, or `{{var}}` for
   interpolation, or i18next plural suffixes (`key_one`, `key_other`, …) for
   counted strings.
3. In your component:

   ```tsx
   import { useTranslation } from 'react-i18next';

   export function MyComponent() {
     const { t } = useTranslation('common');
     return <h1>{t('actions.save')}</h1>;
   }
   ```

   Or with multiple namespaces and explicit prefix:

   ```tsx
   const { t } = useTranslation(['public', 'common']);
   t('public:landing.nav.home');
   t('common:actions.save');
   ```

4. For interpolation: `t('jobs.posted', { date: formatDate(value) })`.
5. For plurals: provide both `key_one` and `key_other` (and the additional
   suffixes required by some locales such as `_few`, `_many`, `_two`); call
   `t('key', { count: n })`.

## How to add a new language

1. Add the BCP-47 code to `SUPPORTED_LOCALES` and the labels in
   `src/i18n/config.ts` (both `LOCALE_LABELS` and `LOCALE_SHORT_LABELS`).
2. If the new language is RTL, add it to `RTL_LOCALES`.
3. Create `src/i18n/locales/<code>/` and copy the six namespace JSON files
   (`common, nav, auth, public, enums, errors`) from `en/` as a starting point.
4. In `src/i18n/index.ts`, add the imports and the corresponding entry in the
   `resources` object. The TypeScript compiler and the build will catch any
   missing entry.
5. (Optional) Update `LanguageSwitcher` if you want a flag override.

## How RTL is handled

- The `<html>` element's `dir` and `lang` attributes are written by
  `LanguageProvider` whenever the locale changes (`useEffect` on `locale`).
- Tailwind v4 ships first-class `rtl:` and `ltr:` variants and logical
  utilities. New code in Phase 1 prefers them — for example
  `start-3` instead of `left-3`, `ms-2` instead of `ml-2`,
  `text-end` instead of `text-right`. Direction-aware icons (chevrons, arrows)
  use `rtl:rotate-180`.
- Phase 1 does **not** convert the entire codebase. The conversion is done
  only in the public/auth pages we touched. Phase 2 will sweep the rest of
  the app as part of the dashboard translation work.
- No Tailwind plugin is required — Tailwind v4 covers everything we need.

## Date / number / currency formatting

Use the helpers from `src/i18n/formatters.ts`:

```ts
import { formatDate, formatNumber, formatCurrency } from '../../../i18n/formatters';

formatDate(job.publishedAt);             // 5 May 2026 in en, ٥ مايو ٢٠٢٦ in ar
formatNumber(1234.5);                    // 1,234.5 in en, 1.234,5 in de
formatCurrency(2500, 'EUR');             // €2,500.00 in en, 2.500,00 € in de
```

These all read the current language from the live `i18next` instance, so they
update automatically when the user switches language.

## Backend enum labels

Use `enumLabel('<group>', '<CODE>')` to display backend enum values:

```ts
import { enumLabel } from '../../../i18n/enumLabel';

enumLabel('documentStatus', 'PENDING');  // "Pending Review" in en
enumLabel('contractType',  'Full-time'); // "Vollzeit" in de
```

The codes themselves are unchanged — only their display labels are translated.
If a code has no label, the helper returns the raw code as a fallback.

## What remains for Phase 2

- Translate the dashboard chrome (`Sidebar`, `Topbar` user menu, dialogs).
- Translate generic UI under `components/ui/*` (confirm dialogs, pagination, toaster).
- Translate Dashboard widgets, common buttons, table headers, filter labels.
- Replace hardcoded `'en-US'` / `'USD'` formatting in the finance components
  with `formatCurrency` / `formatNumber`.
- Convert the rest of the directional Tailwind classes (`ml-*`, `mr-*`,
  `pl-*`, `pr-*`, `text-left`, `text-right`, `left-*`, `right-*`) to logical
  utilities.

Phases 3, 4 and 5 (feature modules, backend errors / emails / DB-driven
labels, full RTL polish) follow the roadmap in
`MULTI_LANGUAGE_IMPLEMENTATION_PLAN.md`.

## Local testing

1. `npm install` if you don't have the new dependencies yet.
2. `npm run dev` (Vite). The dev server prints a local URL.
3. Visit `/`, `/login`, `/forgot-password`, `/reset-password?token=…`,
   `/activate?token=…`, `/apply`, `/application-success`, `/jobs`,
   `/jobs/<slug>`, `/data-processing-agreement`.
4. Use the language switcher (top-right of every public page, and in the
   Topbar inside the dashboard). The page should re-render with translated
   copy and, for Arabic, flip to RTL.
5. Refresh the page — the chosen language persists via `localStorage`
   (`tempworks.lang`).
6. Build: `npm run build`. The Phase 1 build is verified to pass.
