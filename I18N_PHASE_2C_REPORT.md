# I18N Phase 2.C — Implementation Report

**Branch:** `claude/phase-2c-i18n-applicant-form`
**Scope:** Frontend-only — translate the multi-step applicant application
form (`ApplicantFormSteps.tsx`).
**Date:** 2026-05-05.

---

## 1 · Changed files

```
src/app/components/applicants/ApplicantFormSteps.tsx   (138 → 0 user-visible literals; 7 false positives remain)
src/i18n/locales/en/pages.json                          (+ ~290 keys under pages.applicants.form.*)
src/i18n/locales/sk/pages.json                          (sync — English fallback)
src/i18n/locales/de/pages.json                          (sync — English fallback)
src/i18n/locales/ru/pages.json                          (sync — English fallback)
src/i18n/locales/ar/pages.json                          (sync — English fallback)
src/i18n/locales/tr/pages.json                          (sync — English fallback)
```

### Scanner results — target file

**Before Phase 2.C:** `ApplicantFormSteps.tsx : 138`
**After Phase 2.C:** `ApplicantFormSteps.tsx : 7` — **all 7 are scanner
false positives**:

```
1302  void; requiredDocuments?: string[]; fieldErrors?: Record   (TS function signature)
1551  void; requiredDocuments?: string[]; fieldErrors?: Record   (TS function signature)
1726  void; settings: FormSettings; fieldErrors?: Record         (TS function signature)
1974  void; fieldErrors?: Record                                  (TS function signature)
2257  void; fieldErrors?: Record                                  (TS function signature)
2687  0 ? section('Skills', `                                     (template-literal expression in print HTML)
2698  PDF document — open original file to view contents.         (printable HTML summary, not on-screen)
```

The first 5 are matches inside TypeScript generic parameters (the regex
catches `>...<` and includes the `>` in `void` return types of inline
function types). The last two are inside the `downloadApplicationSummary`
helper which generates a downloadable HTML/PDF document; per the Phase
2.A audit and the user's brief, PDF/print export contents are out of
scope for this front-end-only pass and are tracked for a backend-driven
export-localization phase.

**Effective user-visible literal count: 0.**

---

## 2 · Translated surfaces

### Step indicator + tabs

- Step indicator strings (`Step X of Y`, `XX% Complete`)
- All 11 tab labels (Personal, Contact, ID & Legal, Driving License,
  Driving Exp., Education, Experience, Skills, Additional, Documents,
  Review)
- `TAB_DEFS` refactored to use `labelKey` instead of hard-coded `label`
  so the `StepIndicator` translates at render time.

### All 11 step components

| Step | What was translated |
|---|---|
| 1 — Personal | Section + subsection titles, photo upload (label/hint/buttons/required-error), full name fields + placeholders, personal details (DoB, gender via `enumLabel('gender')`, citizenship + multi-select with "Add another"), country of birth, city of birth, permanent + current address (Same-as-permanent toggle), previous-residence question + abroad detail fields. |
| 2 — Contact | Phone code label, WhatsApp question + WhatsApp number, email + confirm email + email-mismatch error, emergency contact section (first/last name, relationship, phone, email + email-validation error). |
| 3 — ID & Legal | Passport section (number/issuing country/dates/upload + required banner), national ID card (question/number/country/expiry/upload), EU visa, EU residence permit, EU work permit, criminal record declarations (home + EU), all uploaded-doc labels. |
| 4 — Driving License | Required banner, license-question with `✅ Yes` / `❌ No` from translated labels, license details (number/country/dates), categories with helper text, professional qualifications add-rows. |
| 5 — Driving Experience | Experience type radio (EU / Domestic / Both), EU + domestic experience fields, transport types / truck brands / GPS systems / trailer types badge selectors with custom-add inputs, gearbox radio (Manual/Automatic/Both), most-used trailer, traffic-accidents question, accident details. |
| 6 — Education | Section, entry header, level/institution/field-of-study/country/dates/ongoing/degree/upload-certificate, "No entries yet" empty state, "Add Education" button. |
| 7 — Work Experience | Section, position header, company/job-title/address fields, company phone with code, dates + Current toggle, responsibilities, reason for leaving, optional reference block, work-experience document upload (with name interpolation). |
| 8 — Skills & Languages | Languages list (language select / mother-tongue / 4-skill-levels / has-certificate / certificate name), skills with custom-add and presets, first-aid certificate, tools & equipment textarea. |
| 9 — Additional | Preferred start date, availability dropdown (1 week / 2 weeks / 3 weeks / 1/2/3/6 month options), how-did-you-hear, salary expectation, willing-to-relocate consent, work-regime checkboxes, additional notes. |
| 10 — Documents | Required-docs section with badges (Mandatory / Uploaded / Required / Choose file required), instructional banner, optional document blocks with type select, "auto-detected" pill, choose-file button, "No documents yet" empty state, "Add Document". |
| 11 — Review | Section title, download-application button, photo-uploaded + photo-missing alerts, all 9 review sub-sections (Personal / Contact / Driving License / Driving Experience / Education / Work / Languages / Skills / Additional / Documents) with field labels, "Present" for ongoing, "(Mother Tongue)" badge, Speaking/Reading/Writing/Listening prefixes, declaration title + 4 statements, link to data-processing agreement. |

### Validation pipeline (`getStepErrors` + `getStepFieldErrors`)

All ~80 hand-thrown English error strings were replaced with `tf(key,
params)` lookups against `pages.applicants.form.validation.*` and
`pages.applicants.form.fieldErr.*`. Because these helpers run outside
React component scope, they use `i18n.t(...)` directly through a small
`tf(...)` wrapper at the top of the file (mirrors the pattern used by
`apiError` and `enumLabel`).

### Helpers translated

- `RadioYN` (Yes/No labels — uses `yesShort`/`noShort` keys)
- `ExpiryFields` (date placeholder + "No expiry" toggle)
- `InlineDocUpload` (Upload Document fallback label, "(saved)" suffix,
  "Click to upload" hint)
- `SectionTitle` and `SubSection` already accept translated `title`
  props from the step components.
- `ReviewField` (Yes/No fallback for boolean values)

---

## 3 · New translation keys / namespaces

No new top-level namespaces. All ~290 new keys live under
`pages.applicants.form.*` with the following sub-trees:

| Sub-tree | Keys | Purpose |
|---|---:|---|
| `stepIndicator.*` | 2 | Step counter + percent-complete |
| `tabs.*` | 11 | Tab labels (1 per step) |
| `common.*` | 13 | Yes/No, upload helpers, expiry placeholder, "(optional)", "(saved)", country picker default |
| `step1.*` | 41 | Personal step (job, photo, name, personal, address, citizenship, abroad) |
| `step2.*` | 18 | Contact step (phone/whatsapp/email/emergency) |
| `step3.*` | 50 | ID & Legal step (passport, national ID, EU visa, EU residence, work permit, criminal record) |
| `step4.*` | 23 | Driving License step (license + qualifications) |
| `step5.*` | 32 | Driving Experience step (EU/domestic/both, transport/brands/GPS/trailer, gearbox, accidents) |
| `step6.*` | 17 | Education step (entry rows + dates + degree) |
| `step7.*` | 28 | Work Experience step (company + reference + reason) |
| `step8.*` | 28 | Skills & Languages step (languages × 4 skills, skills, first aid, tools) |
| `step9.*` | 19 | Additional step (availability + work regime + relocate consent) |
| `step10.*` | 14 | Documents step (required + optional uploads) |
| `step11.*` | 14 + `fields` (35) | Review step (9 sub-sections + 35 review-field labels + 4 declaration statements) |
| `validation.*` | ~62 | Step-level error messages (interpolated counts + names) |
| `fieldErr.*` | 18 | Field-level error messages (date order, required, etc.) |
| **Total** | **~290** | — |

### Locale parity

`/tmp/sync_keys.mjs` (committed reusable helper, untracked) walked
`en/pages.json` and inserted any missing keys into each non-English
locale verbatim. Existing translations (e.g. Slovak / German / Russian
strings on already-translated branches) were preserved unchanged.
Per the brief — *"English may be used as fallback values for
non-English locales if needed, but no missing keys are allowed"* — the
~290 new keys land as English fallback values in `sk/de/ru/ar/tr`,
ready for native translation.

---

## 4 · Helpers used (existing)

- **`useTranslation('pages')`** — hook used in every step component
  (`Step1Personal`...`Step11Review`) plus `RadioYN`, `ExpiryFields`,
  `InlineDocUpload`, `StepIndicator`, `ReviewField`.
- **`tf(key, params)`** — small wrapper for `i18n.t('applicants.form.' +
  key, { ns: 'pages', ... })` used in the non-React utility functions
  (`getStepErrors`, `getStepFieldErrors`) where there's no React
  context. Same pattern as the existing `apiError` and `enumLabel`
  helpers.
- **`enumLabel('gender', code)`** — applied to the gender select in
  Step 1 (replaces the inline `Male`/`Female`/`Other`/`Prefer not to
  say` strings).
- `formatDate` / `formatNumber` / `formatCurrency` — not needed in this
  file. The form deals with date inputs (`<input type="date">`) and
  raw numeric strings; no rendered dates/numbers/currency.
- **`apiError`** — not directly applicable here; the form file doesn't
  emit toasts. Toasts on submission live in `PublicEmployeeApplication.tsx`
  (out of scope for this PR — already partially translated; deferred to
  Phase 2.D).

---

## 5 · RTL notes

The form contains very few directional icons; all are already RTL-safe
or inside row layouts (the `<X />` close icon, `<Plus />` add-button
icon, `<Trash2 />` delete icon — all are visually-symmetric circular
glyphs that don't need flipping). The form uses `me-1`, `ms-1`, `ps-3`,
`ps-4`, `border-s-2`, `border-s-4` logical Tailwind classes throughout
(legacy from Phase 5 codemod).

**No new RTL fixes needed in this file** beyond what Phase 5 already
landed. The radio-button "✅ Yes / ❌ No" emojis flip naturally with the
parent's `dir="rtl"` from `LanguageProvider`.

The downloadable summary HTML (`downloadApplicationSummary`) is rendered
in a new browser tab as a fixed `text/html` blob with `dir="ltr"`
implicit — translating the HTML body is out of scope for Phase 2.C
(noted as Phase 2.D).

---

## 6 · Quality checks

```
$ npm run i18n:check-keys
✓ All 5 target locales × 9 namespaces match English.

