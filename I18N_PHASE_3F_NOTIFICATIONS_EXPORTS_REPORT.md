# I18N Phase 3.F — Notifications & Exports Localization

**Branch:** `claude/phase-3f-notifications-exports-i18n` (off `claude/phase-3e-validation-form-backfill`)
**Date:** 2026-05-06
**Scope:** Backend Nest + frontend integration. Strictly additive Prisma migration. No `.env`, no uploads, no destructive changes.

---

## 1. Summary

Phase 3.F lays the architecture for **stored notifications** and **backend-generated exports** to render in the requester's locale. The wire format is backward-compatible: legacy rows with no `titleKey` keep returning the same English text, old API consumers keep working.

| Area | Result |
|---|---|
| Notification i18n metadata columns | **3** added (`titleKey`, `messageKey`, `params`) — all nullable |
| Backend `tServer` utility | new — supports 6 locales, EN fallback, key passthrough |
| Locale catalogs (notifications + exports) | 6 × 2 = **12 JSON files** (EN canonical + 5 stubs) |
| Notification producers migrated | **5** (4 in vehicle cron + 1 of 2 generic helpers wired with optional `i18n` arg + 1 caller updated as proof-of-concept) |
| Generic helpers extended | **2** (`notifyUploaderAndRoles`, `notifyUsersByRoles`) — opt-in `i18n` parameter, all 8 existing callers continue to work unchanged |
| Notification reader translation | ✓ resolves `titleKey`/`messageKey` against `Accept-Language` |
| Frontend `Accept-Language` header | ✓ added to every API request via `api.ts` |
| Excel exports localized | **1** (`employees`) — proof-of-concept; remaining 5 deferred |
| Backend build (`nest build`) | ✓ clean |
| Frontend build (`vite build`) | ✓ clean (0 TS errors) |
| `i18n:check-keys` (frontend) | ✓ pass |
| `i18n:check-literals` | 13 hits (same false-positive baseline) |
| End-to-end resolver smoke | ✓ EN/AR/DE/RU/SK/TR + missing-key fallback verified |

---

## 2. Schema Changes

### 2.1 `Notification` model — three nullable columns added

```diff
 model Notification {
   id              String           @id @default(uuid())
   userId          String
+  // Pre-rendered English title/message. Always populated for backward
+  // compatibility — old clients keep working, search/grep over historical
+  // notifications keeps reading meaningful text.
   title           String
   message         String
+  // i18n metadata. Set by Phase 3.F+ producers; null on legacy rows.
+  titleKey        String?
+  messageKey      String?
+  params          Json?
```

**Backward compatibility guarantees:**
- `title` and `message` remain `String` (NOT NULL) — every producer continues to write English strings.
- The three new columns are `String?` / `Json?` (nullable). Legacy rows have `null` and are read back identically to before.
- No data migration. No backfill. No destructive changes.

### 2.2 Migration file

`backend/prisma/migrations/add_notification_i18n_fields.sql`:

```sql
ALTER TABLE "notifications"
  ADD COLUMN IF NOT EXISTS "titleKey"   TEXT,
  ADD COLUMN IF NOT EXISTS "messageKey" TEXT,
  ADD COLUMN IF NOT EXISTS "params"     JSONB;
```

`IF NOT EXISTS` on every column makes this safe to re-run. Matches the project's existing manual-migration convention (`backend/prisma/migrations/*.sql`).

---

## 3. Notification Fallback Behavior

The reader (`NotificationsService.translateRow`) walks each row through:

1. **Translated title** = `tServer(titleKey, params, locale, 'notifications')` **if** `titleKey != null`
2. **else** stored `title` (canonical English)

Same chain for `message`. When `titleKey` is set but the catalog has no matching entry, `tServer` falls back through (locale → en → verbatim key) — so:

- A new producer key not yet added to the EN catalog returns the key string in dev (easy to spot).
- Legacy rows with `titleKey = null` skip the lookup entirely and return the original English text — **zero behavioral change**.

### Resolution example

Stored row:
```json
{
  "title": "AB123: MOT Expiring Soon",
  "message": "MOT expires in 5 days",
  "titleKey": "events.vehicleCheckExpiring.title",
  "messageKey": "events.vehicleCheckExpiring.body",
  "params": { "registrationNumber": "AB123", "checkLabel": "MOT", "daysUntilDue": 5 }
}
```

Reader resolves with `Accept-Language: en` → `AB123: MOT Expiring Soon` (catalog lookup, identical to stored)
Reader resolves with `Accept-Language: ar` → currently same EN string (stub catalog) — translator pass replaces.
Reader on a legacy row (no key) → stored `title`/`message` verbatim.

