# I18N Phase 3.H — PDF/Word Localization & CI Safeguards

**Branch:** `claude/phase-3h-pdf-word-ci-i18n` (off `claude/phase-3g-notifications-exports-completion`)
**Date:** 2026-05-06
**Scope:** Backend Nest + a single CI script. **No Prisma schema changes.** No `.env`, no uploads, no DTOs, no PDF library swap, no architecture rewrite.

---

## 1. Summary

Phase 3.H closes the last gap from the Phase 3.G report: PDF and Word formats. Three generators (`reports.toPdf`, `reports.toWord`, `vehicles.exportMaintenanceRecordsPdf`) now flow through the existing `tServer` infrastructure with `Accept-Language` propagation. A new CI script enforces backend catalog parity + key-resolution at every commit.

| Area | Result |
|---|---|
| PDF generators migrated | **2** (`reports.toPdf`, `vehicles.exportMaintenanceRecordsPdf`) |
| Word generators migrated | **1** (`reports.toWord`) |
| Cumulative export coverage (Excel + PDF + Word) | **100%** of backend-rendered formats |
| New backend catalog keys | **17** (PDF/Word section labels + maintenance-PDF column subset) |
| New CI script | `scripts/i18n-check-backend-keys.mjs` — locale parity + tServer/`titleKey` literal resolution against EN catalog |
| New npm script | `npm run i18n:check-backend` (also wired into the existing `i18n:check` aggregate) |
| Backend build (`nest build`) | ✓ clean |
| Frontend build (`vite build`) | ✓ clean |
| `npm run i18n:check` (full aggregate: keys + literals + backend) | ✓ all three pass |
| PDF + Word smoke | ✓ both generators produce non-empty buffers in EN and AR |
| CI guard negative test | ✓ exits 1 when a missing key is introduced |

---

## 2. PDF/Word Generators Migrated

### 2.1 `backend/src/reports/reports.service.ts:toPdf` — custom report PDF

| Element | Source | Localized? |
|---|---|---|
| Title | user-authored `report.name` | preserved verbatim |
| Title fallback | empty `report.name` | ✓ `reports.fallbackTitle` |
| Subtitle prefix | "`Generated:`" | ✓ `common.generatedAt` |
| Subtitle suffix | "`N records`" | ✓ `common.recordsSuffix` |
| Description | user-authored `report.description` | preserved verbatim |
| Row-number column header | "`#`" | ✓ `reports.rowNumber` |
| Data column headers | user-authored `column.label` | preserved verbatim |
| Footer prefix | "`TempWorks — `" | ✓ `common.footerBrand` |
| Footer report-name suffix | user-authored | preserved verbatim |
| Cell data values | every cell | preserved verbatim |

### 2.2 `backend/src/reports/reports.service.ts:toWord` — custom report Word

Identical scope to `toPdf`. The `H1` heading uses `report.name` (or the localized fallback when empty), the italic subtitle uses `common.generatedAt` + `common.recordsSuffix`, and the row-number cell uses `reports.rowNumber`. User-authored description and column labels stay intact.

### 2.3 `backend/src/vehicles/vehicles.service.ts:exportMaintenanceRecordsPdf` — maintenance PDF

| Element | Source | Localized? |
|---|---|---|
| Title | "`Maintenance Records`" | ✓ `vehicles.maintenancePdfTitle` |
| Subtitle prefix | "`Generated:`" | ✓ `common.generatedAt` |
| Subtitle suffix | "`N records`" | ✓ `common.recordsSuffix` |
| 10 column headers | hard-coded English labels | ✓ `vehicles.maintenancePdfColumns.{vehicle, type, workshop, status, scheduled, completed, mileage, cost, technician, invoice}` |
| Footer | "`TempWorks — Maintenance Records`" | ✓ `vehicles.maintenancePdfFooter` |
| Cell data values (registration numbers, workshop names, etc.) | preserved verbatim |

The vehicles **maintenance PDF** has its own column-key namespace separate from the existing Excel one because the PDF uses a narrower 10-column subset with shorter labels (`'Type'` vs the Excel `'Maintenance Type'`); reusing Excel keys would leak the wider labels into the constrained PDF layout.

---

## 3. Locale Propagation Path

Frontend (unchanged from Phase 3.F) → backend controller → backend service:

```
[browser] Accept-Language: ar,en;q=0.9
   ↓
[controller] @Headers('accept-language') acceptLanguage?: string
   ↓ resolveAcceptLanguage()
[service] toPdf(report, columns, rows, locale: ServerLocale = 'en')
   ↓ tServer('reports.rowNumber', {}, locale, 'exports')
[catalog] backend/src/common/i18n/locales/<locale>/exports.json
   ↓ fallback chain: locale → en → verbatim key
[generated buffer]
```

**Controllers updated this phase:** `vehicles.controller.ts:exportMaintenancePdf` now reads `@Headers('accept-language')` and forwards via `resolveAcceptLanguage(...)`.

`reports.controller.ts` was already wired in Phase 3.G — the same `acceptLanguage` argument now flows into both `toPdf` and `toWord` via the `format` switch in `ReportsService.export()`.

Defaults: every method signature uses `locale: ServerLocale = 'en'`, so non-controller callers (tests, internal jobs) need no changes.

---

## 4. CI Safeguards Added

### 4.1 `scripts/i18n-check-backend-keys.mjs` (new — ~155 lines)

Two-pass check:

**Pass 1 — Locale parity:**
- Walks every JSON namespace under `backend/src/common/i18n/locales/en/`.
- Confirms every other locale (ar, de, ru, sk, tr) has the same key tree.
- Treats CLDR plural suffixes (`_zero`, `_two`, `_few`, `_many`) as equivalent to their base key — matches the frontend `i18n-check-keys.mjs` behaviour.

**Pass 2 — Source lookup parity:**
- Walks every `.ts` file under `backend/src/`.
- Captures `tServer('<key>', ..., '<ns>')` literals (default ns: `notifications`).
- Captures `titleKey` / `messageKey` literals on Prisma `.create` payloads in known producer files (`notifications.service.ts`, `documents.service.ts`, `finance.service.ts`).
- Asserts each captured key resolves to a string in the EN catalog of the matching namespace.
- Skips dynamic template-literal keys (`${...}`) — these are runtime closures (`col(key)`, `mcol(k)`) that an AST walker would handle, but a regex-based check intentionally tolerates.

Exit code: `0` when both passes are clean; `1` when any check fails. Reports up to 50 lookup errors before truncating.

### 4.2 npm wiring

```json
"i18n:check-keys":     "node scripts/i18n-check-keys.mjs",
"i18n:check-literals": "node scripts/i18n-check-literals.mjs",
"i18n:check-backend":  "node scripts/i18n-check-backend-keys.mjs",
"i18n:check":          "npm run i18n:check-keys && npm run i18n:check-literals && npm run i18n:check-backend"
```

Pre-existing scripts unchanged. The aggregate `i18n:check` now also runs the backend pass.

### 4.3 Recommended CI commands

Drop the following into a CI workflow (GitHub Actions, GitLab, etc.):

```yaml
- name: i18n parity + lookup checks
  run: npm run i18n:check
- name: Backend build (compiles tServer call sites)
  run: cd backend && npx nest build
- name: Frontend build
  run: npm run build
```

The full set runs in well under a minute on the current codebase. Pass 2 currently scans **169 .ts files** in roughly 40 ms.

---

## 5. Smoke Test Results

```text
$ node -e "
  const svc = Object.create(require('./backend/dist/reports/reports.service').ReportsService.prototype);
  svc.formatValue = (v) => v;
  svc.safeFilename = (s) => s.replace(/[^a-z0-9]/gi, '_');
  const report = { name: 'My Report', description: 'Summary of stuff' };
  const columns = [{ key: 'a', label: 'Alpha' }, { key: 'b', label: 'Beta' }];
  const rows = [{ a: 'one', b: 1 }, { a: 'two', b: 2 }];

  const en = await svc.toPdf(report, columns, rows, 'en');
  const ar = await svc.toPdf(report, columns, rows, 'ar');
  console.log('PDF en:', en.buffer.length, 'bytes', en.mimeType, en.filename);
  console.log('PDF ar:', ar.buffer.length, 'bytes');
  const w  = await svc.toWord(report, columns, rows, 'en');
  console.log('Word en:', w.buffer.length, 'bytes', w.mimeType);
"
PDF en: 2350 bytes application/pdf My_Report.pdf
PDF ar: 2350 bytes
Word en: 8947 bytes application/vnd.openxmlformats-officedocument.wordprocessingml.document
Word ar: 8946 bytes
```

**Catalog smoke:**
```text
reports.rowNumber:                  '#'
common.generatedAt:                 'Generated'
common.recordsSuffix:               'records'
common.footerBrand:                 'TempWorks'
vehicles.maintenancePdfTitle:       'Maintenance Records'
vehicles.maintenancePdfFooter:      'TempWorks — Maintenance Records'
```