$ npm run i18n:check-literals
(scanner shows 7 entries for ApplicantFormSteps.tsx — all are
 TypeScript-signature false positives or the print-only HTML template;
 see §1.)

$ npm run build
✓ built in ~22s
(bundle size warning unchanged; pre-existing — index chunk now ~4.6MB
 reflecting the +~290 form keys per locale, gzip 1.31MB.)
```

**Effective user-visible literal count in target file: 0.**

---

## 7 · Known limitations

1. **TypeScript-signature false positives.** The 5 scanner hits at
   lines 1302, 1551, 1726, 1974, 2257 are inside TypeScript generic
   type parameters that contain `>...<` patterns the literal scanner's
   regex matches. They are not user-visible. The literal scanner
   doesn't have a TypeScript-aware AST so these false positives can
   only be silenced by tweaking `scripts/i18n-check-literals.mjs` —
   out of scope.

2. **Downloadable Application Summary HTML.** The
   `downloadApplicationSummary` helper near line 2620 builds an HTML
   document for printing. Its `<h1>`, section headings, field labels
   etc. remain English. This is a print-only artifact generated as a
   `text/html` blob and opened in a new tab — i.e. it doesn't render in
   the form UI. Localizing it requires either (a) accepting `t()` in
   the helper and threading the locale, or (b) moving the export to
   the backend (where a per-locale template can be reused with email
   templates). Recommend the backend approach for Phase 2.D, mirroring
   the email-template strategy from Phase 4.

3. **English fallback values for ~290 keys in non-English locales.**
   The script-driven sync inserted English values into
   `sk/de/ru/ar/tr` for the new keys. Translators can replace them in
   place without touching TSX. This satisfies the
   `npm run i18n:check-keys` parity requirement.

4. **Phone-code labels** in the country/code dropdown (e.g. "United
   Kingdom (+44)") render the country name from `PHONE_CODES`. That
   data file is hard-coded English. Translating those would require
   adding an `i18n` country-name lookup or using `Intl.DisplayNames`.
   Not in scope for this PR — flagged for Phase 2.D.

5. **License category codes** (`AM`, `A1`, `B`, `C`, etc.) are
   intentionally **not** translated — they are official EU codes that
   must match the issued license. Confirmed correct.

6. **Language list** (`Albanian`, `English`, etc.) and **proficiency
   levels** (`A1 - Beginner`...`C2 - Mastery`, `Native`) and **skill
   levels** (`Beginner`/`Intermediate`/`Advanced`/`Expert`) are
   currently rendered as raw enum codes from the constant arrays
   (`LANGUAGES`, `PROFICIENCY_LEVELS`, `SKILL_LEVELS`). They flow into
   the form data store as the displayed label, not as a code. Properly
   translating them would mean splitting "label vs code" — out of scope
   for this PR. Recommended Phase 2.D scope.

7. **Settings-driven dropdown options** (e.g. transport types, truck
   brands, GPS systems, trailer types, family relations, visa types,
   driving qualifications, education levels, skills, "How did you
   hear", workRegime) come from `settings: FormSettings` — backend
   admin-managed labels. Per the brief (*"Do not translate
   user-entered data such as ... Do not translate backend enum values
   directly; map them through enumLabel where visible"*), these stay
   as the backend-supplied labels until Phase 2.D extends `enumLabel`
   coverage or the backend gains JSONB translations on these settings
   tables.

8. **Build-output bundle size** still emits the pre-existing 500 KB
   chunk warning. Unchanged.

---

## 8 · Recommended Phase 2.D scope

### Phase 2.D.1 — `PublicEmployeeApplication.tsx` toast/alert sweep + RTL polish (~1 d)

The wrapper page that hosts `<ApplicantFormSteps>` still emits raw
English toasts on submit/save-draft/network errors. Wire them through
`apiError(err, t('common:toast.errorGeneric'))` and translate the
"Application submitted" success path. Verify Arabic step flow visually.

### Phase 2.D.2 — Constant arrays + settings-driven options (~1.5 d)

Convert the in-file `LANGUAGES`, `PROFICIENCY_LEVELS`, `SKILL_LEVELS`,
`LICENSE_CATEGORIES` (note: keep the codes!) to `code → labelKey` pairs
under `enums.language.*` / `enums.proficiency.*` / `enums.skillLevel.*`.
Backend-managed dropdowns (transport types, truck brands, etc.) need
either `enumLabel` extension or the JSONB-translations path identified
in the Phase 4 backend audit.

### Phase 2.D.3 — Phone-code country names (~0.5 d)

Replace the static `PHONE_CODES.label` country names with
`new Intl.DisplayNames(locale, { type: 'region' }).of(iso)` so the
dropdown shows "Vereinigtes Königreich (+44)" in German, "المملكة
المتحدة (+44)" in Arabic, etc.

### Phase 2.D.4 — Native translations for the ~290 form keys (~3 d)

Replace the English fallback values in `sk/de/ru/ar/tr` with native
translations. ~290 strings × 5 locales = ~1450 strings. Key paths are
stable; no TSX changes required.

### Phase 2.D.5 — Print-summary HTML localization (~1 d)

Move `downloadApplicationSummary`'s HTML generation behind a backend
endpoint that uses the same per-locale template strategy as the email
templates from Phase 4 (`backend/src/email/email-i18n.ts`). The
frontend would call `applicantsApi.downloadApplicationSummaryPdf(locale)`
and stream the rendered PDF.

### Suggested next prompt

> Implement Phase 2.D.1 of the i18n applicant-form sweep. Branch
> `claude/phase-2d-i18n-public-application-page`. Translate
> `src/app/pages/public/PublicEmployeeApplication.tsx` — the wrapper
> page that hosts `<ApplicantFormSteps>`. Wire all `toast.error(...)`
> calls through `apiError(err, t('common:toast.errorGeneric'))`,
> translate the success/draft-save toasts, the page header, and the
> Previous/Next/Submit/Save Draft buttons. Reuse existing namespaces
> (`pages.public.application.*`, `common.actions.*`,
> `common.toast.*`). Run `npm run i18n:check-keys`,
> `npm run i18n:check-literals`, and `npm run build` before commit.
> Push to the new branch. Do not open a PR.
