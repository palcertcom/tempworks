# I18N Phase 2.P — Implementation Report

**Branch:** `claude/phase-2p-i18n-roles-settings-longtail`
**Scope:** Frontend-only — Roles module (RolesList, CreateRole,
PermissionsMatrix), DatabaseBackup remaining safety bullets +
helper text, BrandingSettings, DocumentTypeEdit, DatabaseCleanup,
StageTransition dead-code removal.
**Date:** 2026-05-06.

---

## 1 · Changed files

```
# Roles module (3 files)
src/app/pages/roles/RolesList.tsx                       (6 → 0 ‡)
src/app/pages/roles/CreateRole.tsx                      (6 → 0 ‡)
src/app/pages/roles/PermissionsMatrix.tsx               (3 → 0 ‡)

# DatabaseBackup remaining
src/app/pages/settings/DatabaseBackup.tsx               (18 → ~3 ‡‡)

# BrandingSettings
src/app/pages/settings/BrandingSettings.tsx             (4 → 0)

# Top-5 literal files
src/app/pages/settings/DocumentTypeEdit.tsx             (13 → 0)
src/app/pages/settings/DatabaseCleanup.tsx              (12 → ~1)

# Dead-code removal
src/app/components/workflow/StageTransition.tsx         (deleted; 4 hits removed)

# Locales
src/i18n/locales/en/pages.json                          (+ ~125 keys)
src/i18n/locales/{sk,de,ru,ar,tr}/pages.json            (sync — English fallback)

I18N_PHASE_2P_REPORT.md                                 (new)
```

‡ All literal-scanner hits flagged for these files in Phase 2.O are translated.
‡‡ ~3 residual hits in DatabaseBackup are TS regex false positives (not user-visible JSX).

### Repo-wide literal-scanner totals

| Stage | Total |
|---|---:|
| Phase 2.O end | 430 |
| Phase 2.P end | 364 |

**66-literal reduction.**

---

## 2 · Roles module coverage

### `RolesList.tsx` (6 → 0)

Extended `roles.list.*` (~22 new keys):

```
✓ "Loading roles..." / "Failed to load roles" toast
✓ "Total Roles" / "Total Users" / "System Roles" / "Custom Roles" stat cards
✓ "All Roles" card title + "No roles found." empty state
✓ "System Role" badge + "{{count}} users" count
✓ Permission count grid: View / Create / Edit / Delete + "{{count}} modules"
✓ "Edit" inline action button
✓ AlertDialog: "Delete Role" title + body with name interpolation
✓ "Cancel" / "Deleting..." / "Delete Role" buttons
✓ Translated success toast: "Role \"{{name}}\" deleted"
```

### `CreateRole.tsx` (6 → 0)

Extended `roles.create.*` (~28 new keys). File previously had no
`useTranslation` hook — added one. Refactored `ACTION_LABELS`
(hardcoded English) to `ACTION_LABEL_KEYS` (i18n key references).

```
✓ Loading / Role not found / Access Denied states
✓ Edit Role / Create New Role headers + subtitles
✓ "Saving..." / "Save Changes" / "Create Role" button states
✓ Role Information / Permissions card titles + helper text
✓ Role Name / Description form labels + placeholders
✓ Module column header + 4 action column headers (View/Create/Edit/Delete)
✓ "No permissions available." empty state
✓ Toasts: roleNameRequired, createSuccess, updateSuccess,
   loadPermissionsFailed, createFailed, updateFailed
```

### `PermissionsMatrix.tsx` (3 → 0)

Extended `roles.matrix.*` (~6 new keys). File previously had no
`useTranslation` hook — added one.

```
✓ "Loading permissions..." state
✓ "Permissions Matrix" header + subtitle
✓ "Roles" / "Module × Role" card titles
✓ Legend: "granted" / "denied" labels
✓ "Module / Action" sticky column header
```

---

## 3 · DatabaseBackup remaining coverage

Phase 2.O translated 14 hits; Phase 2.P translated the remaining
~18 the scanner picked up after the 2.O pass. New keys added to
`settings.databaseBackup.*` (~50 keys total in this phase).

