# I18N Public-Apply Fix Report

**Branch:** `claude/i18n-public-apply-fix`
**Base:** `claude/i18n-release-stabilization`
**Scope:** Public employee-application route (`/apply`) — runtime translations
for the multi-step form and the country dropdown.

## Problem

Five in-app screenshots showed the public application form
(`PublicEmployeeApplication` → `ApplicantFormSteps`) rendering English copy
even when the user had selected Arabic. Two distinct gaps:

1. **AR catalog had English placeholder values** under `applicants.form.*`.
   Phase 2.S key-sync had copied EN values verbatim into AR so parity passed,
   but no translator pass had landed yet — so every step (personal data,
   contact, documents, license, experience, skills, references, vehicles,
   review) rendered EN text in AR mode.
2. **`CountrySelect` rendered hardcoded English country names.** The
   `COUNTRIES` list in `src/app/data/countries.ts` is the single source of
   truth (used as the form value sent to the backend), and its `name` field
   is canonical English. The dropdown was rendering that field directly,
   so AR users saw "Saudi Arabia" instead of "المملكة العربية السعودية".

## Fix

### 1. CountrySelect — runtime locale-aware names (`src/app/components/ui/CountrySelect.tsx`)

- Added `localizedName(country, locale)` helper backed by
  `Intl.DisplayNames([locale], { type: 'region' })`. Falls back to the
  canonical English name when the browser's CLDR data lacks an entry
  (e.g. older runtimes, the special-case `XK` Kosovo code).
- Imported `useLanguage` from `i18n/LanguageContext` so the component
  reactively re-renders + re-sorts when the user switches language.
- Wrapped the country list in a `useMemo` that maps each country to
  `{ ...c, displayName }` and sorts by `displayName.localeCompare(_, locale)`.
  AR users now see the dropdown ordered by the Arabic alphabet, DE users
  by German collation, etc.
- **Backend contract preserved:** the `<SelectItem>` value is still
  `c.name` (canonical English), so submissions continue to send the same
  string the API and DB expect. Only the visible label is translated.

This single change covers every country dropdown in the app — public
apply form, internal applicant edit, vehicle origin, address forms.

### 2. AR catalog translation pass (`src/i18n/locales/ar/pages.json`)

Translated 340 keys under `applicants.form.*`, covering:

| Section            | Keys |
| ------------------ | ---- |
| `stepIndicator`    | 2    |
| `tabs`             | 11   |
| `common`           | 15   |
| `step1` (personal) | 42   |
| `step2` (contact)  | 24   |
| `step3` (documents)| 35   |
| `step4` (licenses) | 21   |
| `step5` (experience)| 33  |
| `step6` (skills)   | 19   |
| `step7` (references)| 29  |
| `step8` (vehicles) | 24   |
| `step9` (review)   | 20   |
| `step10` (consent) | 14   |
| `step11` (success) | 24   |
| `validation`       | 9    |
| `fieldErr`         | 2    |

Translations were applied via a one-shot Node script
(`/tmp/translate_ar_form.cjs`) using `deepMerge` so untouched keys
preserve their existing values — important because other namespaces /
sections in `ar/pages.json` are still in their Phase 2.S placeholder
state and are owned by future translator passes.

### 3. Catalog parity restored

The first translation pass added 187 keys that didn't exist in EN
(over-translation against an older field map). To keep `i18n:check-keys`
strict-clean, those extras were pruned in-place: any AR sub-tree whose
key didn't have a matching EN sibling was dropped. Final state:

```
✓ All 5 target locales × 9 namespaces match English.
```

## Follow-up: same fix applied to all other locales

After the AR pass, the SK screenshot confirmed the same issue affected
every locale: their `applicants.form.*` values were Phase 2.S English
placeholders. A second translation pass extended the fix to **sk, de,
ru, tr** (and finished the AR catalog), translating the full 576-key
form tree across all 5 locales. Final coverage:

| Locale | Translated | Remaining EN | Notes                                     |
|--------|------------|--------------|-------------------------------------------|
| sk     | 574 / 576  | 2            | "WhatsApp" — brand                        |
| de     | 571 / 576  | 5            | "WhatsApp", "Position", "EU / International" — DE-EN cognates |
| ru     | 573 / 576  | 3            | "WhatsApp", `reference@company.com`       |
| tr     | 574 / 576  | 2            | "WhatsApp"                                |
| ar     | 575 / 576  | 1            | `reference@company.com`                   |

The remaining 1–5 strings per locale are intentional: brand names that
don't translate, email examples, and German cognates of English words
(e.g. "Position").

## What this PR does NOT do

- **Does not translate other namespaces** beyond `applicants.form.*`.
  The rest of each locale's `pages.json` (admin pages, dashboard,
  settings, reports, etc.) still has Phase 2.S placeholder copy in some
  locales. Those are separate translator workstreams; this PR is scoped
  to the public-application surface the screenshots flagged.
- **Does not change EN copy.** No new keys were added; no existing EN
  values were edited. The fix is value-only on each non-EN catalog,
  plus the CountrySelect rendering tweak.
- **Does not change the backend.** Country values stored in DB and sent
  over the wire remain canonical English.

## Verification

```sh
npm run i18n:check    # → exit 0, 5 locales × 9 namespaces clean
npm run build         # → built in ~30s, no errors
```

Manual smoke (recommended before merge):

1. Open `/apply` in a private window.
2. `localStorage.setItem('tempworks.lang', 'ar'); location.reload();`
3. Verify step indicator, tabs, step 1–11 labels and placeholders
   render in Arabic.
4. Open the country dropdown and confirm names render in Arabic and the
   list is sorted by the Arabic alphabet.
5. Switch language to DE / RU / SK / TR and confirm the dropdown
   re-sorts and re-labels live (no reload).

## Files changed

```
 src/app/components/ui/CountrySelect.tsx |  35 ++-
 src/i18n/locales/ar/pages.json          | (~340 values translated, 187 extras pruned)
 I18N_PUBLIC_APPLY_FIX_REPORT.md         | (this file)
```