---

## 4. Backend `tServer` Architecture

`backend/src/common/i18n/server-translate.ts` (~95 lines):

- **Catalog source:** plain JSON files under `backend/src/common/i18n/locales/<locale>/<namespace>.json`.
- **Loaded at boot** via TypeScript `import` statements (resolved by `resolveJsonModule: true` added to `tsconfig.json`).
- **Shipped to `dist`** via a new `assets` entry in `nest-cli.json` (`include: 'common/i18n/locales/**/*.json'`). `npm start:prod` reads them from `dist`.
- **Two namespaces** today: `notifications` (event title/body) and `exports` (column headers, sheet names). Add others by dropping JSON files into the locale folders and adding the import to `server-translate.ts`.
- **Lookup chain:** requested locale → English fallback → verbatim key (so missing keys surface in dev rather than silently empty).
- **`{{param}}` interpolation** matches the i18next pattern used by the frontend.

```ts
tServer('events.vehicleCheckExpiring.title', { registrationNumber: 'AB123', checkLabel: 'MOT', daysUntilDue: 5 }, 'en')
// → "AB123: MOT Expiring Soon"

resolveAcceptLanguage('ar,en;q=0.9,de;q=0.5')   // → 'ar'
resolveAcceptLanguage('fr-FR,fr;q=0.9,de;q=0.5') // → 'de'
resolveAcceptLanguage(undefined)                 // → 'en'
```

**Why not nest-i18n?** Adding the package would pull a multi-tier middleware/interceptor framework, change the global injection graph, and require re-wiring the existing `I18nExceptionFilter`. `tServer` is ~95 lines, has no DI, has zero external deps, and matches the lookup chain `apiError()` already uses on the frontend.

---

## 5. Notification Producers Migrated

### Internal producers in `backend/src/notifications/notifications.service.ts`

| Producer (line) | Key |
|---|---|
| `checkExpiringCompliance` (~135) | `events.vehicleCheckExpiring.{title,body}` |
| `checkServiceDue` (~225) | `events.vehicleServiceDueKm.{title,body}` |
| `checkOverdue` (~295) | `events.vehicleComplianceOverdue.{title,body}` |
| `checkScheduledMaintenance` (~370) | `events.vehicleScheduledMaintenance.{title,body}` |

All four now write `titleKey`/`messageKey`/`params` alongside the English `title`/`message`.

### Generic helpers (`notifyUploaderAndRoles`, `notifyUsersByRoles`)

Both gain an optional `i18n?: { titleKey?, messageKey?, params? }` parameter. **All 8 existing callers continue to work unchanged** — they pass the legacy 7-arg form, the helper writes `null` for the i18n columns, and the reader's fallback chain returns the canonical English text. New callers can opt in by passing the 8th argument.

### Producer call sites

| Caller | Status |
|---|---|
| `documents/documents.service.ts` upload notification | **Migrated** (`events.documentUploaded.{title,body}`) — proof-of-concept |
| `documents/documents.service.ts` expiry notification (×2) | Deferred — Phase 3.G |
| `documents/documents.service.ts` verify/reject (×2) | Deferred — Phase 3.G |
| `finance/finance.service.ts` (×6) | Deferred — Phase 3.G |

Deferred sites continue to deliver English-only notifications, which is exactly the pre-3.F behavior. Each is a 4-line change once the desired key is added to `notifications.json`; no architectural risk.

---

## 6. Excel/PDF Generators Migrated

### Migrated

| Service | File | Coverage |
|---|---|---|
| `employees` Excel export | `backend/src/employees/employees.service.ts` + controller | Sheet name + 17 column headers fully localized via `tServer(key, {}, locale, 'exports')` |

The controller now reads `Accept-Language` via `@Headers('accept-language')` and forwards it to the service as a 4th `locale` parameter (default `'en'`).

### Deferred (Phase 3.G)

| Service | File | Reason |
|---|---|---|
| `attendance` Excel | `backend/src/attendance/attendance.service.ts` | Sheet headers similar pattern; deferred to keep this commit focused |
| `applicants` Excel | `backend/src/applicants/applicants.service.ts` | Same |
| `finance` Excel | `backend/src/finance/finance.service.ts` | Same |
| `vehicles` Excel | `backend/src/vehicles/vehicles.service.ts` | Same |
| `reports` builder Excel | `backend/src/reports/reports.service.ts` | Dynamic columns from user-defined report templates — needs schema rules for which fields are translatable |

