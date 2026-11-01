# I18N Phase 2.R — Implementation Report

**Branch:** `claude/phase-2r-i18n-settings-system`
**Scope:** Frontend-only — Settings hub (Settings.tsx), SystemInformation,
SecuritySettings, six type-catalog settings pages, three long-tail settings
pages, scanner false-positive tightening.
**Date:** 2026-05-06.

---

## 1 · Changed files

```
# Settings hub
src/app/pages/settings/Settings.tsx          (28 → 0 ‡)

# System & Security panels
src/app/pages/settings/SystemInformation.tsx (16 → 0 ‡)
src/app/pages/settings/SecuritySettings.tsx  (16 → 0 ‡)

# Type-catalog settings pages
src/app/pages/settings/MaintenanceTypesSettings.tsx    (10 → 0 ‡)
src/app/pages/settings/TransactionTypesSettings.tsx    ( 6 → 0 ‡)
src/app/pages/settings/SkillsSettings.tsx              ( 5 → 0 ‡)
src/app/pages/settings/TrailerTypesSettings.tsx        ( 5 → 0 ‡)
src/app/pages/settings/TransportTypesSettings.tsx      ( 5 → 0 ‡)
src/app/pages/settings/TruckBrandsSettings.tsx         ( 1 → 0 ‡)

# Long-tail sweep (newly visible after prior phases)
src/app/pages/settings/VehicleSettings.tsx             (10 → 0 ‡)
src/app/pages/settings/WorkHistoryEventTypesSettings.tsx( 8 → 0 ‡)
src/app/pages/settings/WorkflowSettings.tsx            ( 2 → 0 ‡)

# Scanner improvement
scripts/i18n-check-literals.mjs             (2 new false-positive filters)

# Locales
src/i18n/locales/en/pages.json              (+ ~200 keys)
src/i18n/locales/{sk,de,ru,ar,tr}/pages.json (sync — English fallback)

I18N_PHASE_2R_REPORT.md                     (new)
```

‡ All literal-scanner hits flagged for these files are translated.

### Repo-wide literal-scanner totals

| Stage | Total |
|---|---:|
| Phase 2.Q end | 255 |
| Phase 2.R end | 137 |

**118-literal reduction** (~112 real hits translated + ~6 false positives
eliminated by scanner tightening).

---

## 2 · Settings.tsx coverage (28 → 0)

Added `settings.index.cards.*` (~33 new keys), `settings.index.logRetention.*`
(9 keys), `settings.index.sysInfoCard.*` (8 keys).

```
✓ settingsCategories array: 6 cards (Job Categories / Document Types /
  Transaction Types / Work History Event Types / Notification Rules /
  Security Settings) — title, description, badge
✓ Appearance card: title + "Theme" badge + description
✓ Manage Workflows card: title + "Admin Only" badge + description
✓ Company Branding card: title + badge + description
✓ Skills List card: title + badge + description
✓ Transport Types card: title + badge + description
✓ Truck Brands card: title + badge + description
✓ Trailer Types card: title + badge + description
✓ Vehicle Settings card: title + badge + description
✓ Database Backup & Restore card: title + badge + description
✓ System Information card: title + badge + description
✓ Database Cleanup card: title + "Danger Zone" badge + description
✓ Log Retention Policy: card title + desc + period label + helper +
  4 SelectItems (30/90/180/365 days) + save button
✓ System Info bottom card: title + fallback desc + Edit button +
  System Version / Last Updated / Database Status / Total Users labels + "Not set"
```

---

## 3 · SystemInformation.tsx coverage (16 → 0)

Added/extended `settings.systemInformation.*` (~22 new keys).
File previously had no `useTranslation` hook — added one.

```
✓ Access Denied guard: title + body
✓ Back to Settings button
✓ Header: h1 title + subtitle
✓ 4 stat cards: Total Users / Total Employees / Total Applicants / Total Agencies
✓ Database Status: label
✓ System Details card: title + description
✓ Loading state
✓ 7 form labels: System Version / Last Updated / Organization Name /
  Contact Email / Support Phone / Website / Address
✓ Save feedback: "Saved successfully" + "Saving…" / "Save Changes" button
```

