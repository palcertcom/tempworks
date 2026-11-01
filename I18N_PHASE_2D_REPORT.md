# I18N Phase 2.D — Implementation Report

**Branch:** `claude/phase-2d-i18n-applicant-flow-polish`
**Scope:** Frontend-only — finish remaining public-applicant-flow i18n
gaps around `ApplicantFormSteps` (constant arrays, phone-code country
names, downloadable summary HTML, `PublicEmployeeApplication.tsx`
toast polish).
**Date:** 2026-05-05.

---

## 1 · Changed files

```
src/i18n/formatters.ts                                    (+ countryName helper)
src/i18n/locales/en/enums.json                            (+ language / proficiency / skillLevel)
src/i18n/locales/en/pages.json                            (+ ~70 keys under pages.applicants.form.step11.summary.*)
src/i18n/locales/sk/{enums,pages}.json                    (sync — English fallback)
src/i18n/locales/de/{enums,pages}.json                    (sync — English fallback)
src/i18n/locales/ru/{enums,pages}.json                    (sync — English fallback)
src/i18n/locales/ar/{enums,pages}.json                    (sync — English fallback)
src/i18n/locales/tr/{enums,pages}.json                    (sync — English fallback)
src/app/components/applicants/ApplicantFormSteps.tsx      (LANGUAGES/PROFICIENCY_LEVELS/SKILL_LEVELS,
                                                           phone-code country names,
                                                           downloadApplicationSummary HTML)
src/app/components/ui/PhoneInput.tsx                       (phone-code country names)
src/app/pages/public/PublicEmployeeApplication.tsx         (apiError polish on submitFailed toast)
```

### Per-file residual literal scan

```
src/app/pages/public/PublicEmployeeApplication.tsx : 0
src/app/components/ui/PhoneInput.tsx               : 0
src/app/components/applicants/ApplicantFormSteps.tsx : 6  (all scanner false positives)
```

The 6 remaining hits in `ApplicantFormSteps.tsx`:

```
1304  void; requiredDocuments?: string[]; fieldErrors?: Record   (TS function signature)
1553  void; requiredDocuments?: string[]; fieldErrors?: Record   (TS function signature)
1728  void; settings: FormSettings; fieldErrors?: Record         (TS function signature)
1976  void; fieldErrors?: Record                                  (TS function signature)
2259  void; fieldErrors?: Record                                  (TS function signature)
2698  0 ? section(S('skillsSection'), `                           (template-literal expression)
```

Five are TypeScript generic-type signatures that match the scanner's
`>...<` regex; the sixth is a JS expression inside a template literal
(it's just code, not a string). Carried over from Phase 2.C — not
fixable without an AST-aware scanner.

**Effective user-visible literal count in target files: 0.**
The previous Phase 2.C "1 print-only HTML fragment" entry is now also
gone — the print summary is fully localized in this phase.

---

## 2 · `PublicEmployeeApplication.tsx` toast/UI sweep

The file was inspected and is already fully translated against
`useTranslation('public')` keys (`apply.headerTitle`, `apply.back`,
`apply.next`, `apply.submit`, `apply.submitting`, `apply.captchaTitle`,
`apply.errors.*`). The chevron icons already use `rtl:rotate-180`.
The only polish opportunity was a single submit-error toast that read
the raw backend message:

```diff
-toast.error(err?.message || t('apply.errors.submitFailed'));
+toast.error(apiError(err, t('apply.errors.submitFailed')));
```

`apiError(err, fallback)` looks up `err.code` (e.g.
`AUTH.INVALID_CREDENTIALS`) in the `errors` namespace, falls back to
the backend's English `message`, and finally to the localized fallback.
This is the consistent pattern used elsewhere in the codebase.

**No other literals or untranslated UI in this file** — Phase 2.D
sub-task 1 closes with a single one-line change.

---

## 3 · Constant-array translations

The displayed-label arrays in `ApplicantFormSteps.tsx` are now
translated through `enumLabel(group, code)` while their stored values
remain unchanged (so backend submissions and existing draft records are
not affected — only the displayed text is localized).

### New `enums.*` sub-trees

| Sub-tree | Keys | Source array |
|---|---:|---|
| `enums.language.*` | 37 | `LANGUAGES` (Albanian, Arabic, Bosnian, …, Other) |
| `enums.proficiency.*` | 7 | `PROFICIENCY_LEVELS` (A1 - Beginner … C2 - Mastery, Native) |
| `enums.skillLevel.*` | 4 | `SKILL_LEVELS` (Beginner, Intermediate, Advanced, Expert) |
| **Total new enum keys** | **48** | — |

The keys use the existing English value as both key and (English) label,
matching the precedent set by `enums.contractType` in the same file.

### Refactored Selects + Review labels

```tsx
// Step 8 – language select (value preserved as English code/label):
{LANGUAGES.map(l => <SelectItem key={l} value={l}>{enumLabel('language', l)}</SelectItem>)}
{PROFICIENCY_LEVELS.map(l => <SelectItem key={l} value={l}>{enumLabel('proficiency', l)}</SelectItem>)}
{SKILL_LEVELS.map(l => <SelectItem key={l} value={l}>{enumLabel('skillLevel', l)}</SelectItem>)}

