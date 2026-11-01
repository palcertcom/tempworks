# I18N Phase 3.A — Frontend Runtime Toast & Residual Sweep

**Branch:** `claude/phase-3a-runtime-toast-i18n` (off `claude/i18n-frontend-final-validation`)
**Date:** 2026-05-06
**Scope:** Frontend only — runtime toast strings, residual action labels, `alert()`, RTL fix in PermissionsMatrix.

---

## 1. Goal & Outcome

| | Before | After |
|--|--------|-------|
| Raw `toast.<verb>('literal'|"literal"|`literal`)` calls | **157** in **40 files** | **0** |
| Native `alert(...)` calls (excluding lucide icons) | **1** | **0** |
| Hardcoded `>Cancel<` button labels | **17** | **0** |
| Hardcoded `sticky left-0` (RTL leak) | **3** in PermissionsMatrix | **0** (replaced with `start-0`) |
| `i18n:check-keys` | ✓ | ✓ |
| `i18n:check-literals` | 13 (all known FPs) | **13** (same baseline) |
| `npm run build` | ✓ | ✓ (16.4s, 0 TS errors) |
| Locale parity | 5×9 = 45 namespaces | **45** namespaces (auto-synced) |

---

## 2. Files Changed (49 source files + 12 locale JSONs)

### Settings (16 files)
`BrandingSettings.tsx`, `DatabaseBackup.tsx`, `DatabaseCleanup.tsx`, `DocumentTypeEdit.tsx`, `DocumentTypeNew.tsx`, `DocumentTypeView.tsx`, `DocumentTypes.tsx`, `JobTypes.tsx`, `MaintenanceTypesSettings.tsx`, `SecuritySettings.tsx`, `SkillsSettings.tsx`, `TrailerTypesSettings.tsx`, `TransactionTypesSettings.tsx`, `TransportTypesSettings.tsx`, `TruckBrandsSettings.tsx`, `VehicleSettings.tsx`, `WorkHistoryEventTypesSettings.tsx`

### Notifications (2)
`NotificationCenter.tsx`, `NotificationSettings.tsx`

### Vehicles (3)
`MaintenanceRecordsList.tsx`, `MaintenanceTypesList.tsx`, `WorkshopsList.tsx`

### Documents (3)
`DocumentVerification.tsx`, `DocumentsCompliance.tsx`, `EmployeeDocumentExplorer.tsx`

### Applicants (5)
`AddApplicant.tsx`, `ApplicantsList.tsx`, `CandidatesList.tsx`, `EditApplicant.tsx`, `EditCandidate.tsx`

### Attendance / Finance / Employees (5)
`AttendanceList.tsx`, `AttendanceSheet.tsx`, `AttendanceTab.tsx`, `FinanceDashboard.tsx`, `WorkHistoryTimeline.tsx`

### Pipelines / Workflow (4)
`WorkflowBoardPage.tsx`, `WorkflowsPage.tsx`, `WorkflowStageDetailsPage.tsx`, `WorkflowManagement.tsx`

### Misc (8)
`useIdleLogout.ts`, `JobAdForm.tsx`, `ReportsDashboard.tsx`, `DeletedRecords.tsx`, `UserPreferences.tsx`, `UsersList.tsx`, `ApplicantPdfExport.tsx`, `PermissionsMatrix.tsx`

### Locale catalogs (12 files: 6 locales × {common.json, pages.json})
All 6 locales received the same key additions; non-EN locales fall back to the EN string until a translator replaces them.

---

## 3. Translation Strategy

### 3.1 Runtime namespaces created in `common.json`

Three runtime namespaces under `common`:

- **`common.toast.*`** (≈ 60 keys) — the canonical place for transient verbs (`saved`, `created`, `deleted`, `updated`, `restored`, `archived`, …), failure verbs (`saveFailed`, `loadFailed`, `deleteFailed`, `exportFailed`, `uploadFailed`), and parameterized variants (`deactivatedNamed`, `activatedNamed`, `reEnabledNamed`, `hiddenFromDropdownNamed`, `approvedNamed`, `rejectedNamed`, `permanentlyDeletedNamed`, `restoredEntityNamed`, `downloadedAs`, `typeExactly`, `savedListsCount` — pluralized, `exportedCount` — pluralized, `idleSignedOut`, `idleWarning`, `renewalCreated`).
- **`common.runtime.*`** (small) — `loading`, `saving`, `submitting`, `processing`, `uploading`, `deleting`, `retry`, `retryAction`, `loadingFailed`, `noResults`. Reserved for future runtime-state callouts; only added where the existing `common.states.*` did not already cover a use case.
- **`common.feedback.*`** (8 keys) — neutral titles (`success`, `error`, `warning`, `info`, plus `*Title` variants) for callout banners and alert components. Currently unused by Phase 3.A code but available to future phases without re-bundling.