```
✓ Header subtitle + "Back to Settings" button
✓ All 4 safety bullets (with embedded <code> snippets preserved)
✓ "Completed" / "Status" / "Operation running…" / "Idle" stat labels
✓ Search placeholder + status filter SelectItems (Completed/Running/Failed)
✓ "Refresh" button + "Loading backups…" + table-empty states
✓ Table headers: File Name / Type / Size / Status / Created By /
   Created At / Notes / Actions
✓ "File missing from disk" warning
✓ Action button tooltips: Download backup / Restore from backup /
   Delete backup
✓ Pagination: "Page {{current}} of {{total}} · {{count}} backups" +
   Previous / Next
✓ Create dialog: title + description (with <code> via dangerouslySetInnerHTML)
   + "Notes (optional)" + placeholder + "What's included" + 4 bullets
✓ "Cancel" / "Creating…" / "Create Backup" actions
✓ Delete dialog: title + description + Size / Created labels +
   "Cancel" / "Deleting…" / "Delete Backup"
✓ Restore dialog: title + description + "Loading backup preview…"
✓ Restore success state: "Restore Completed Successfully" +
   Backup / Mode / Completed / Safety Backup ID labels
✓ Restore form: "Backup Details" + "Created By" + "Est. Rows" +
   "Restore Mode" + "Reason / notes (optional)"
✓ "Restoring…" / "Execute Restore" buttons
```

Residual ~3 hits are TS regex false positives (function signature
fragments captured by the heuristic scanner).

---

## 4 · BrandingSettings coverage

New `settings.branding.*` sub-tree (~36 new keys; previously
contained only "title": "Branding"). File previously had no
`useTranslation` hook — added one.

```
✓ Header: "Back to Settings" / "Company Branding" title +
   "Customize company info shown across…" subtitle
✓ Logo card: title + description + "Logo preview" alt +
   "Current logo" / "No logo — default icon shown" /
   "Choose File" / "Uploading…" / "Upload Logo"
✓ Identity card: title + description + Company Name + Tagline labels
✓ Hero card: title + description + Badge Text / Headline / Description
✓ Stats card: title + description +
   Successful Placements / Partner Companies / Countries Served labels
✓ Contact card: title + description +
   Office Address / Phone 1 / Phone 2 +
   General / Recruitment / Support Email labels
✓ Social card: title + LinkedIn URL / Facebook URL +
   Footer Tagline / Company Registration / VAT Info
✓ Save bar: "Saving…" / "Save All Changes"
```

---

## 5 · Top-5 literal-scanner files handled

| Rank | File | Before | After | Notes |
|---:|---|---:|---:|---|
| 1 | `settings/DatabaseBackup.tsx` | 18 | ~3 | All visible UI translated; residuals are TS false positives. |
| 2 | `settings/DocumentTypeEdit.tsx` | 13 | 0 | Full coverage. |
| 3 | `settings/DatabaseCleanup.tsx` | 12 | ~1 | Header, preview, exec UI translated; residual is the `⚠️` emoji line variant. |
| 4 | `roles/RolesList.tsx` | 6 | 0 | Full coverage. |
| 5 | `roles/CreateRole.tsx` | 6 | 0 | Full coverage. |

### `DocumentTypeEdit.tsx` (13 → 0)

Added `settings.documentTypes.edit.*` sub-tree (~18 keys). File
previously had no `useTranslation` hook — added one.

```
✓ "Edit Document Type" header + "Update document type configuration" subtitle
✓ "Basic Information" / "Document Settings" card titles
✓ "Document Type Name *" + placeholder + "Description" + placeholder
✓ "Category *" select + 7 category SelectItems:
   Identity Documents / Licenses & Certifications / Medical & Health /
   Legal & Immigration / Employment Documents / Insurance & Coverage /
   Training & Education
✓ "Required Document" toggle + helper
✓ "Expiry Date Tracking" toggle + helper +
   "Warning Period (Days Before Expiry)" sub-input label
```

### `DatabaseCleanup.tsx` (12 → ~1)

Extended `settings.databaseCleanup.*` (~12 keys). File previously
had no `useTranslation` hook — added one.

```
✓ Access denied panel
✓ "Database Cleanup / Reset" header
✓ Destructive warning paragraph
✓ "Cleanup Preview" card title
✓ "Will Remove:" / "Will Preserve:" section headers
✓ "Records Removed:" / "Preserved:" result-state headers
✓ "Reason for cleanup (optional)" form label
✓ "Executing…" / "Execute Cleanup" buttons
```

---

## 6 · Dead-code findings

### Confirmed dead and DELETED:

```
src/app/components/workflow/StageTransition.tsx   (4 literals removed)
```

Verified zero imports across `src/` (`grep -rln "from.*StageTransition"`
returned no matches before deletion). Originally flagged in Phase 2.E
as dead code; safely removed in this phase.

### Other inventoried but kept:

No other scanner-hotspot files were identified as dead code. All
remaining low-count hits (1-6 literals each) are in active modules.

---

## 7 · Scanner false positives

Carried into 2.P (TS-signature regex false positives):

- `pages/settings/BrandingSettings.tsx:78` — `(e: React.ChangeEvent`
  (handler signature, not user-visible)
- `components/applicants/ApplicantFormSteps.tsx` (6) — TS signatures
- `components/ui/alert.tsx` (1) — TS arrow fragment
- `pages/settings/DatabaseBackup.tsx` (~3) — function signature
  fragments