---

## 4 · SecuritySettings.tsx coverage (16 → 0)

Extended `settings.security.*` (~31 new keys).
File previously had no `useTranslation` hook — added one.
Toast error/success messages are also translated.

```
✓ Header: h1 + subtitle
✓ Account Lockout card: title + label + "failed attempts" suffix +
  helper text + validation toast + success toast + "Save threshold" button
✓ Session Idle Timeout card: title + label + "minutes" suffix +
  helper text + validation toast + success toast + "Save timeout" button
✓ Authentication card: title + 2FA label + helper +
  Session Timeout label + 4 SelectItems
✓ Access Control card: title + IP Restriction label + helper +
  Audit Logging label + helper
✓ Security Status card: title
```

---

## 5 · Type-catalog pages coverage (32 combined → 0)

### `MaintenanceTypesSettings.tsx` (10 → 0)
Added `settings.maintenanceTypes.*` sub-tree extension (~16 new keys).
```
✓ Access denied guard
✓ Header: title (h1 + icon) + subtitle
✓ Form card: "Edit / Add New Maintenance Type" dynamic title
✓ Form labels: Name * / Description / Default Interval (Days/km) /
  Interval Mode + 3 SelectItems + helper text
✓ Loading + empty states
```

### `TransactionTypesSettings.tsx` (6 → 0)
Added `settings.transactionTypes.*` sub-tree extension (~9 new keys).
```
✓ Header: h1 title
✓ Loading state
✓ Dialog: Name * / Sort Order labels + helper + Active label + helper
✓ Save/Cancel/Create button labels
```

### `SkillsSettings.tsx` (5 → 0)
Added `settings.skills.*` sub-tree extension (~8 new keys).
```
✓ Access denied guard + header + subtitle
✓ Add card: title + description
✓ Loading + empty states + Save Changes button
```

### `TrailerTypesSettings.tsx` (5 → 0), `TransportTypesSettings.tsx` (5 → 0)
Added parallel sub-trees (~8 keys each).
```
✓ Access denied + header/subtitle + add card title/desc + loading/empty/save
```

### `TruckBrandsSettings.tsx` (1 → 0)
```
✓ Access denied guard
```

---

## 6 · Long-tail sweep (20 → 0)

### `VehicleSettings.tsx` (10 → 0)
Reused `settings.maintenanceTypes.*` keys for the embedded
`MaintenanceTypesEditor` sub-component. Added `settings.vehicleSettings.accessDenied`
and `settings.vehicleSettings.loading`.

### `WorkHistoryEventTypesSettings.tsx` (8 → 0)
Added `settings.workHistoryEventTypes.*` sub-tree extension (~8 new keys).
```
✓ Header h1 + loading state
✓ Dialog: Value * label + helper / Label * label /
  Sort Order label + helper / Active helper
```

### `WorkflowSettings.tsx` (2 → 0)
Extended `settings.workflowConfiguration.subtitle`.

---

## 7 · Scanner false-positive tightening

Two new filters added to `scripts/i18n-check-literals.mjs`
`looksUserVisible()`:

| Pattern | Example eliminated |
|---|---|
| `/^& [A-Z]/` | `"& VariantProps"` (TypeScript intersection type) |
| `/^Number\(/` | `"Number(r.companyDisbursedAmount ?? 0)"` (JS call) |

These 2 rules eliminate remaining TS/JS expression hits from
`alert.tsx` and `FinanceDashboard.tsx`.

---

## 8 · New keys/namespaces