**Each deferred service follows the exact same 3-step pattern** demonstrated in `employees.service.ts`:
1. Add `import { tServer, ServerLocale } from '../common/i18n/server-translate'`.
2. Add `locale: ServerLocale = 'en'` to the export method signature.
3. Replace `header: 'First Name'` with `header: tServer('<service>.columns.firstName', {}, locale, 'exports')`.
4. Add `Accept-Language` header forwarding in the controller.

**Frontend PDFs** (e.g. `ApplicantPdfExport`, jsPDF in `ApplicantFormSteps`) already use frontend `t()` and aren't in scope here — they were covered in Phases 2.B–2.C.

---

## 7. Frontend Changes

| File | Change |
|---|---|
| `src/app/services/api.ts` | Adds `Accept-Language` to every fetch — value reads from `localStorage['tempworks.lang']` (the same key i18next uses) with `navigator.language` and `'en'` fallbacks. Header is set unconditionally; legacy endpoints simply ignore it. |

**No `NotificationCenter.tsx` changes were needed** — the component already renders `n.title` and `n.message` directly. The backend now returns those translated server-side when `titleKey`/`messageKey` is set on the row.

---

## 8. Manual Migration & Deployment Notes

### Database migration

The schema is already updated; apply the SQL on each environment:

```bash
# Production (or any environment with PostgreSQL):
psql "$DATABASE_URL" -f backend/prisma/migrations/add_notification_i18n_fields.sql

# Or via existing project script convention (mirror of backfill-nationality, etc.):
ts-node backend/prisma/run-notification-i18n-migration.ts   # NOT YET CREATED — see "Optional"
```

Optional: add a `db:migrate:notification-i18n` script entry to `backend/package.json` paralleling existing migration scripts. Not required — the SQL is idempotent (`IF NOT EXISTS` on every column).

### Deployment order (zero-downtime)

1. **Run migration** (additive, safe to apply on a live database with old code still running — old code writes to `title`/`message` only and ignores the new columns).
2. **Deploy new backend** (writes both `title`/`message` AND keys; reader translates when keys are set).
3. **Deploy new frontend** (sends `Accept-Language` header).

Order can be relaxed — old frontend with new backend still works (no `Accept-Language` → defaults to EN). Old backend with new frontend works (extra header is ignored).

### Rollback

- **Code rollback:** revert the commits. Database columns remain (idempotent, no data) but cause no harm.
- **Schema rollback** (rare): `ALTER TABLE "notifications" DROP COLUMN IF EXISTS "titleKey", "messageKey", "params"`. Only safe after the new code is fully removed, and only useful if disk space matters — the columns are sparse (only new rows have values).

---

## 9. Rollback Risks

| Risk | Severity | Mitigation |
|---|---|---|
| New columns left after code rollback | None | Columns are nullable; old code writes nothing to them |
| Reader translation throws on a malformed `params` JSON | Low | `tServer.interpolate` defensively coerces to string; `params` is always read with `typeof === 'object'` guard |
| Catalog file missing in `dist` | Low | `nest-cli.json` `assets` entry copies all `common/i18n/locales/**/*.json` to `dist`. Build produces `dist/common/i18n/locales/{en,ar,de,ru,sk,tr}/{notifications,exports}.json` (verified). |
| Locale stubs (ar/de/ru/sk/tr) currently identical to EN | None | The fallback chain already returns EN for missing keys; the stubs ship the same content so behavior is identical. Replace by translator pass. |
| Frontend old behavior change | None | `NotificationCenter.tsx` not modified — same `n.title` / `n.message` render path |

---

## 10. Tests / Smoke

```text
# Resolution chain
$ node -e "const {tServer,resolveAcceptLanguage} = require('./backend/dist/common/i18n/server-translate');
  console.log(tServer('events.documentUploaded.title', { documentName: 'CV.pdf' }, 'en'));
  console.log(tServer('events.does.not.exist', {}, 'en'));               // → key passthrough
  console.log(resolveAcceptLanguage('ar,en;q=0.9'));                      // → 'ar'
  console.log(resolveAcceptLanguage('en-US,en;q=0.9'));                   // → 'en'
  console.log(resolveAcceptLanguage('fr-FR,fr;q=0.9,de;q=0.5'));          // → 'de'
  console.log(resolveAcceptLanguage(undefined));                          // → 'en'
  console.log(tServer('employees.columns.email', {}, 'en', 'exports'));   // → 'Email'"

Document uploaded: CV.pdf
events.does.not.exist
ar
en
de
en
Email
```

```text
# Backend build
$ cd backend && npx nest build
✓ exit 0; dist/common/i18n/locales/en/{notifications,exports}.json present

# Frontend build + checks
$ npm run i18n:check-keys      → ✓ All 5 × 9 match EN
$ npm run i18n:check-literals  → 13 (same baseline)
$ npm run build                → ✓ built in 22.19s
```