// Step 11 – review block:
{enumLabel('language', l.language) || l.language}
{enumLabel('proficiency', l.speakingLevel) || '—'}    // and reading/writing/listening
{enumLabel('skillLevel', s.level) || s.level}
```

`LICENSE_CATEGORIES` (`AM`, `A1`, `B`, `C`, …) stays untranslated by
design — they are official EU codes that must match exactly the
displayed code on the issued license, per EU Directive 2006/126/EC.

The gearbox radio (`Manual`/`Automatic`/`Both`) was already covered in
Phase 2.C through `applicants.form.step5.gearbox{Manual,Automatic,Both}`
keys, so no change here.

Settings-driven dropdowns (`settings.transportTypes`, `truckBrands`,
`gpsSystems`, `trailerTypes`, `educationLevels`, `skills`, etc.) remain
backend-supplied. Per the original brief — "*Do not translate
backend enum values directly; map them through `enumLabel` where
visible*" — these stay as-is until the JSONB-translations path is
delivered for the corresponding backend tables.

---

## 4 · Phone-code country names — `Intl.DisplayNames`

### New helper — `src/i18n/formatters.ts`

```ts
export function countryName(
  iso: string | null | undefined,
  fallback?: string,
): string {
  if (!iso) return fallback ?? '';
  const code = iso.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return fallback ?? iso;
  try {
    const dn = new Intl.DisplayNames([intlLocale()], { type: 'region' });
    const name = dn.of(code);
    return name && name !== code ? name : (fallback ?? code);
  } catch {
    return fallback ?? code;
  }
}
```

### Applied to all 5 phone-code dropdowns

| Component | Drop-downs | Display |
|---|---|---|
| `ApplicantFormSteps.tsx` | Phone (Step 2), WhatsApp (Step 2), Emergency Phone (Step 2), Company Phone (Step 7), Reference Phone (Step 7) | `{countryName(c.iso, c.label)} ({c.code})` |
| `PhoneInput.tsx` | Generic `<PhoneInput>` (used across all admin/staff phone fields) | `{countryName(c.iso, c.label)}` |

Visible result per locale (United Kingdom / +44):

| Locale | Renders as |
|---|---|
| en | "United Kingdom (+44)" |
| de | "Vereinigtes Königreich (+44)" |
| sk | "Spojené kráľovstvo (+44)" |
| ru | "Великобритания (+44)" |
| ar | "المملكة المتحدة (+44)" |
| tr | "Birleşik Krallık (+44)" |

`Intl.DisplayNames` is a built-in browser API (Chrome 81+, Firefox 86+,
Safari 14.1+) — no extra polyfill needed for the supported browser
matrix. The `iso` field was already present on every `PHONE_CODES`
entry, so no data-file changes were required. The static
`PhoneCode.label` is now used only as a fallback when the runtime
fails to resolve a region (rare; e.g. Kosovo `XK` on older Safari).

---

## 5 · Print/Download summary HTML

### Decision: localize on the frontend (this phase)

After inspection `downloadApplicationSummary` is a pure-frontend helper
(builds an HTML string → `Blob` URL → opens in new tab). No backend
involvement, no ratelimit risk, no PII leak surface beyond what the
form already gathers. Threading translations through it is a self-
contained refactor, so it was done in this phase rather than deferred
to a backend phase.

### Refactor

```ts
async function downloadApplicationSummary(d, uploadedFiles) {
  const S = (k) => tf(`step11.summary.${k}`);
  const yesNo = (v) => /* boolean / 'yes' / 'no' → t(yes|no) */;
  const field = (label, value) => /* … uses S('yes')/S('no') for booleans */;
  const dir  = i18n.dir();
  const lang = i18n.resolvedLanguage ?? 'en';
  const html = `<!DOCTYPE html><html lang="${lang}" dir="${dir}">…
<title>${S('title')}</title>…
<h1>${S('title')}</h1>
<p class="ref">${S('submittedBy')}: …</p>
${section(S('personalSection'), `…${field(S('firstName'), …)}…`)}
${section(S('contactSection'), …)}
${d.hasDrivingLicense === 'yes' ? section(S('drivingLicenseSection'), …) : ''}
…
${d.languages.length > 0 ? section(S('languagesSection'),
  d.languages.map(l => `…${enumLabel('language', l.language)}…
    ${field(S('speaking'),  enumLabel('proficiency', l.speakingLevel))}…`)) : ''}
${d.skills.length > 0 ? section(S('skillsSection'),
  `…${field(s.skill, enumLabel('skillLevel', s.level) || '—')}…`) : ''}
…
`;
}
```

### Keys added — `pages.applicants.form.step11.summary.*` (~70)

- Section titles (10): `personalSection`, `contactSection`, `drivingLicenseSection`,
  `drivingExpSection`, `educationSection`, `workSection`,
  `languagesSection`, `skillsSection`, `additionalSection`,
  `documentsSection`.
- Field labels (50): name parts, dates, gender, citizenship, addresses,
  email/phone/whatsapp, license fields, driving experience, education,
  work history, languages, additional info, documents.
- Misc (10): `title`, `submittedBy`, `pdfNote`, `sameAsPhone`,
  `noExpiry`, `present`, `degree`, `position`, `motherTongue`,
  `documentDefault`, `yes`, `no`.

The HTML root now also emits `<html lang dir>` matching the user's
active locale, so the new tab inherits Arabic RTL correctly.

`Yes`/`No` for booleans in the summary go through the `yesNo()` helper
which calls `S('yes')` / `S('no')`. Languages / proficiency / skill
levels go through `enumLabel`.

---

## 6 · Native-translation preparation

`scripts/i18n-check-keys.mjs` enforces strict parity. The
`/tmp/sync_keys.mjs` helper (untracked) walked every namespace in
`en/` and inserted missing keys into each non-English locale verbatim,
preserving existing translations and dropping stale-only keys.

### Keys added in this phase that need native translation

| File | Path | Count | Notes |
|---|---|---:|---|
| `enums.json` | `language.*` | 37 | Language names. Many are already cognates — sk/de/ru/tr translators can replace where needed. |
| `enums.json` | `proficiency.*` | 7 | CEFR labels — the codes (A1, B2, etc.) are universal; only the descriptor needs translation. |
| `enums.json` | `skillLevel.*` | 4 | Beginner/Intermediate/Advanced/Expert. |
| `pages.json` | `applicants.form.step11.summary.*` | ~70 | Print-summary labels (Section titles + field labels). |

Total ~118 net new keys × 5 locales = ~590 strings awaiting native
translation. All key paths are stable.

### Already-natively-translated keys preserved

The sync script's deep-merge preserved every existing translated
string in `sk/de/ru/ar/tr` for already-translated key paths
(verified by re-running `i18n:check-keys` after sync). Only missing
keys received English fallback values.

---

## 7 · RTL polish

Touched in this flow:

1. **Print summary HTML** — now emits `<html lang="ar" dir="rtl">` when
   the user has Arabic active, so the new tab renders RTL correctly
   without manual styling.
2. **`PhoneInput` flag — `<img alt="">`** removed (was `alt={c.iso}`,
   then changed to `""` in an earlier phase). No regression in this
   phase — left as-is.

No new directional icons were added in this phase. Existing chevrons
in `PublicEmployeeApplication.tsx` already use `rtl:rotate-180`.

---

## 8 · Quality checks

```
$ npm run i18n:check-keys
✓ All 5 target locales × 9 namespaces match English.