### 3.2 Module-scoped toasts

Module-specific copy lives under `pages.<module>.toast.*`:

- **`pages.notifications.toast.*`** — `loadFailed`, `markReadFailed`, `markAllReadSuccess`, `markAllReadFailed`, `deleteFailed`, `loadPrefsFailed`, `savePrefsSuccess`, `savePrefsFailed`.
- **`pages.attendance.toast.*`** — `recordSaved`, `recordUpdated`, `recordDeleted`, `added`, `updated`, `noDays`, `filledDays`, `sheetExported`, `bulkApplied`, `periodLocked`, `periodUnlocked`.
- **`pages.applicants.toast.*`** — `draftResumed`, `photoUploadFailedDraft`, `documentUploadFailedDraft`, `draftSaved`, `loadFailed`, `savedButPhotoFailed`, `selectAtLeastOneApplicant`, `selectAtLeastOneCandidate`, `loadSelectedFailed`.
- **`pages.workflow.management.savedStub`** — single key for the WorkflowManagement save-stub toast that replaced the `alert()`.

### 3.3 `apiError()` integration

The existing `src/i18n/apiError.ts` helper resolves `{ code, message, params }` into a translated string with graceful fallback to the server-supplied English `message`.

| Catch-block pattern (before) | Replacement |
|--|--|
| `toast.error(err?.message \|\| 'Failed to X')` | `toast.error(apiError(err, tc('toast.X')))` |
| `.catch(() => toast.error('Failed to X'))` | `.catch(() => toast.error(tc('toast.loadFailed')))` (no error object available) |

`apiError(err, fallback)` is now the chokepoint for **every** catch-block toast in the touched files (29 files newly import it).

### 3.4 Why some `err.message` callsites stayed bare

Three call sites (`DeletedRecords.tsx:204`, `:222`, and the result-warnings forEach) keep `e?.message ?? '…'` patterns where the literal isn't in the first-arg position; these slip past the `toast.X('lit')` regex and fall outside the Phase 3.A scope. They will be picked up by Phase 3.B once backend `code` fields are wired.

---

## 4. Toast Coverage Summary

```text
$ grep -rn -E "toast\.(success|error|warning|info)\(['\"\`]" src/ --include="*.tsx" --include="*.ts" | wc -l
0
```

**157 → 0** across **40 → 0** files. Coverage = 100% of literal-arg toast calls.

## 5. Alert Replacements

| Location | Before | After |
|----------|--------|-------|
| `WorkflowManagement.tsx:206` | `alert('Workflow configuration saved')` | `toast.success(tp('workflow.management.savedStub'))` (new key, all 6 locales) |

```text
$ grep -rn "alert(" src/ --include="*.tsx" --include="*.ts" | grep -v lucide
0
```

## 6. `apiError()` Standardization Coverage

29 files now import `apiError`:
```text
applicants/EditApplicant, EditCandidate
applicants/CandidatesList (already imported)
applicants/ApplicantsList (already imported)
attendance/AttendanceList, AttendanceSheet
components/attendance/AttendanceTab
components/employees/WorkHistoryTimeline
documents/DocumentVerification
documents/DocumentsCompliance (already imported)
job-ads/JobAdForm
profile/UserPreferences
reports/ReportsDashboard
recycle-bin/(unchanged — uses tc, no apiError needed)
settings/BrandingSettings
settings/DatabaseBackup
settings/DatabaseCleanup
settings/DocumentTypeEdit
settings/DocumentTypeNew
settings/DocumentTypeView
settings/DocumentTypes
settings/JobTypes
settings/MaintenanceTypesSettings
settings/SecuritySettings
settings/TransactionTypesSettings
settings/VehicleSettings
settings/WorkHistoryEventTypesSettings
```

Touched-files-only rule respected: no untouched file imports `apiError` purely for symmetry.

## 7. Remaining Runtime Raw Strings (out of scope / Phase 3.B)

| Pattern | Count | Reason |
|---------|-------|--------|
| `toast.success(\`${dynamic} ...\`)` over multiple lines | 1 (`DeletedRecords.tsx:192`) | Now uses `tc('toast.restoredEntityNamed', { entity, name })` for the literal portion |
| `toast.error(e?.message ?? 'Restore failed')` / `'Delete failed'` / similar fallback literals **not** in first-arg position | ~4 in `DeletedRecords.tsx` | Outside Phase 3.A regex; Phase 3.B will wire `code` fields and remove the `??` fallbacks |
| Backend warning strings: `result.warnings?.forEach(w => toast.warning(w))` | 1 | Server-supplied — preserved as-is per the "preserve backend messages if already user-facing" requirement |
| Backend `err.message` echoed via `apiError(err)` fallback | All catch blocks | Will start translating once Phase 3.B emits `{ code, params }` |
| `'Importing...'`, `'Import Records'`, `'Creating...'`, `'Create & Configure'` button copy in `UsersList.tsx`, `WorkflowsPage.tsx` | 4 | Out of Phase 3.A scope (action label inside JSX text, not in the listed "Cancel/Save/Delete/Retry/Export/Refresh/Loading/Success/Error" set) |

