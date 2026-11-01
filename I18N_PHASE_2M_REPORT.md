# I18N Phase 2.M — Implementation Report

**Branch:** `claude/phase-2m-i18n-workflow-notifications`
**Scope:** Frontend-only — pipelines/workflow detail pages, list and
board residuals, plus the Notifications module
(`NotificationCenter`, `NotificationSettings`).
**Date:** 2026-05-06.

---

## 1 · Changed files

```
src/app/pages/pipelines/WorkflowStageDetailsPage.tsx       (18 → 0 ‡)
src/app/pages/pipelines/WorkflowSettingsPage.tsx           (11 → 0 ‡)
src/app/pages/pipelines/WorkflowsPage.tsx                  (8  → 0 ‡)
src/app/pages/pipelines/WorkflowBoardPage.tsx              (8  → 0 ‡)
src/app/pages/notifications/NotificationCenter.tsx         (14 → 0 ‡)
src/app/pages/notifications/NotificationSettings.tsx       (3  → 0 ‡)

src/i18n/locales/en/pages.json                             (+ ~95 keys)
src/i18n/locales/{sk,de,ru,ar,tr}/pages.json               (sync — English fallback)

I18N_PHASE_2M_REPORT.md                                    (new)
```

‡ All literal-scanner hits flagged for these files in Phase 2.L are
now translated.

### Repo-wide literal-scanner totals

| Stage | Total |
|---|---:|
| Phase 2.L end | 622 |
| Phase 2.M end | 560 |

**62-literal reduction.**

---

## 2 · Per-page coverage

### `WorkflowStageDetailsPage.tsx` (18 → 0)

Full visible-text translation under new `pipelines.stage.*`
(~18 keys):

```
✓ "Stage Approval" modal title
✓ "Notes (optional)" label
✓ "Add Quick Note" button
✓ "Document Status" / "Flag Status" panel headers
✓ "Stage Not Found" empty-state title + body + "Return to Workflow" CTA
✓ 4 stat-card labels: Total in Stage / Avg. Days in Stage /
   At Risk (>14 days) / Stage Requirements
✓ 6 filter sentinels: All Deadlines / On Time / No Deadline /
   All Docs / Pending Review / Not Started
```

### `WorkflowSettingsPage.tsx` (11 → 0)

Extended `pipelines.settings.*` (~70 new keys):

```
✓ Header: "Configure stages and requirements for this workflow"
   subtitle, "Settings"/"Workflows" breadcrumbs, "Duplicate" /
   "Save Changes" / "Add Stage" buttons (with "Saving…"/"Adding…"
   states)
✓ Add Stage dialog: title + 4 form fields (Stage Name / Description
   / Stage Color / SLA hours) with placeholders + 2 toggles
   (Requires approval / Final stage) + Cancel/Add Stage actions
✓ Admin warning banner ("System Administrator Access Only" + body)
✓ Drag-and-drop info banner
✓ Workflow Details card: Name * / Color / Description / Save Details
   + 2 toggles (Set as default workflow / Public visibility)
✓ Stages section header with active/inactive count
✓ Empty state: 'No stages configured. Click "Add Stage"…'
✓ Per-stage row: "Stage N" / "Final" / "Inactive" badges +
   "{N} documents" / "{N} approvals" / "{N}h SLA" stats +
   Edit Stage / Edit Requirements / Activate / Deactivate buttons
✓ Edit Requirements dialog: title with stage-name interpolation +
   3 sections (Required Documents / Responsible Users / Approvers)
   with select placeholders, "No document types"/"No users"
   fallbacks, Add Document / Add User / Add Approval buttons,
   "Any user may process" toggle, approval-mode select (Any/All),
   minimum-approvals number input, summary line with plural-aware
   interpolation, Cancel / Save Requirements actions
✓ Edit Stage dialog: title + form fields + actions
✓ Danger Zone: "Archive Workflow" card + button
✓ All 7 alert(...) calls converted to toast.error(...) with
   translated fallbacks
✓ All 4 confirm(...) calls translated (delete stage / activate /
   deactivate / archive) using new keys
✓ "Workflow not found" error fallback
```

### `WorkflowsPage.tsx` (8 → 0)

Extended `pipelines.list.*` (~8 keys):

```
✓ New Workflow modal title + body
✓ "Name *" form label
✓ "Set as default workflow" toggle
✓ "No workflows yet" empty-state title + body
✓ "Manage Access" modal header
✓ "Add user" label
```

### `WorkflowBoardPage.tsx` (8 → 0)

Extended `pipelines.board.*` (~8 keys):

```
✓ Add Note modal title + private-note label + Add Note button
✓ Advance to Stage modal title
✓ Assign Candidate to Workflow modal title
✓ Candidate ID * + Notes (optional) form labels
✓ "No stages configured" empty-state title + body
```

### `NotificationCenter.tsx` (14 → 0)

Extended `notifications.center.*`:

```
✓ Filter sentinels: All / Unread only / Read only
✓ Type filter: All types
✓ Event filter: All events + 7 specific events (Doc Uploaded,
   Doc Expiring, Doc Expired, Finance Added, Finance Updated,
   Finance Deleted, High Balance)
✓ "Date from" / "Date to" labels
✓ "No notifications" empty-state heading
```

### `NotificationSettings.tsx` (3 → 0)

New `notifications.settings.*`:

```
✓ Page title + subtitle
✓ "You have unsaved changes" sticky-footer message
✓ Added `useTranslation('pages')` hook (file had no t-binding
   previously)
```

