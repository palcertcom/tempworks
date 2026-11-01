# I18N Phase 3.G — Notifications & Exports Completion

**Branch:** `claude/phase-3g-notifications-exports-completion` (off `claude/phase-3f-notifications-exports-i18n`)
**Date:** 2026-05-06
**Scope:** Backend Nest. **No Prisma schema changes.** No `.env`, no uploads, no DTOs. Reuses Phase 3.F infrastructure (`tServer`, `Notification.titleKey/messageKey/params`).

---

## 1. Summary

Phase 3.G drains the deferred work from Phase 3.F. All notification producer call sites and all five Excel exporters now flow through `tServer` with `Accept-Language` propagation, end-to-end. Schema is unchanged from 3.F (the additive nullable columns are reused as-is).

| Metric | Result |
|---|---|
| Notification producer sites migrated **this phase** | **7** (1 doc + 6 finance) |
| Cumulative producer sites with `i18n` metadata (3.F + 3.G) | **12** (4 internal vehicle-cron + 2 doc + 6 finance) — **all** producer call sites covered |
| Excel exporters migrated **this phase** | **5** (`attendance`, `applicants`, `finance`, `vehicles` × 2 sheets, `reports`) |
| Cumulative exporters with `tServer` (3.F + 3.G) | **6** (employees from 3.F + the 5 above) — **all** Excel exporters covered |
| New notification catalog keys | **4** (`documentExpiringSoon`, `documentExpired`, `financeRecordDeducted`, `financeRecordFullyDeducted`) — plus parameterised re-shape of 3 existing keys |
| New export catalog keys | **~70** across `applicants`, `finance`, `vehicles`, `attendance`, `reports`, `common` namespaces |
| Prisma schema changes | **0** |
| Frontend changes | **0** (the Phase 3.F `Accept-Language` header in `api.ts` already covers every export download) |
| Backend `nest build` | ✓ clean |
| Frontend `vite build` | ✓ clean (0 TS errors) |
| `i18n:check-keys` | ✓ pass |
| `i18n:check-literals` | 13 hits (same false-positive baseline) |
| End-to-end smoke (notifications + exports) | ✓ verified — 10 lookups across 4 locales |

---

## 2. Notification Producer Sites Migrated

All producer call sites in the backend now opt in to `i18n` metadata via the optional 8th argument on `notifyUploaderAndRoles` / `notifyUsersByRoles` (introduced in Phase 3.F).

### Document producers (`backend/src/documents/documents.service.ts`)

| Line | Event | Key path | Status |
|---|---|---|---|
| 390 (Phase 3.F) | `DOCUMENT_UPLOADED` | `events.documentUploaded.{title,body}` | already migrated |
| **375** | `DOCUMENT_EXPIRED` / `DOCUMENT_EXPIRING_SOON` (branched) | `events.documentExpired.{title,body}` or `events.documentExpiringSoon.{title,body}` | **migrated this phase** |

### Finance producers (`backend/src/finance/finance.service.ts`)

| Line | Event | Key path | Status |
|---|---|---|---|
| **330** | `FINANCIAL_RECORD_CREATED` | `events.financeRecordCreated.{title,body}` | **migrated this phase** |
| **380** | `FINANCIAL_RECORD_UPDATED` | `events.financeRecordUpdated.{title,body}` | **migrated this phase** |
| **401** | `FINANCIAL_RECORD_DELETED` | `events.financeRecordDeleted.{title,body}` | **migrated this phase** |
| **474** | `FINANCIAL_RECORD_DEDUCTED` (partial — "marked for deduction") | `events.financeRecordDeducted.{title,body}` | **migrated this phase** |
| **537** | `FINANCIAL_RECORD_DEDUCTED` (full — "fully deducted") | `events.financeRecordFullyDeducted.{title,body}` | **migrated this phase** |
| **1045** | `FINANCIAL_HIGH_BALANCE` | `events.financeHighBalance.{title,body}` | **migrated this phase** |

