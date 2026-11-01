# I18N Phase 2.Q — Implementation Report

**Branch:** `claude/phase-2q-i18n-longtail-scanner`
**Scope:** Frontend-only — Settings DocumentType module (DocumentTypeNew,
DocumentTypeView, DocumentTypeEdit sidebar, DocumentTypes list), JobTypes,
ColorScheme, CandidatesList optional label, DataProcessingAgreement
controller address, scanner false-positive tightening.
**Date:** 2026-05-06.

---

## 1 · Changed files

```
# Settings — DocumentType module (5 files)
src/app/pages/settings/DocumentTypeNew.tsx      (26 → 0 ‡)
src/app/pages/settings/DocumentTypeView.tsx     (19 → 0 ‡)
src/app/pages/settings/DocumentTypeEdit.tsx     (12 → 0 ‡)  [Phase 2.P sidebar residual]
src/app/pages/settings/DocumentTypes.tsx        (9  → 0 ‡)
src/app/pages/settings/JobTypes.tsx             (10 → 0 ‡)

# Other UI files
src/app/pages/settings/ColorScheme.tsx          (2  → 0)
src/app/pages/applicants/CandidatesList.tsx     (1 real hit → 0)
src/app/pages/public/DataProcessingAgreement.tsx(3  → 0)

# Scanner improvement
scripts/i18n-check-literals.mjs                 (5 new false-positive filters)

# Locales
src/i18n/locales/en/pages.json                  (+ ~175 keys)
src/i18n/locales/en/public.json                 (+ 3 keys)
src/i18n/locales/{sk,de,ru,ar,tr}/pages.json    (sync — English fallback)
src/i18n/locales/{sk,de,ru,ar,tr}/public.json   (sync — English fallback)

I18N_PHASE_2Q_REPORT.md                         (new)
```

‡ All literal-scanner hits flagged for these files are translated.

### Repo-wide literal-scanner totals

| Stage | Total |
|---|---:|
| Phase 2.P end | 364 |
| Phase 2.Q end | 255 |

**109-literal reduction** (81 real hits translated + ~28 false positives
eliminated by scanner tightening).

---

## 2 · DocumentType module coverage

### `DocumentTypeNew.tsx` (26 → 0)

Added `settings.documentTypes.new.*` sub-tree (~60 new keys).
File previously had no `useTranslation` hook — added one.

```
✓ Header: title + subtitle
✓ Basic Information card: name label + placeholder, description + placeholder,
  Category * label + SelectValue placeholder + 8 category SelectItems
✓ Document Settings card: Required Document + helper, Expiry Date Tracking +
  helper, Warning Period label, Allow Multiple + helper, Verification + helper
✓ File Upload Settings card: Allowed File Formats label + "None" fallback +
  Maximum File Size label
✓ Job Category Applicability card: title + subtitle + allCategoriesInfo tip
✓ Validation Rules card: title + Custom Validation Rules label + example
✓ Sidebar — Configuration Summary: title + 7 row labels + all status values
  (Required/Optional, Enabled/Disabled, Allowed/Single File, Any, All)
✓ Sidebar — Important Information card: title + 4 bullet points
✓ Actions: "Creating..." / "Create Document Type" / "Cancel"
```

### `DocumentTypeView.tsx` (19 → 0)

Added `settings.documentTypes.view.*` sub-tree (~45 new keys).
File previously had no `useTranslation` hook — added one.

```
✓ Loading state text
✓ Edit / Deactivate header buttons
✓ Badges: "Required Document" + "Expiry Tracking Enabled"
✓ Stat cards: "Total Uploads" + "Days Warning Before Expiry"
✓ Tabs: "Details" / "Settings"
✓ Details tab: Basic Information card (Document Type Name / Category /
  Description / Status labels) + Configuration card (Required Document /
  Expiry Tracking / Warning Period labels + Yes/No/Enabled/Disabled values)
✓ Metadata card: "Created On" / "Last Updated" labels
✓ Settings tab: Document Type Settings title + subtitle + 3 section boxes
  (Basic Settings / Requirements / Expiry Settings) with all label/value pairs
✓ Alert dialog: deactivateTitle + deactivateDesc ({{name}} interpolation) +
  Cancel + Deactivating... / Deactivate
```