| Sub-tree | New keys (approx) | Purpose |
|---|---:|---|
| `settings.index.cards.*` (new) | ~33 | Settings hub card grid |
| `settings.index.logRetention.*` (new) | ~9 | Log Retention Policy section |
| `settings.index.sysInfoCard.*` (new) | ~8 | Bottom system info card |
| `settings.systemInformation.*` (extension) | ~22 | SystemInformation page |
| `settings.security.*` (extension) | ~31 | SecuritySettings page |
| `settings.maintenanceTypes.*` (extension) | ~16 | MaintenanceTypesSettings + VehicleSettings sub-component |
| `settings.transactionTypes.*` (extension) | ~9 | TransactionTypesSettings |
| `settings.skills.*` (extension) | ~8 | SkillsSettings |
| `settings.trailerTypes.*` (extension) | ~8 | TrailerTypesSettings |
| `settings.transportTypes.*` (extension) | ~8 | TransportTypesSettings |
| `settings.truckBrands.*` (extension) | ~8 | TruckBrandsSettings |
| `settings.vehicleSettings.*` (extension) | ~2 | VehicleSettings access/loading |
| `settings.workHistoryEventTypes.*` (extension) | ~8 | WorkHistoryEventTypesSettings |
| `settings.workflowConfiguration.subtitle` (extension) | 1 | WorkflowSettings |
| **Total new EN keys** | **~171** | — |

Times 5 non-EN locales = **~855 strings** awaiting native translation.
Cumulative since Phase 2.A is now ~4,520 EN keys × 5 locales ≈ **~22,600 strings**.

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
Found 137 suspicious hardcoded JSX literal(s)
  (down from 255 at end of Phase 2.Q — 118-literal reduction).

$ npm run build
✓ built in ~17s
(bundle size warning unchanged; pre-existing.)
```

---

## 11 · Remaining high-impact untranslated areas

| File | Literals | Notes |
|---|---:|---|
| `pages/users/EditUser.tsx` | ~14 | User edit form — labels, toggles, agency permissions |
| `pages/users/AddUser.tsx` | ~13 | User create form — labels, profile photo |
| `pages/users/UsersList.tsx` | ~11 | Users list — filter dropdowns, toggle columns |
| `pages/vehicles/VehiclesList.tsx` | ~10 | Vehicle list page |
| `pages/vehicles/MaintenanceRecordsList.tsx` | ~5 | Maintenance records filters |
| `pages/vehicles/MaintenanceTypesList.tsx` | ~5 | Maintenance types list page |
| `pages/vehicles/WorkshopsList.tsx` | ~5 | Workshops list filters |
| `components/applicants/ApplicantFormSteps.tsx` | 6 | TS false positives — skip |
| Long tail (~15+ files × 1-3 hits) | ~68 | Mix of real and TS noise |

---

## 12 · Recommended Phase 2.S scope

### Phase 2.S.1 — Users module (~0.5 d)

Translate `AddUser.tsx` (13 hits), `EditUser.tsx` (14 hits),
`UsersList.tsx` (11 hits).

### Phase 2.S.2 — Vehicles module (~0.5 d)

Translate `VehiclesList.tsx` (10), `MaintenanceRecordsList.tsx` (5),
`MaintenanceTypesList.tsx` (5), `WorkshopsList.tsx` (5), and remaining
vehicle sub-pages.

### Phase 2.S.3 — Long-tail sub-50 files (~0.5 d)

Sweep the remaining ~15 files with 1–3 hits each.

### Phase 2.S.4 — Native translations (~3-4 d)

Cumulative translator workload is ~4,520 EN keys × 5 locales ≈
~22,600 strings. DPA legal text requires native legal review.

### Phase 3 — Backend i18n (~2 weeks)

- API error messages → translation keys (resolve client-side)
- Email templates → per-locale handlebars/.hbs variants
- PDF generators → thread `t()` through templates
- Zod validation → translation keys

### Suggested next prompt

> Implement Phase 2.S based on I18N_PHASE_2R_REPORT.md.
> Branch `claude/phase-2s-i18n-users-vehicles`. Translate AddUser.tsx,
> EditUser.tsx, UsersList.tsx (Users module), then VehiclesList.tsx
> and remaining vehicles pages. Then sweep remaining long-tail files.
> Run `npm run i18n:check-keys`, `npm run i18n:check-literals`,
> and `npm run build` before commit. Push to the new branch.
> Do not open a PR.