- `pages/finance/FinanceDashboard.tsx` (2) — TS arrow signatures

Total carried false-positive count ≈ 12.

---

## 8 · Locale parity

`/tmp/sync_keys.mjs` walked every namespace in `en/` and inserted
missing keys into each non-English locale verbatim. CLDR plural
variants for ar/ru/sk preserved.

---

## 9 · RTL polish

Touched files use logical Tailwind classes (`me-`, `ms-`, `text-end`,
`text-start`, `start-`, `end-`). No new directional icons introduced.

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
Found 364 suspicious hardcoded JSX literal(s)
  (down from 430 at end of Phase 2.O — 66-literal reduction).

$ npm run build
✓ built in ~20s
(bundle size warning unchanged; pre-existing.)
```

---

## 11 · New keys/namespaces

| Sub-tree | New keys (approx) | Purpose |
|---|---:|---|
| `roles.list.*` (extension) | ~22 | RolesList stats, badges, delete dialog, toasts |
| `roles.create.*` (extension) | ~28 | CreateRole form, permissions matrix headers |
| `roles.matrix.*` (extension) | ~6 | PermissionsMatrix card titles + legend |
| `settings.branding.*` (extension) | ~36 | All BrandingSettings UI |
| `settings.databaseBackup.*` (extension) | ~50 | Safety bullets + dialogs + table |
| `settings.databaseCleanup.*` (extension) | ~12 | Cleanup preview + result UI |
| `settings.documentTypes.edit.*` (new) | ~18 | DocumentTypeEdit form |
| **Total new EN keys** | **~172** | — |

Times 5 non-EN locales = **~860 strings** awaiting native
translation. Cumulative since Phase 2.A is now ~4,170 EN keys ×
5 locales ≈ **~20,850 strings**.

---

## 12 · Remaining high-impact untranslated areas

Sorted by literal-scanner count (post-2.P):

| File | Literals | Notes |
|---|---:|---|
| `pages/settings/DatabaseBackup.tsx` | ~3 | TS false positives. |
| `pages/applicants/CandidatesList.tsx` | 3 | Body residuals. |
| `pages/public/DataProcessingAgreement.tsx` | 3 | Long-text inline strong tags. |
| `pages/settings/DatabaseCleanup.tsx` | ~1 | Emoji-prefixed warning variant. |
| `components/applicants/ApplicantFormSteps.tsx` | 6 | TS-signature false positives. |
| `pages/job-ads/JobAdsList.tsx` | 2 | TS-signature fragments. |
| `pages/finance/FinanceDashboard.tsx` | 2 | TS-signature fragments. |
| `pages/documents/DocumentsCompliance.tsx` | 2 | TS-signature fragments. |
| `pages/settings/ColorScheme.tsx` | 2 | Theme labels. |
| Long tail (~30 files × 1-2 hits) | — | Mostly mixed: some real, some TS noise. |

---

## 13 · Recommended Phase 2.Q / Backend Phase 3 scope

### Phase 2.Q.1 — Long-tail sweep (~1 d)

Translate the ~30 files with 1–2 visible-text literal hits each.
Mechanical pattern; mostly `<h1>` / button / placeholder / label
strings.

### Phase 2.Q.2 — DataProcessingAgreement final residuals (~0.25 d)

Wire the 3 remaining `<strong>GDPR</strong>` / `<strong>("Regulation").</strong>`
inline JSX fragments via `<Trans>` component or refactor the
sentence boundary so the bold wraps a single key value.

### Phase 2.Q.3 — Scanner false-positive cleanup (~0.5 d)

Update `scripts/i18n-check-literals.mjs` regex to skip TS-signature
patterns (`(e: React.ChangeEvent`, `as Record`, etc.) — eliminating
~12 carried false positives without code changes.

### Phase 2.Q.4 — Native translations (~3-4 d)

Cumulative translator workload is ~4,170 EN keys × 5 locales ≈
~20,850 strings. DPA legal text (~50 paragraphs) requires native
legal review.

### Phase 3 — Backend i18n (~2 weeks)

Per Phase 2.O / 2.N reports. Scope:
- API error messages → translation keys (resolve client-side)
- Email templates → per-locale handlebars/.hbs variants
- PDF generators → thread `t()` through templates
- Zod validation → translation keys

### Suggested next prompt

> Implement Phase 2.Q based on I18N_PHASE_2P_REPORT.md.
> Branch `claude/phase-2q-i18n-tail-and-scanner`. Sweep the ~30
> remaining files with 1–2 literal hits each, finish DPA inline
> bold residuals via `<Trans>` component, and update the
> i18n literal-scanner regex to skip TS-signature false positives.
> Run `npm run i18n:check-keys`, `npm run i18n:check-literals`,
> and `npm run build` before commit. Push to the new branch.
> Do not open a PR.