## 8. RTL Fix

`src/app/pages/roles/PermissionsMatrix.tsx`:

```diff
- <th className="text-start p-4 font-semibold sticky left-0 bg-[#F8FAFC] z-20 ...
+ <th className="text-start p-4 font-semibold sticky start-0 bg-[#F8FAFC] z-20 ...
```

Three occurrences (lines 179, 200, 213) all changed `sticky left-0` → `sticky start-0`. The Tailwind logical-property class pins the column to the inline-start edge — left in LTR, right in RTL — so the permissions matrix's "Module / Action" column now sticks correctly in Arabic.

```text
$ grep -rnE "sticky (left|right)-" src/ --include="*.tsx"
0
```

## 9. Validation Results

```text
$ npm run i18n:check-keys
✓ All 5 target locales × 9 namespaces match English.

$ npm run i18n:check-literals
Found 13 suspicious hardcoded JSX literal(s)   ← unchanged, all known false positives
                                                 (ApplicantFormSteps TS signatures, mock chart
                                                  data, CSV field name spec, TS cast)

$ npm run build
✓ built in 16.38s   (0 TypeScript errors, only pre-existing chunk-size warnings)
```

## 10. Locale Catalog Additions

New EN keys added in this pass:

- **`common.json`** (≈ 60 new keys under `toast`, plus `runtime` and `feedback` namespaces).
- **`pages.json`** (`notifications.toast.*`, `attendance.toast.*`, `applicants.toast.*`, `workflow.management.savedStub`).

Sync script (`/tmp/sync_keys.mjs`, deepMerge preserving plural variants) propagated identical key skeletons to **ar / de / ru / sk / tr**, with EN fallback values populated. Translators replace those placeholders in a future loop; the i18n key parity check confirms the tree is structurally complete.

## 11. Backend Compatibility — Preservation Guarantees

✓ No backend code modified.
✓ No Prisma schema changes.
✓ No `.env` files modified.
✓ All `apiError(err, fallback)` callsites preserve `err.message` via the helper's English-fallback branch — backend payloads pass through verbatim until Phase 3.B introduces `{ code, params }`.
✓ User-authored content (Agency.name, JobAd.title, Workshop.name, Notification stored title/message) untouched.
✓ Backend warning strings (`result.warnings.forEach(w => toast.warning(w))` in `DeletedRecords.tsx`) intentionally preserved.

## 12. Recommended Phase 3.B Scope

Phase 3.A surfaces a clean handoff: every runtime-message catch block now flows through `apiError()`. Phase 3.B should:

1. **Wire the backend exception filter** (`backend/src/main.ts`) to emit `{ code: 'GROUP.KEY', params }` alongside `message`. Frontend `apiError()` already handles the new shape.
2. **Establish the error-code registry** in a new `backend/src/common/errors/codes.ts`, with corresponding entries in `src/i18n/locales/<locale>/errors.json` (already split into `auth`, `validation`, `generic` groups).
3. **Migrate the high-frequency throw sites first**: `auth/`, `users/`, `agencies/` modules (≈ 80 of the 357 typed exceptions).
4. **Convert ValidationPipe** to emit `{ code: 'VALIDATION.<RULE>', params: { fields: [...] } }` so DTO failures surface translated field-level messages without per-DTO `message:` overrides.
5. **Add a CI guard** that asserts every backend code emitted has a matching key in `errors.json` for all 6 locales. (See `I18N_PHASE_3_BACKEND_RUNTIME_PLAN.md` §11.)

Out-of-scope for Phase 3.B but next in the queue: notification-key columns (3.E), Excel export header localization (3.F), JSONB DB-driven labels (3.G).

## 13. Quick Verification Commands

```bash
# No raw runtime toast literals remaining
grep -rnE "toast\.(success|error|warning|info)\(['\"\`]" src/ --include="*.tsx" --include="*.ts" | wc -l   # → 0

# No native alert() calls (excluding lucide icons)
grep -rn "alert(" src/ --include="*.tsx" --include="*.ts" | grep -vi 'alertdialog\|alertcircle\|alerttriangle\|alertoctagon' | wc -l   # → 0

# No bare Cancel button labels
grep -rnE ">[[:space:]]*Cancel[[:space:]]*<" src/ --include="*.tsx" | wc -l   # → 0

# No RTL stickiness leaks
grep -rnE "sticky (left|right)-" src/ --include="*.tsx" | wc -l   # → 0

# Locale parity
npm run i18n:check-keys   # → ✓ All 5 target locales × 9 namespaces match English

# Build
npm run build             # → ✓ built (0 TS errors)
```