$ npm run i18n:check-literals
(target files clean: PublicEmployeeApplication.tsx 0,
 PhoneInput.tsx 0, ApplicantFormSteps.tsx 6 = all scanner false
 positives — see §1.)

$ npm run build
✓ built in ~13s
(bundle size warning unchanged; pre-existing.
 Index chunk now 4.60 MB, gzip 1.31 MB — consistent with the
 +~118 enum/summary keys per locale.)
```

---

## 9 · Known limitations

1. **CLDR plural variants for `_zero/_two/_few/_many`.** None of the
   ~118 newly added keys interpolate `{{count}}`, so this isn't an
   issue for this phase. Pre-existing keys flagged in earlier phases
   still wait for plural variant pass.

2. **`Intl.DisplayNames` for unrecognized regions.** A handful of
   ISO codes (Kosovo `XK`, Vatican `VA`) may return the same string as
   the input on older browsers. The `countryName(iso, fallback)`
   helper falls back to the static English label in `phoneCodes.ts`
   for that case.

3. **`PROFICIENCY_LEVELS` codes contain ` - `.** The English keys are
   `"A1 - Beginner"`, `"A2 - Elementary"`, etc. These are valid JSON
   keys and i18next handles them correctly with the default
   `keySeparator: '.'`. Translators should preserve the `A1 -` prefix
   in the localized label or split into a dedicated CEFR label
   sub-tree later.

4. **Settings-driven dropdowns** still defer to backend-supplied
   labels (transport types, truck brands, GPS systems, trailer types,
   skills, education levels, family relations, visa types, driving
   qualifications, "How did you hear" options, work regime). Per the
   brief these need either `enumLabel`-extension or backend JSONB
   translations — Phase 2.E.

5. **Stored values stay English.** The applicant form continues to
   submit `"Albanian"`, `"A1 - Beginner"`, `"Beginner"`, etc. as the
   backend value (via the `value` attribute on `<SelectItem>`). This
   is intentional: it keeps the database stable across locale switches
   and avoids a data migration. Only the displayed label localizes.

6. **English fallback values for ~118 new keys in non-English
   locales.** The script-driven sync inserted English values into
   `sk/de/ru/ar/tr` for the new keys. Translators can replace them in
   place without touching TSX. This satisfies
   `npm run i18n:check-keys` parity.

7. **Build-output bundle size** still emits the pre-existing 500 KB
   chunk warning. Unchanged.

---

## 10 · Recommended Phase 2.E scope

### Phase 2.E.1 — Settings-driven dropdown translation (~2 d)

Extend `enumLabel` (or add a new `settingsLabel(group, code, fallback)`
helper) to look up translations for `transportTypes`, `truckBrands`,
`gpsSystems`, `trailerTypes`, `educationLevels`, `skills`,
`familyRelations`, `visaTypes`, `drivingQualifications`,
`howDidYouHear`, `workRegime`. Either ship admin-managed JSONB
translations on each settings table, or export the static seed values
to the i18n tree.

### Phase 2.E.2 — Native translations for the ~118 new enum + summary keys (~1 d)

Replace the English fallback values in `sk/de/ru/ar/tr` for the keys
introduced in this phase: `enums.{language,proficiency,skillLevel}.*`
and `pages.applicants.form.step11.summary.*`.

### Phase 2.E.3 — Move print summary to a backend PDF endpoint (optional, ~1 d)

The current frontend Blob/HTML approach works and is now localized,
but a backend-rendered PDF would: (a) match the layout in printed
contracts, (b) reuse the email-template per-locale strategy from
Phase 4 (`backend/src/email/email-i18n.ts`), and (c) allow signing /
watermarking. Trigger: if HR/Operations want a stamped PDF.

### Suggested next prompt

> Implement Phase 2.E.1 of the i18n component sweep. Branch
> `claude/phase-2e-i18n-settings-dropdowns`. Add a
> `settingsLabel(group, code, fallback?)` helper that reads admin-
> managed settings translations from the backend, with a frontend
> fallback to the seed English label. Apply across `ApplicantFormSteps.tsx`
> (transport types / truck brands / GPS systems / trailer types /
> education levels / skills / family relations / visa types / driving
> qualifications / "How did you hear" / work regime). Run
> `npm run i18n:check-keys`, `npm run i18n:check-literals`, and
> `npm run build` before commit. Push to the new branch. Do not
> open a PR.