---

## 3 · `confirm()` callers translated

This phase translated all 4 `confirm()` callers in
`WorkflowSettingsPage` (delete stage, activate stage, deactivate
stage, archive workflow) using new `pipelines.settings.*` keys.
A `delete workflow?` confirm in `WorkflowsPage` remains hardcoded
(English) and is flagged for Phase 2.N.

---

## 4 · New translation keys

| Sub-tree | Keys | Purpose |
|---|---:|---|
| `pipelines.stage.*` (new) | ~18 | Stage detail page + approval modal |
| `pipelines.settings.*` (extension) | ~70 | All Workflow Settings UI |
| `pipelines.list.*` (extension) | ~7 | Create-workflow modal + empty state + Manage Access dialog |
| `pipelines.board.*` (extension) | ~7 | Add Note / Advance / Assign modals + empty state |
| `notifications.center.*` (extension) | ~17 | Filter sentinels + event types + dates + empty heading |
| `notifications.settings.*` (new) | ~3 | Page title + subtitle + footer message |
| **Total new EN keys** | **~122** | — |

Times 5 non-EN locales = **~610 strings** awaiting native
translation. Cumulative since Phase 2.A is now ~3,800 EN keys ×
5 locales ≈ **~19,000 strings**.

---

## 5 · Locale parity strategy

`/tmp/sync_keys.mjs` walked every namespace in `en/` and inserted
missing keys into each non-English locale verbatim. CLDR plural
variants for ar/ru/sk preserved.

---

## 6 · RTL polish

Touched files use logical Tailwind classes (`me-`, `ms-`, `text-end`,
`text-start`, `start-`, `end-`). No new directional icons introduced.

---

## 7 · Quality checks

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
Found 560 suspicious hardcoded JSX literal(s)
  (down from 622 at end of Phase 2.L — 62-literal reduction).

$ npm run build
✓ built in ~26s
(bundle size warning unchanged; pre-existing.)
```

---

## 8 · Known limitations

1. **Static column-picker `ALL_COLUMNS` arrays** in
   FinanceDashboard, LogsDashboard, EmployeesList, ApplicantsList,
   CandidatesList carry hardcoded English labels at module scope.
   Deferred — flagged Phase 2.N (refactor to `labelKey` pattern).

2. **Remaining `confirm()` callers (~30) still pass English props.**
   Pages: `EmployeeProfile`, `ApplicantProfile`, `CandidateProfile`,
   `MaintenanceTypesList`, `MaintenanceRecordsList`,
   `WorkshopsList`, `VehicleSettings`, `MaintenanceTypesSettings`,
   `ReportsDashboard`, `WorkflowManagement`, plus the
   `delete workflow?` confirm in `WorkflowsPage`. Phase 2.N scope.

3. **CreateWorkflowModal residual literals** (Description / Color /
   Optional description placeholder / Cancel / Creating… /
   Create & Configure) — picked up by the literal scanner less
   reliably; about 5 strings in this modal still hardcoded.
   Flagged for Phase 2.N cleanup.

4. **English fallback values for ~122 new keys.** Per the brief.

5. **Build still emits pre-existing 500 KB chunk warning.**
   Unchanged.

---

## 9 · Remaining high-impact untranslated areas

Sorted by literal-scanner count (post-2.M):

| File | Literals | Notes |
|---|---:|---|
| `pages/public/DataProcessingAgreement.tsx` | many | Long static legal text blocks. Translate as a single rich-text key per language. |
| `components/applicants/ApplicantFormSteps.tsx` | 6 | TS-signature false positives. |
| `pages/profile/ChangePassword.tsx` | 5 | Password change form residuals. |
| `components/workflow/StageTransition.tsx` | 4 | **Dead code** — flagged for removal. |
| Various confirm() callers | ~30 | English title/description across detail / settings pages. |

---

## 10 · Recommended Phase 2.N scope

### Phase 2.N.1 — Static column-picker labels (~0.5 d)

Refactor `ALL_COLUMNS` arrays in FinanceDashboard, LogsDashboard,
EmployeesList, ApplicantsList, CandidatesList etc. to use a
`labelKey` field, evaluated at render time via `t()`.

### Phase 2.N.2 — `confirm()` caller sweep (~1.5 d)

The ~30 callers backlogged from Phase 2.G/H/I/J/K/L/M. Pattern is
mechanical with `common.confirm.*` reusable phrases.

### Phase 2.N.3 — Long-form public legal pages (~1 d)

Translate the long privacy/data-processing agreement bodies as
single rich-text keys per language. Manual formatting check needed
for paragraphs/lists.

### Phase 2.N.4 — Native translations (~3-4 d)

Cumulative translator workload is ~3,800 EN keys × 5 locales ≈
~19,000 strings.

### Phase 2.N.5 — Delete dead code (~0.25 d)

Remove `components/workflow/StageTransition.tsx`.

### Suggested next prompt

> Implement Phase 2.N.1 + 2.N.2 of the i18n component sweep.
> Branch `claude/phase-2n-i18n-columns-confirms`. Refactor the
> static `ALL_COLUMNS` arrays in the dashboard/list pages to use
> a `labelKey`-via-`t()` pattern, and complete the ~30 remaining
> `confirm()` call sites listed in I18N_PHASE_2M_REPORT.md §8
> using the existing `common.confirm.*` reusable phrases. Run
> `npm run i18n:check-keys`, `npm run i18n:check-literals`, and
> `npm run build` before commit. Push to the new branch. Do not
> open a PR.