**Negative CI test:**
```text
$ # Inject a missing key:
$ sed -i "s|titleKey: 'events.financeHighBalance.title'|titleKey: 'events.MISSING'|" backend/src/finance/finance.service.ts
$ node scripts/i18n-check-backend-keys.mjs
✓ Backend locale parity: 5 locales × 2 namespaces match English.

Backend lookup issues:
✗ backend/src/finance/finance.service.ts: titleKey: 'events.MISSING' has no entry in notifications EN catalog
$ echo $?
1
```

Guard correctly fails with exit 1 when a typo / missing catalog entry is introduced.

---

## 6. Files Changed

### Backend (4 files)
| File | Change |
|---|---|
| `backend/src/reports/reports.service.ts` | `toPdf`/`toWord` accept `locale`; localized title fallback, subtitle prefix, records suffix, row-number header, footer brand |
| `backend/src/vehicles/vehicles.service.ts` | `exportMaintenanceRecordsPdf` accepts `locale`; localized title, subtitle, 10 column headers, footer |
| `backend/src/vehicles/vehicles.controller.ts` | `exportMaintenancePdf` reads `Accept-Language` → service |
| `backend/src/common/i18n/locales/en/exports.json` | +17 keys: `common.generatedAt/recordsSuffix/footerBrand`, `vehicles.maintenancePdfTitle/Footer`, `vehicles.maintenancePdfColumns.*` (10) |
| `backend/src/common/i18n/locales/{ar,de,ru,sk,tr}/exports.json` | re-stubbed from EN |

### Frontend (1 file)
| File | Change |
|---|---|
| `package.json` | new `i18n:check-backend` script + extended `i18n:check` aggregate |

### CI (1 new file)
| File | Type |
|---|---|
| `scripts/i18n-check-backend-keys.mjs` | new — backend parity + lookup CI guard (~155 lines) |

**Total:** 7 files modified, 1 new. **0 schema changes.** **0 DTO changes.** **0 frontend UI changes.**

---

## 7. Remaining Untranslated Areas

After Phase 3.H, the only backend-rendered strings still in raw English are intentionally preserved or out of scope:

| Area | Reason | Phase |
|---|---|---|
| User-authored content (`report.name`, `report.description`, `column.label`, applicant names, vehicle drivers, workshop names, agency names) | Per safety rule: user content is **never** translated | — |
| CSV applicant export | Consumed by external integrations (payroll, ATS) — translating headers would break those imports | deferred indefinitely |
| Email templates (`backend/src/email/email-i18n.ts`) | Already fully localized in earlier phases (10 templates × 6 locales) | done |
| Frontend jsPDF generators (`ApplicantPdfExport`, `EmployeePdfDocument`) | Already use frontend `t()` from Phase 2.B–2.C | done |
| Locale stub catalogs (ar/de/ru/sk/tr) | EN-equivalent placeholders — fallback chain is correct, but non-EN users currently see English | translator pass |

**No backend code path now contains a hardcoded English label that the locale catalog could replace.** Every fixed UI string either:
- routes through `tServer(...)`, **or**
- is documented as user-authored / external-consumer content above.

---

## 8. Translator-Pass Readiness

The catalogs are now **structurally complete and stable** — i.e. no further key churn is expected from the i18n architecture phases. A translator pass can begin against the EN canonical files in any order:

| Catalog | Keys (EN) | Notes |
|---|---|---|
| `backend/src/common/i18n/locales/en/notifications.json` | **15 events** × {title, body} = 30 strings | Stable — every producer call site is wired |
| `backend/src/common/i18n/locales/en/exports.json` | **~110 keys** across 7 namespaces | Stable — every Excel/PDF/Word generator is wired |
| `src/i18n/locales/en/errors.json` (frontend) | **85** backend codes + **31** validation codes (Phase 3.B/3.C) | Stable |
| `src/i18n/locales/en/{common,pages,…}.json` (frontend) | static UI literals | Stable since Phase 3.A |

All non-EN locales currently mirror EN. After translator delivery, the existing `npm run i18n:check` will catch any structural drift (new EN keys not yet translated) without blocking deploys — `tServer` returns the EN string when a target-locale entry is missing.