### `DocumentTypeEdit.tsx` (12 → 0)

Extended `settings.documentTypes.edit.*` (~34 new keys).
Translated the sidebar + extra cards that Phase 2.P left untouched.

```
✓ Allow Multiple Uploads toggle + helper
✓ Verification Required toggle + helper
✓ File Upload Settings card: title + Allowed File Formats + "None" fallback +
  Maximum File Size (MB)
✓ Validation Rules (Optional) card: title + Custom Validation Rules + example
✓ Sidebar — Configuration Summary: title + 5 row labels + all status values
✓ Sidebar — Important Notice card: title + 3 bullet points
✓ Sidebar — Current Usage card: title + "Total Uploads:" label
✓ Actions: "Saving..." / "Save Changes" / "Cancel"
```

### `DocumentTypes.tsx` (9 → 0)

Added to `settings.documentTypes.*` root (~21 new keys).
File previously had no `useTranslation` hook — added one.

```
✓ Header: title + subtitle + "Add Document Type" button
✓ 4 stat cards: Total Document Types / Required Types /
  With Expiry Tracking / Total Documents
✓ List card: title + "Loading document types..." + empty state + "Add one" link
✓ Table headers: Document Type / Category / Status / Uploads / Actions
✓ Expiry Tracking badge
✓ Alert dialog: deactivateTitle + deactivateDesc + Cancel +
  Deactivating... / Deactivate
```

---

## 3 · JobTypes coverage (10 → 0)

Added to `settings.jobTypes.*` (~10 new keys).
File previously had no `useTranslation` hook — added one.

```
✓ Header: "Job Categories Configuration" title + subtitle
✓ 4 stat cards: Total Job Categories / Active Types / Inactive Types /
  Total Applicants
✓ "Loading job categories..." state
✓ "Required Documents:" label
✓ Dialog: "Job Category Name *" label
✓ Active Status switch: label + helper text
```

---

## 4 · ColorScheme coverage (2 → 0)

Extended `settings.colorScheme.*` (~2 new keys).
File previously had no `useTranslation` hook — added one.

```
✓ "Appearance & Color Scheme" header title
✓ "Customize the visual theme for the entire application" subtitle
```

---

## 5 · CandidatesList residual (1 real hit → 0)

Extended `applicants.candidates.workflowDialog.*` (1 new key).

```
✓ "(optional)" span in bulk-workflow Notes label
  → t('applicants.candidates.workflowDialog.optionalLabel')
```

The 2 other scanner hits for CandidatesList (`= 0 && age`,
`= from && t`) were TypeScript false positives now eliminated
by the scanner tightening.

---

## 6 · DataProcessingAgreement residuals (3 → 0)

Added 3 keys to `public.json` under `dpa.*`.

```
✓ dpa.controllerCompany  → "Tempworks s.r.o"
✓ dpa.controllerAddress1 → "Röntgenova 3751/28"
✓ dpa.controllerAddress2 → "851 01 Petržalka"
```

---

## 7 · Scanner false-positive tightening

Five new filters added to `scripts/i18n-check-literals.mjs`
`looksUserVisible()`:

| Pattern | Example eliminated |
|---|---|
| `/^= /` | `"= from && t"`, `"= 0 && age"` |
| `/ && /` | `"0 && daysUntilExpiry"` |
| `/\? ['"]/` | `"0 ? 'text-emerald-700' : rec.runningBalance"` |
| `/\bas Record\b/` | `"[c.key, true])) as Record"` |
| `/^\(e: React/` | `"(e: React.ChangeEvent"` |

These 5 rules eliminated ~28 false-positive hits that were
previously reported across 10 files, without affecting any
genuine user-visible strings.

---

## 8 · New keys/namespaces

