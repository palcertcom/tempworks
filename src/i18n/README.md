# Frontend i18n — translator handoff guide

This directory contains everything needed to add, edit, or commission
translations for TempWorks. English is the source of truth; the other
five locales are translated against it.

## Structure

```
src/i18n/
├── config.ts                 # supported locales, RTL list, label maps
├── index.ts                  # i18next init, lazy backend, pseudo locale
├── LanguageContext.tsx       # <LanguageProvider> + useLanguage()
├── LanguageSwitcher.tsx      # dropdown switcher (incl. dev pseudo)
├── formatters.ts             # locale-aware date / number / currency helpers
├── enumLabel.ts              # backend enum code → translated label helper
├── apiError.ts               # backend error code → translated message helper
├── pseudo.ts                 # pseudo-localization wrapper
├── README.md                 # this file
└── locales/
    ├── en/   ← source of truth
    ├── sk/
    ├── de/
    ├── ru/
    ├── ar/   ← RTL
    └── tr/
```

## Supported locales

| Code | Language    | Native name   | Direction |
|------|-------------|---------------|-----------|
| `en` | English     | English       | LTR       |
| `sk` | Slovak      | Slovenčina    | LTR       |
| `de` | German      | Deutsch       | LTR       |
| `ru` | Russian     | Русский       | LTR       |
| `ar` | Arabic      | العربية       | **RTL**   |
| `tr` | Turkish     | Türkçe        | LTR       |

Plus a hidden `pseudo` locale, only available in development. It wraps
every translation in `[!! … !!]` and accents Latin letters, so untranslated
hardcoded strings stand out and layout truncation becomes visible.

## Namespaces

Each locale folder contains one JSON file per namespace:

| File             | Scope                                                      |
|------------------|------------------------------------------------------------|
| `common.json`    | Generic actions (Save, Cancel, …), states, branding helpers |
| `nav.json`       | Sidebar / Topbar / ChangePassword dialog                   |
| `auth.json`      | Login, 2FA, forgot/reset/activation flows                  |
| `public.json`    | Landing, Job Listings, public application form, DPA chrome |
| `dashboard.json` | Dashboard index page (KPIs, workflow widgets, etc.)        |
| `pages.json`     | All other dashboard feature pages (chrome / titles / Add)  |
| `ui.json`        | Shared UI primitives (ConfirmDialog, AddressForm, …)       |
| `enums.json`     | Backend status / category code → user label                |
| `errors.json`    | Backend `code` → user-facing message                       |

## Editing translations

1. Open the file for your locale + namespace, e.g. `locales/de/auth.json`.
2. Edit only **the values**. Keep the keys identical to English. Don't
   remove keys — set them to an empty string only if intentionally blank.
3. Preserve interpolation tokens exactly: `{{name}}`, `{{count}}`,
   `{{minutes}}`, etc. Where they appear is also where the translated
   text needs them.
4. CLDR plural suffixes are allowed for languages that need them. For
   example Russian needs `_one`, `_few`, `_many`, `_other` while English
   only carries `_one` and `_other`. The key-parity check (below) treats
   plural suffixes as variants of the base key, so adding extras for a
   locale doesn't fail the check.
5. Run the parity check from the repo root:

   ```sh
   npm run i18n:check-keys
   ```

   This confirms every key in `en/<ns>.json` exists in the target locale
   (modulo plural variants).

## Adding a new translation key

1. Add the key + English value to the appropriate `en/<ns>.json`.
2. Add the same key (with a translation) to **every** other locale.
3. In the component, call `t('key.path')` from the matching namespace:

   ```tsx
   import { useTranslation } from 'react-i18next';

   const { t } = useTranslation('auth');
   t('login.title');
   ```

   For interpolation: `t('jobs.posted', { date: formatDate(value) })`.
   For plurals: provide `key_one` and `key_other` (and the additional
   suffixes other locales need); call `t('key', { count: n })`.

4. Run `npm run i18n:check-keys` to confirm parity.

## Adding a new language

1. Add the BCP-47 code to `SUPPORTED_LOCALES` and the labels in
   `src/i18n/config.ts` (`LOCALE_LABELS`, `LOCALE_SHORT_LABELS`,
   `LOCALE_FLAGS`).
2. If RTL, add it to `RTL_LOCALES`.
3. Create `src/i18n/locales/<code>/` and copy each `.json` namespace file
   from `en/` as a starting point. Translate all values.
4. Update `src/app/components/ui/calendar.tsx` to map the new code to
   the matching `date-fns/locale` import.
5. Run `npm run i18n:check-keys`. The new locale must pass.

## Pseudo-localization (developers only)

Open the language switcher (top-right of every page) — in **development
builds** only, you'll see a "Pseudo (dev)" entry below the real
locales. Selecting it wraps every translated string in `[!! … !!]` and
accents the Latin letters. Anything still appearing without brackets
is a hardcoded string that needs to be wrapped in `t(...)`.

## Lazy loading

Only English is bundled into the initial JS chunk. The other locales'
JSON files are loaded on demand the first time the user switches to
them — Vite generates one chunk per `(locale, namespace)` pair. The
fallback chain is: requested locale → English → key.

## Hardcoded literal scanner

Run a heuristic scan for English text that should be translated:

```sh
npm run i18n:check-literals
# or, to fail CI on any hit:
STRICT=1 npm run i18n:check-literals
```

The scanner is heuristic (false positives are normal). Wrap genuine
user-visible strings in `t(...)` or add `/* eslint-disable i18n */` at
the top of the file to silence it for that file.

## Commissioning a translator

When sending the locale folder out for translation:

1. Zip the target locale's folder, e.g. `locales/de/`, **and** include
   `locales/en/` as the source reference.
2. Tell the translator:
   - Edit only the values, not the keys.
   - Preserve `{{tokens}}` exactly where they appear.
   - Plural suffixes (`_zero`, `_few`, `_many`, …) follow CLDR rules for
     the target language.
   - The string `TempWorks` is the brand and should stay untranslated.
   - Leave HTML-like tokens (`<bdi>`, `<strong>`, …) intact when present.
3. When the translation comes back, drop the files into the locale
   folder, run `npm run i18n:check-keys`, and visually verify the
   touched pages by switching the language in the app.

## Backend codes

Backend exceptions emit `{ code, message, params }` — the frontend
resolves them via `errors.json`. Codes are upper-snake under a group:
`AUTH.INVALID_CREDENTIALS`, `GENERIC.UNIQUE_VIOLATION`, etc.

Backend enums (status, category, …) emit stable upper-snake codes;
the frontend renders them via `enumLabel('group', 'CODE')` reading
`enums.json`.

Don't add codes here without also adding the corresponding entry to the
backend (`backend/src/auth/auth.service.ts` etc.) — and vice versa.