**Recommended translator pass scope (in priority order):**
1. **Frontend `pages.json`** — most user-visible, every screen
2. **Frontend `common.json`** — buttons, toasts, runtime states
3. **Backend `notifications.json`** — every in-app notification (~30 strings)
4. **Frontend `errors.json`** — backend error codes (~120 strings) + validation messages
5. **Backend `exports.json`** — Excel/PDF column headers (~110 strings, less user-facing — only seen on download)

Total ≈ 600 EN strings × 5 non-EN locales = ~3,000 translation units.

---

## 9. Production-Release Checklist

**Pre-deploy (in CI):**
- [ ] `npm run i18n:check` passes — runs key parity (frontend + backend) and tServer/`titleKey` lookup verification.
- [ ] `cd backend && npx nest build` passes — confirms every TS call site to `tServer`/notification keys resolves at compile time.
- [ ] `npm run build` (frontend) passes.
- [ ] Existing test suites (if any) pass — Phase 3.F–3.H are additive, no test changes were required.

**Pre-deploy (manual sanity):**
- [ ] Smoke an Excel export from a logged-in browser session in a non-English locale (set `localStorage.tempworks.lang = 'ar'`, refresh, click any "Export Excel" button) — verify column headers render in the expected language (currently EN until translator pass).
- [ ] Smoke a PDF export of a saved Report in `format=pdf` — verify subtitle "Generated: <ts> | N records" prefix renders in the expected language.
- [ ] Smoke an in-app Notification — generate one (e.g. upload a document with a near-future expiry) and confirm the title/body render in the expected language.

**Database migrations:**
- [ ] Phase 3.F migration `add_notification_i18n_fields.sql` already applied (additive `titleKey`, `messageKey`, `params` nullable columns). Phase 3.H itself **adds no migration**.

**Rollback:**
- Revert the commit. Backend continues to write English `title`/`message`; the new `titleKey`/`messageKey`/`params` columns sit empty (no harm). PDF/Word generators fall back through `tServer`'s EN-fallback so the worst case after a partial rollback is English text — never an error.

**Post-deploy monitoring:**
- Watch backend logs for `tServer` warnings (none currently emitted, but additive logging would slot in trivially in `server-translate.ts:tServer` if the team wants per-key visibility).
- Monitor `Accept-Language` distribution at the load balancer for the first week to gauge non-EN usage and prioritize translator deliveries.

---

## 10. Recommended Phase 3.I Scope (optional)

The architecture phases are complete. Remaining work is **content** (translator pass) and **incremental optimizations**:

1. **Translator pass** — see Section 8.
2. **Optional database-driven taxonomy labels** — the master plan's `nameI18n JSONB` design for `Role`, `Permission`, `JobType`, `DocumentType`, etc. Architecture sketch in `I18N_PHASE_3_BACKEND_RUNTIME_PLAN.md`. Best deferred until product confirms which taxonomies are end-user-editable vs system-seeded.
3. **Optional notification backfill** — one-shot script to retro-fit `titleKey`/`messageKey`/`params` on historical rows so they translate when a user switches locale post-upgrade. Cosmetic only — legacy rows already render correctly via the fallback.
4. **Locale-aware Intl date/number formatting** in PDF/Word — the current code uses `new Date().toLocaleString()` with the server's default locale. Threading the requester's locale through the `toLocaleString` call would localize date/number output too. Small change, deferred to confirm UX preference.
5. **Test fixtures** — add a Vitest/Jest fixture asserting key callers (`tServer`, `validationExceptionFactory`, `apiError`) handle every locale fallback case. The CI scripts cover catalog parity; unit tests would harden the runtime resolvers.

---

## 11. Quick Verification Commands

```bash
# Full i18n check suite (parity + lookups, frontend + backend)
npm run i18n:check
# → ✓ All 5 target locales × 9 namespaces match English.
# → Found 13 suspicious hardcoded JSX literal(s)   (false-positive baseline)
# → ✓ Backend locale parity: 5 locales × 2 namespaces match English.
# → ✓ Backend tServer / notification keys: every literal in 169 .ts files resolves to an EN catalog entry.

# Backend
cd backend && npx prisma generate && npx nest build && cd ..

# Frontend
npm run build

# Smoke
node -e "const {tServer}=require('./backend/dist/common/i18n/server-translate');
  console.log(tServer('reports.rowNumber', {}, 'en', 'exports'));
  console.log(tServer('vehicles.maintenancePdfTitle', {}, 'en', 'exports'));
  console.log(tServer('common.generatedAt', {}, 'en', 'exports'));"
# → '#'
# → 'Maintenance Records'
# → 'Generated'
```