| Sub-tree | New keys (approx) | Purpose |
|---|---:|---|
| `settings.documentTypes.*` (root extension) | ~21 | DocumentTypes list page |
| `settings.documentTypes.edit.*` (extension) | ~34 | DocumentTypeEdit sidebar/cards |
| `settings.documentTypes.new.*` (new) | ~60 | DocumentTypeNew full form |
| `settings.documentTypes.view.*` (new) | ~45 | DocumentTypeView all labels |
| `settings.jobTypes.*` (extension) | ~10 | JobTypes stats + dialog |
| `settings.colorScheme.*` (extension) | ~2 | ColorScheme header |
| `applicants.candidates.workflowDialog.*` (extension) | 1 | optionalLabel |
| `public / dpa.*` (extension) | 3 | Controller address |
| **Total new EN keys** | **~176** | — |

Times 5 non-EN locales = **~880 strings** awaiting native translation.
Cumulative since Phase 2.A is now ~4,350 EN keys × 5 locales ≈ **~21,750 strings**.

---

## 9 · Locale parity

`/tmp/sync_keys.mjs` walked every namespace in `en/` and inserted
missing keys into each non-English locale verbatim. CLDR plural
variants for ar/ru/sk preserved.

---

## 10 · Quality checks

```
$ node /tmp/sync_keys.mjs
✓ ar synced
✓ de synced
✓ ru synced
✓ sk synced
✓ tr synced

$ npm run i18n:check-keys
✓ All 5 target locales × 9 namespaces match English.

$ npm run i18n:check-literals
Found 255 suspicious hardcoded JSX literal(s)
  (down from 364 at end of Phase 2.P — 109-literal reduction).

$ npm run build
✓ built in ~31s
(bundle size warning unchanged; pre-existing.)
```

---

## 11 · Remaining high-impact untranslated areas

Now visible in the scanner (previously hidden in the "264 more" bucket):

| File | Literals | Notes |
|---|---:|---|
| `pages/settings/Settings.tsx` | 28 | Main settings hub page. |
| `pages/settings/SystemInformation.tsx` | 16 | System info panel. |
| `pages/settings/SecuritySettings.tsx` | 16 | Security config panel. |
| `pages/settings/MaintenanceTypesSettings.tsx` | 10 | Maintenance types list. |
| `pages/settings/TransactionTypesSettings.tsx` | 6 | Transaction types list. |
| `components/applicants/ApplicantFormSteps.tsx` | 6 | TS false positives — skip. |
| `pages/settings/TransportTypesSettings.tsx` | 5 | Transport types list. |
| `pages/settings/TrailerTypesSettings.tsx` | 5 | Trailer types list. |
| `pages/settings/SkillsSettings.tsx` | 5 | Skills list. |
| Long tail (~20+ files × 1-5 hits) | ~155 | Mix of real and TS noise. |

---

## 12 · Recommended Phase 2.R scope

### Phase 2.R.1 — Settings hub + sub-pages (~1 d)

Translate `Settings.tsx` (28 hits), `SystemInformation.tsx` (16),
`SecuritySettings.tsx` (16), and the 5 smaller settings type-catalog
pages (Maintenance/Transaction/Transport/Trailer/Skills — ~31 combined).

### Phase 2.R.2 — Long-tail sub-100 files (~0.5 d)

Sweep the remaining ~20 files with 1–5 hits each.

### Phase 2.R.3 — Native translations (~3-4 d)

Cumulative translator workload is ~4,350 EN keys × 5 locales ≈
~21,750 strings. DPA legal text requires native legal review.

### Phase 3 — Backend i18n (~2 weeks)

Per Phase 2.O / 2.N / 2.P reports. Scope:
- API error messages → translation keys (resolve client-side)
- Email templates → per-locale handlebars/.hbs variants
- PDF generators → thread `t()` through templates
- Zod validation → translation keys

### Suggested next prompt

> Implement Phase 2.R based on I18N_PHASE_2Q_REPORT.md.
> Branch `claude/phase-2r-i18n-settings-hub`. Translate Settings.tsx,
> SystemInformation, SecuritySettings, and the 5 smaller settings
> type-catalog pages. Then sweep remaining long-tail files.
> Run `npm run i18n:check-keys`, `npm run i18n:check-literals`,
> and `npm run build` before commit. Push to the new branch.
> Do not open a PR.