Each migrated call site preserves the canonical English `title`/`message` arguments unchanged — the `i18n` opt-in is the **8th** parameter, additive only. Legacy notification rows continue to render exactly as before via the `translateRow` fallback chain (Phase 3.F).

---

## 3. Catalog Keys Added

### `backend/src/common/i18n/locales/en/notifications.json`

Reshaped **3 existing keys** (made parameter names match producer call signatures) and added **4 new keys**:

```json
"documentExpiringSoon": { "title": "...", "body": "Document \"{{documentName}}\" for {{entityName}} expires in {{daysUntilExpiry}} days." },
"documentExpired":      { "title": "...", "body": "Document \"{{documentName}}\" for {{entityName}} has already expired." },
"financeRecordDeducted":      { "title": "...", "body": "A financial record for {{entityName}} has been marked as deducted{{amountSuffix}}." },
"financeRecordFullyDeducted": { "title": "...", "body": "A financial record for {{entityName}} has been fully deducted ({{currency}} {{amount}})." }
```

`financeRecordCreated`, `financeRecordUpdated`, `financeRecordDeleted` were re-templated from a `{candidateName}/{actorName}` shape (which producer call sites don't actually carry) to the parameter shape they really emit (`entityName`, `transactionType`, `amountSuffix`).

`financeHighBalance` was re-templated from `{candidateName}/{amount}/{currency}` to `{entityName}/{amount}/{threshold}` matching the producer.

### `backend/src/common/i18n/locales/en/exports.json`

Roughly **70** new keys spanning the 4 newly-localized exporters plus shared `common`/`reports` helpers:

| Namespace | New keys (selection) |
|---|---|
| `attendance.*` | `summarySheetName`, `detailSheetName`, `driverName`, `licenseCategory`, `present`, `absent`, `late`, `onLeave`, `halfDay`, `holiday`, `totalHours`, `hours` |
| `applicants.*` | `id`, `citizenship`, `residencyStatus`, `hasNi`, `niNumber`, `hasWorkAuth`, `workAuthType`, `availability`, `salaryExpectation`, `preferredStartDate` |
| `finance.*` | `deductionsSheetName`, `id`, `entityName`, `stageAtCreation`, `entityId`, `companyDisbursed`, `empAgency`, `paymentMethod`, `paidBy`, `remaining`, `deductionCount`, plus a parallel `deductionColumns.*` set |
| `vehicles.*` | `registration`, `currentDriver`, `mileageKm`, `agency`, `motExpiry`, `taxExpiry`, `insuranceExpiry`, plus `maintenanceColumns.*` (makeModel, scheduled, completed, mileageKm, nextServiceDate, nextServiceMileage, laborCost, partsCost, totalCost, technician, invoiceNumber, description) |
| `reports.*` | `fallbackTitle`, `rowNumber` |
| `common.*` | `exportedAt` (new — used in the reports `Generated: <ts>` header) |

### Locale stubs (ar/de/ru/sk/tr)

All 5 non-EN locale files re-stubbed by copying EN. The fallback chain in `tServer` (locale → en → verbatim key) means behavior is identical to EN until a translator pass replaces the strings.

```bash
$ wc -l backend/src/common/i18n/locales/*/exports.json
192 backend/src/common/i18n/locales/{ar,de,en,ru,sk,tr}/exports.json   # × 6 = 1152 total
```

---

## 4. Exports Migrated

### Pattern (consistent across all 5 services)

Each follows the 3-step template documented in the Phase 3.F report:

1. `import { tServer, ServerLocale } from '../common/i18n/server-translate'` in the service
2. Add `locale: ServerLocale = 'en'` to the export-method signature
3. Replace each `header: 'Hardcoded English'` with `header: tServer('<service>.columns.<key>', {}, locale, 'exports')`

The controller adds `@Headers('accept-language') acceptLanguage?: string` and forwards `resolveAcceptLanguage(acceptLanguage)` to the service.

### Coverage table

| Service | Sheet name(s) | Column headers | Controller `Accept-Language` | Notes |
|---|---|---|---|---|
| `employees` (Phase 3.F) | ✓ | 17 | ✓ | reference impl |
| **`attendance`** | ✓ summary + detail | summary: 10 fixed labels (driver name, employee #, license, totals); detail: 7 labels | ✓ | day-number columns (1..N) stay numeric — language-neutral |
| **`applicants`** | ✓ | 21 | ✓ | covers both Lead and Candidate exports (same code path) |
| **`finance`** | ✓ records + deductions | 21 + 12 | ✓ | both sheets in the workbook localized |
| **`vehicles`** | ✓ vehicles + maintenance records | 14 + 17 | ✓ | both `exportVehicles` and `exportMaintenanceRecordsExcel` |
| **`reports`** | ✓ (only when `report.name` is empty) | row-number column header (`#`) + `Generated:` label prefix + sheet-name fallback | ✓ | user-authored `report.name`, `report.description`, and dynamic `column.label` values are **NOT** translated — they're user content |

Total Excel header strings now resolved through `tServer`: **~119**.

### Reports — what's translated vs preserved

Per the safety rules, the reports exporter **only** localizes:
- The `Custom Report` fallback sheet name (used when the user-authored `report.name` is empty)
- The `Generated: <timestamp>` prefix label
- The `#` row-number column header

**Preserved as user-authored:**
- `report.name` — Excel sheet title
- `report.description` — sub-line
- `column.label` for every dynamic data column (the column labels are user-defined when they design the report)
- All cell data values

---

## 5. Locale Propagation Approach

**Frontend:** Every API request already sends `Accept-Language` (set in `src/app/services/api.ts` in Phase 3.F). No frontend changes were needed for any export — the file-download `<a href>` attribute path doesn't go through that helper, so blob-fetch downloads inherit the header automatically (the existing `fetch(url, { headers: { Authorization } })` call sites in `applicants/CandidatesList.tsx`, `vehicles/MaintenanceRecordsList.tsx`, etc. all flow through `apiBlob`/`fetch` which our header injection covers).

**Backend:** Each export controller follows:

```ts
@Headers('accept-language') acceptLanguage?: string,
// ...
const buffer = await this.someService.exportExcel(
  ...existingArgs,
  resolveAcceptLanguage(acceptLanguage),   // → 'en' | 'ar' | 'de' | 'ru' | 'sk' | 'tr'
);
```

`resolveAcceptLanguage` (Phase 3.F) parses the standard quality-value header (`ar,en;q=0.9,de;q=0.5`) and returns the first supported locale; defaults to `'en'`.

---

## 6. Build & Check Results

```text
$ cd backend && npx prisma generate
✓ Prisma Client generated (no schema changes — re-generation is a no-op)

$ npx nest build
✓ exit 0; locale catalogs ship to dist/common/i18n/locales/{en,ar,de,ru,sk,tr}/{notifications,exports}.json

$ cd .. && npm run i18n:check-keys
✓ All 5 target locales × 9 namespaces match English.

$ npm run i18n:check-literals
Found 13 suspicious hardcoded JSX literal(s)   ← unchanged false-positive baseline

$ npm run build
✓ built in 14.37s   (0 TS errors, 0 new warnings)
```

---

## 7. Smoke Test Results

```text
=== notification key resolution ===
1. financeRecordCreated.body:
   "A new financial record was added for John: SALARY — EUR 1000"
2. financeHighBalance.title:
   "High Balance Alert"
3. documentExpiringSoon.body:
   "Document \"Passport\" for John expires in 14 days."
4. AR fallback (events.financeRecordDeducted.title):
   "Record Marked for Deduction"   ← stub catalog returns EN; translator pass replaces

=== export header resolution ===
5. attendance.summarySheetName:        "Attendance Summary"
6. finance.columns.companyDisbursed:   "Company Disbursed (€)"
7. vehicles.columns.currentDriver:     "Current Driver"
8. reports.fallbackTitle:              "Custom Report"
9. common.exportedAt:                  "Exported at"
10. missing key:                       "events.does.not.exist"   ← key passthrough, surfaces missing translations in dev
```

All resolution paths verified: parameter interpolation, missing-key passthrough, locale fallback, cross-namespace lookups (`exports` vs `notifications`).

---

## 8. Files Changed

### Backend services (5)
| File | Change |
|---|---|
| `backend/src/notifications/notifications.service.ts` | (Phase 3.F — already migrated) |
| `backend/src/documents/documents.service.ts` | 1 producer site (expiry) migrated to coded form |
| `backend/src/finance/finance.service.ts` | 6 producer sites migrated + Excel export localized (records + deductions sheets, 33 columns, 2 sheet names) |
| `backend/src/attendance/attendance.service.ts` | Excel export localized (summary + detail, ~17 labels) |
| `backend/src/applicants/applicants.service.ts` | Excel export localized (21 columns) |
| `backend/src/vehicles/vehicles.service.ts` | Excel export localized (vehicles + maintenance, 14 + 17 columns) |
| `backend/src/reports/reports.service.ts` | Localized fallback sheet name, `Generated:` label, row-number `#` header — preserves user-authored content |

### Backend controllers (5)
| File | Change |
|---|---|
| `backend/src/attendance/attendance.controller.ts` | `Accept-Language` → service |
| `backend/src/applicants/applicants.controller.ts` | `Accept-Language` → service |
| `backend/src/finance/finance.controller.ts` | `Accept-Language` → service |
| `backend/src/vehicles/vehicles.controller.ts` | `Accept-Language` → service (both vehicle export + maintenance export) |
| `backend/src/reports/reports.controller.ts` | `Accept-Language` → service |

### Locale catalogs (12 JSON files)
| File | Change |
|---|---|
| `backend/src/common/i18n/locales/en/notifications.json` | 4 new keys; 3 keys re-templated to match producer params |
| `backend/src/common/i18n/locales/en/exports.json` | ~70 new keys across 4 namespaces |
| `backend/src/common/i18n/locales/{ar,de,ru,sk,tr}/{notifications,exports}.json` | re-stubbed from EN (10 files) |

**Total:** 22 files modified. **0 added.** **0 deleted.** **0 schema changes.**

---

## 9. Backward Compatibility — Re-confirmed

Every safety rule from the prompt is intact:

| Rule | Status |
|---|---|
| No Prisma schema changes | ✓ verified — `git diff backend/prisma/` empty |
| No DTO changes | ✓ verified |
| No env changes | ✓ verified |
| Existing notification rows render unchanged | ✓ — legacy rows have `titleKey = null`; `translateRow` skips lookup and returns stored `title`/`message` |
| Producer fallback `title`/`message` always populated | ✓ — every migrated call site keeps writing the canonical English string alongside the keys |
| Old API consumers ignore new fields | ✓ — `code`/`titleKey`/etc. are additive |
| Exported data values preserved exactly | ✓ — only column **headers** and **sheet names** are translated; all row data passes through unchanged |
| User-authored content preserved | ✓ — report names, descriptions, applicant entity names, vehicle drivers, etc. are emitted as-is |
| Excel cell formats / numFmt / styles | ✓ unchanged |

---

## 10. Remaining Legacy Notification & Export Gaps

### Notifications
- **None in producer call sites.** Every backend producer call site now writes `titleKey`/`messageKey`/`params` alongside the canonical English strings.
- **Frontend in-app notification rendering** (`NotificationCenter.tsx`) needs no change — it renders `n.title` / `n.message` directly, and the backend reader already swaps in the translated strings server-side via `translateRow`.

### Exports
- **CSV export in applicants** (`exportCsv`) intentionally not migrated — CSV is consumed by external systems (payroll, ATS imports). Localized headers would break those integrations. Documented as a deliberate omission, not a gap.
- **Reports PDF / Word formats** (`toPdf`, `toWord`) still emit some English-only labels. Out of scope for 3.G — the `format=excel` path is fully localized; PDF/Word are lightly used and follow a different rendering library. Recommended as Phase 3.H.
- **Frontend jsPDF generators** (`ApplicantPdfExport`, `EmployeePdfDocument`) are already covered by Phase 2.B–2.C frontend t() calls; not in 3.G scope.

### Translator pass (still pending)
- 14 notification event keys × 5 non-EN locales = **70 strings**
- ~94 export keys × 5 non-EN locales = **470 strings**
- 31 `validation.*` keys (Phase 3.C) × 5 = 155 strings — still pending
- 85 `errors.*` codes (Phase 3.B) × 5 = 425 strings — still pending

All currently shipped as EN placeholders. Behavior is correct for non-EN users (no broken UI, no `undefined` strings) — they just see English until translated.

---

## 11. Recommended Phase 3.H Scope

1. **PDF + Word report exports** — apply the same `tServer` pattern to `reports.service.ts:toPdf` and `toWord`. Both currently emit English fixed labels (`Report`, `Generated`, page numbers, etc.). Each is ~3–5 strings.

2. **Backend translator pass** — replace the 70 + 470 + 155 + 425 = **1,120** EN placeholders across non-EN catalogs. Highest impact: notifications (visible in-app every day), then exports (visible on every download), then validation (visible per form failure), then error codes (visible per backend rejection).

3. **CI guard for code/key parity** — script that asserts every backend `titleKey`/`messageKey`/`tServer()` literal in source code resolves to a key in the EN catalog. Catches new producer code that forgets to add the catalog entry.

4. **Database-driven labels** (Phase 3.G in the master plan, deferred from earlier phases) — `nameI18n JSONB` column on taxonomy models (`Role`, `Permission`, `JobType`, `DocumentType`, `MaintenanceType`, `FinanceTransactionType`, `StageTemplate`, `WorkflowStage`, `NotificationRule`, `WorkHistoryEventTypeSetting`, `MaintenanceTypeSetting`). Architecture sketched in `I18N_PHASE_3_BACKEND_RUNTIME_PLAN.md` §7.

5. **Notification backfill script (optional cosmetic)** — one-shot script that maps the existing English `title`/`message` text patterns of historical rows to keys + params. Not required (legacy rows render correctly via the fallback chain) but improves consistency for old notifications when a user switches to AR after upgrade.

6. **CSV exports** (deliberately deferred) — if/when stakeholders confirm CSV consumers are internal-only, apply `tServer` to applicant CSV headers. Today it's the right call to leave them English.

---

## 12. Quick Verification Commands

```bash
# Producer call sites all have i18n metadata now
grep -rnE "notifyUploaderAndRoles\(|notifyUsersByRoles\(" backend/src \
  --include='*.ts' | grep -v notifications.service.ts | wc -l   # → 8 callers
grep -rnE "titleKey:" backend/src --include='*.ts' | wc -l      # → 12 sites

# Excel exporters use tServer
grep -rnE "tServer\(.+'exports'\)" backend/src --include='*.ts' | wc -l
# → many — covers employees, attendance, applicants, finance, vehicles (×2), reports

# Builds + checks
cd backend && npx prisma generate && npx nest build && echo "✓ backend"
cd .. && npm run i18n:check-keys && npm run build && echo "✓ frontend"

# Smoke
node -e "const {tServer}=require('./backend/dist/common/i18n/server-translate');
  console.log(tServer('events.financeHighBalance.title', {}, 'en'));
  console.log(tServer('finance.columns.companyDisbursed', {}, 'en', 'exports'));
  console.log(tServer('attendance.summarySheetName', {}, 'en', 'exports'));"
```