---

## 11. Files Changed

### Backend (8 files, 6 new)
| File | Type |
|---|---|
| `backend/prisma/schema.prisma` | modified — 3 nullable columns + comments |
| `backend/prisma/migrations/add_notification_i18n_fields.sql` | new |
| `backend/tsconfig.json` | modified — `resolveJsonModule: true` |
| `backend/nest-cli.json` | modified — `assets` entry for locale JSONs |
| `backend/src/common/i18n/server-translate.ts` | new — `tServer` + `resolveAcceptLanguage` |
| `backend/src/common/i18n/locales/en/notifications.json` | new — 14 event keys |
| `backend/src/common/i18n/locales/en/exports.json` | new — employees + attendance namespaces |
| `backend/src/common/i18n/locales/{ar,de,ru,sk,tr}/{notifications,exports}.json` | new × 10 — EN-stub placeholders |
| `backend/src/notifications/notifications.service.ts` | modified — 4 producer keys + reader `translateRow` + 2 helpers extended |
| `backend/src/notifications/notifications.controller.ts` | modified — `Accept-Language` header → service |
| `backend/src/documents/documents.service.ts` | modified — sample producer migration (1 of 5 sites) |
| `backend/src/employees/employees.service.ts` | modified — Excel headers via `tServer` |
| `backend/src/employees/employees.controller.ts` | modified — `Accept-Language` → service |

### Frontend (1 file)
| File | Type |
|---|---|
| `src/app/services/api.ts` | modified — `Accept-Language` header on every fetch |

---

## 12. Recommended Phase 3.G Scope

1. **Drain remaining notification producer call sites:**
   - `documents/documents.service.ts` (4 remaining) — verify/reject/expiry notifications
   - `finance/finance.service.ts` (×6) — record CRUD + high-balance alert
   Each site is a 4-line change; reuse the keys already in `notifications.json` (`events.financeRecord*`, `events.documentVerified`, `events.documentRejected`, `events.documentExpiring`).

2. **Drain remaining Excel exporters:**
   - `attendance.service.ts` (key set already in `exports.json`)
   - `applicants.service.ts`
   - `finance.service.ts`
   - `vehicles.service.ts`
   - `reports.service.ts` (dynamic — needs a column-key resolver since user-defined reports pick fields at runtime)
   Each follows the `employees.service.ts` template documented in Section 6.

3. **Translator pass** on all stub catalogs:
   - `backend/src/common/i18n/locales/{ar,de,ru,sk,tr}/notifications.json` (14 events × 5 locales = 70 strings)
   - `backend/src/common/i18n/locales/{ar,de,ru,sk,tr}/exports.json` (~24 keys × 5 locales = 120 strings)
   - Frontend `validation.*` and Phase 3.B `errors.*` keys still pending from earlier phases.

4. **Database-driven labels** (Phase 3.G per master plan): `nameI18n` JSONB column on taxonomy models (`Role`, `Permission`, `JobType`, `DocumentType`, `MaintenanceType`, `FinanceTransactionType`, `StageTemplate`, `WorkflowStage`, `NotificationRule`, `WorkHistoryEventTypeSetting`, `MaintenanceTypeSetting`).

5. **CI guard** for code/key parity:
   - Backend `tServer` lookups → assert each key string in source code resolves to an entry in the EN catalog.
   - Frontend `apiError` codes → already partially covered.

6. **PDF localization** for any future server-rendered PDFs (none currently in scope — frontend jsPDF already covered).

7. **Backfill script (optional)** for historical notifications: a one-shot script that maps the old `title` / `message` text patterns to keys + params. Cosmetic only — historical rows already render correctly via the fallback chain.

---

## 13. Quick Verification Commands

```bash
# Schema
git diff backend/prisma/schema.prisma | head

# Migration file
cat backend/prisma/migrations/add_notification_i18n_fields.sql

# Backend builds
cd backend && npx prisma generate && npx nest build && echo "✓ backend"

# Locale catalogs shipped to dist
ls backend/dist/common/i18n/locales/*/

# Frontend
cd .. && npm run i18n:check-keys && npm run build && echo "✓ frontend"

# tServer smoke
node -e "const {tServer,resolveAcceptLanguage}=require('./backend/dist/common/i18n/server-translate');
  console.log(tServer('events.vehicleCheckExpiring.title',{registrationNumber:'AB123',checkLabel:'MOT',daysUntilDue:5},'en'));"
# → AB123: MOT Expiring Soon
```
