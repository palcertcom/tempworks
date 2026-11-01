# Multi-Language Audit — Part 04: Frontend RTL / LTR Risks

> **Read-only audit.** No source code modified. No commits made.
> Scope: `src/**/*.{ts,tsx}` (196 files). Date: 2026-05-05. Branch: `claude/phase-5-i18n-polish`.
> Prior audits: Part 01 (routes), Part 02 (components), Part 03 (backend / DB).

---

## 1 · Executive Summary

Phase 5 already ran a codemod across the codebase converting **all** physical
Tailwind margin / padding / text-align / rounded / border-width classes to their
logical equivalents (`ms-*`, `me-*`, `ps-*`, `pe-*`, `text-start`, `text-end`,
`rounded-s-*`, `rounded-e-*`, `border-s`, `border-e`). The grep sweep below
confirms **zero residual** occurrences of those physical classes — that codemod
landed cleanly.

The two surviving categories of RTL risk are therefore:

| # | Category | Files | Pattern hits | Severity |
|---|----------|-------|--------------|----------|
| A | Directional icons (`Chevron*`, `Arrow*`) without `rtl:rotate-180` / `rtl:scale-x-[-1]` | **80** | ~155 occurrences | **High** — every "back" button, breadcrumb, "view more →", carousel, pagination, dropdown sub-menu chevron points the wrong way in Arabic |
| B | Residual absolute / sticky positioning with `left-N` / `right-N` | **4** | 11 occurrences | Medium — concentrated in Sheet, Sidebar, Carousel and `PermissionsMatrix` sticky column |
| C | Inline `style={{ left: …, right: … }}` (PDF only, not on-screen) | **2** | 2 occurrences | Low — `@react-pdf/renderer`, no RTL impact |
| D | `-translate-x-*` for centering or row-offset (carousel, dialog overlays) | several | 8 occurrences | Low — centering math is direction-independent |
| E | "Physical" `ml-/mr-/pl-/pr-/text-left/text-right/rounded-l/rounded-r/border-l/border-r-N` | 0 | 0 | None — codemod complete |

**Net assessment.** The high-volume "shape" of the layout already flips
correctly in Arabic. The remaining bugs are predominantly *icon direction*
(very visible in Arabic) and four UI-primitive files that wire `left-0` /
`right-0` to a physical `side` prop. Fix-cost is small: most icon files need
either a single `rtl:rotate-180` class or a swap to direction-aware icon
components, and the 4 primitives can be teed up with logical `start-0` / `end-0`.

13 of 93 icon-using files already include `rtl:` flip classes (Phase 1 / Phase 5
work on the public marketing pages and a few core primitives). The remaining
**80 files** are the actual backlog.

---

## 2 · Methodology

```bash
# Patterns swept (case-sensitive, src/**/*.{tsx,ts} only):
ml- | mr- | pl- | pr-                              # margin / padding (physical)
left- | right-                                     # absolute / sticky position
text-left | text-right                             # alignment
rounded-l | rounded-r                              # corner rounding
border-l | border-r                                # one-side border
ChevronLeft | ChevronRight                         # directional icons
ArrowLeft  | ArrowRight                            # directional icons
```

Counts use `grep -rEoh '(^|[^a-zA-Z-])PATTERN[a-z0-9.-]+' src --include='*.tsx'
--include='*.ts'` to avoid false positives like `border-red-*`,
`overflow-revert`, `text-leftover` etc.

A file is flagged "missing RTL flip" if it imports any of the four directional
icons but does **not** contain `rtl:rotate-180` or `rtl:scale-x-[-1]` on the
icon's `className`.

---

## 3 · Pattern × File Findings (Table)

`Impact` legend:
- **High** → visibly broken in Arabic (chevron pointing wrong way on a back
  button, sticky column anchored to the wrong screen edge, etc.)
- **Medium** → animation / slide direction reversed but content remains usable
- **Low** → off-screen, print-only, or mathematically symmetric
- `n/a` → already RTL-safe (logical class) — listed for traceability only

| File | Pattern | Count | Impact | Suggested replacement | Priority |
|---|---|---:|---|---|---|
| **Directional-icon files (top-impact)** | | | | | |
| `src/app/pages/documents/DocumentsCompliance.tsx` | `ChevronLeft`, `ChevronRight`, `ArrowLeft` | 8 | High | Replace with `Chevron{Start,End}` wrapper or add `rtl:rotate-180` to each instance; back-button arrow → `rtl:rotate-180` | P1 |
| `src/app/pages/public/JobListings.tsx` | `ChevronLeft`, `ChevronRight`, `ArrowRight` | 7 | High | Already has `rtl:` on 2 of 7 — finish the sweep | P1 |
| `src/app/pages/logs/LogsDashboard.tsx` | `ChevronLeft`, `ChevronRight` | 6 | High | Wrap in `<ChevronStart/>`/`<ChevronEnd/>` or add `rtl:rotate-180` | P1 |
| `src/app/pages/attendance/AttendanceSheet.tsx` | `Chevron{L,R}`, `ArrowLeft` | 6 | High | Same — 2 are pagination, 2 are back, 2 are calendar nav | P1 |
| `src/app/pages/applicants/EditCandidate.tsx` | `Chevron{L,R}`, `ArrowLeft` | 6 | High | Back-arrow + breadcrumb chevrons | P1 |
| `src/app/pages/applicants/EditApplicant.tsx` | `Chevron{L,R}`, `ArrowLeft` | 6 | High | Same pattern as EditCandidate | P1 |
| `src/app/pages/applicants/AddApplicant.tsx` | `Chevron{L,R}`, `ArrowLeft` | 6 | High | Same pattern | P1 |
| `src/app/components/ui/carousel.tsx` | `ArrowLeft`, `ArrowRight`, `left-1/2`, `-translate-x-1/2` | 6 + 2 + 2 | High | Carousel `Previous`/`Next` arrows must swap roles (not just rotate icon) when `dir=rtl`; the `left-1/2 -translate-x-1/2` centering is fine | P1 |
| `src/app/pages/public/PublicEmployeeApplication.tsx` | `Chevron{L,R}`, `ArrowLeft` | 5 | High | 3 of 5 already flipped — finish | P1 |
| `src/app/pages/public/JobDetail.tsx` | `ChevronRight`, `ArrowLeft` | 5 | High | 3 of 5 already flipped — finish | P1 |
| `src/app/pages/applicants/CandidateProfile.tsx` | `ChevronRight`, `ArrowLeft` | 5 | High | Back-arrow + breadcrumb chevrons | P1 |
| `src/app/pages/applicants/ApplicantProfile.tsx` | `ChevronRight`, `ArrowLeft` | 5 | High | Same | P1 |
| `src/app/pages/public/LandingPage.tsx` | `ArrowRight` | 5 | High | All 5 are CTAs ("Get started →"). 4 of 5 already flipped; fix the last one | P2 |
| `src/app/components/ui/pagination.tsx` | `Chevron{L,R}` | 4 | High (primitive) | Already has `rtl:` flip — verify both directions | P1 ✅ |
| `src/app/components/ui/calendar.tsx` | `Chevron{L,R}` | 4 | High (primitive) | Already has `rtl:` flip | P1 ✅ |
| `src/app/components/layout/Sidebar.tsx` | `Chevron{L,R}` | 4 | High (primitive) | Already has `rtl:` flip | P1 ✅ |
| `src/app/pages/recycle-bin/DeletedRecords.tsx` | `Chevron{L,R}` | 4 | High | Pagination + table sort — add flip | P1 |
| `src/app/pages/job-ads/JobAdsList.tsx` | `Chevron{L,R}` | 4 | High | Pagination | P1 |
| `src/app/pages/Dashboard.tsx` | `ChevronRight` | 4 | High | 3 of 4 already flipped — finish the last | P1 |
| `src/app/pages/workflow/WorkflowStageDetail.tsx` | `ChevronRight`, `ArrowLeft` | 4 | High | Stage-progress chevrons + back arrow | P1 |
| `src/app/pages/workflow/WorkflowOverview.tsx` | `ChevronRight`, `ArrowLeft` | 4 | High | Same | P1 |
| `src/app/pages/workflow/StageDetails.tsx` | `ChevronRight`, `ArrowLeft` | 4 | High | Same | P1 |
| `src/app/pages/pipelines/WorkflowBoardPage.tsx` | `ChevronRight`, `ArrowLeft` | 4 | High | Kanban arrows + back | P1 |
| `src/app/pages/employees/EmployeeProfile.tsx` | `ChevronRight`, `ArrowLeft` | 4 | High | Profile breadcrumb + back | P1 |
| `src/app/pages/agencies/AgencyProfile.tsx` | `ChevronRight`, `ArrowLeft` | 4 | High | Same | P1 |
| `src/app/pages/workflow/WorkflowTimeline.tsx` | `ArrowLeft`, `ArrowRight` | 4 | High | Timeline navigation arrows: must SWAP roles in RTL, not just rotate | P1 |
| `src/app/components/workflow/StageTransition.tsx` | `ArrowRight` | 1 | High | Visual progression "→" between stages | P1 |
| **Primitives with single chevron** | | | | | |
| `src/app/components/ui/breadcrumb.tsx` | `ChevronRight` | 2 | High (primitive) | Add `rtl:rotate-180` (separator) — used by every page | P1 |
| `src/app/components/ui/dropdown-menu.tsx` | `ChevronRight` | 2 | High (primitive) | Add `rtl:rotate-180` to sub-menu chevron | P1 |
| `src/app/components/ui/menubar.tsx` | `ChevronRight` | 2 | High (primitive) | Same — sub-menu chevron | P1 |
| `src/app/components/ui/context-menu.tsx` | `ChevronRight` | 2 | High (primitive) | Same | P1 |
| **Single back-arrow ("← back") pages — ~50 files** | | | | | |
| `src/app/pages/agencies/{AgencyProfile,EditAgency,AddAgency,AgencyUsersManagement}.tsx` | `ArrowLeft` | 2 ea | High | Add `rtl:rotate-180` to header back-arrow | P1 |
| `src/app/pages/users/{AddUser,EditUser}.tsx` | `ArrowLeft` | 2 ea | High | Same | P1 |
| `src/app/pages/employees/{AddEmployee,EditEmployee,EmployeeComplianceTimeline,EmployeePerformanceReview,EmployeeCertifications,EmployeeTrainingHistory}.tsx` | `ArrowLeft` | 2 ea | High | Same | P1 |
| `src/app/pages/public/{LoginPage,ResetPasswordPage,ForgotPasswordPage,ActivationPage}.tsx` | `ArrowLeft` | 2 ea | Medium | Already has `rtl:` flip — verify | P1 ✅ |
| `src/app/pages/compliance/{EmployeeCompliance,ComplianceAlerts}.tsx` | `ArrowLeft` | 2 ea | High | Same back-arrow pattern | P1 |
| `src/app/pages/profile/{UserPreferences,ChangePassword}.tsx` | `ArrowLeft` | 2 ea | High | Same | P1 |
| `src/app/pages/pipelines/{WorkflowSettingsPage,WorkflowStageDetailsPage}.tsx` | `ArrowLeft` | 2 ea | High | Same | P1 |
| `src/app/pages/applicants/{CandidateDeleteRequests}.tsx` | `ArrowLeft` | 2 | High | Same | P1 |
| `src/app/pages/notifications/NotificationSettings.tsx` | `ArrowLeft` | 2 | High | Same | P1 |
| `src/app/pages/settings/*.tsx` (18 files: TrailerTypesSettings, ColorScheme, SecuritySettings, DocumentTypeNew, JobTypes, MaintenanceTypesSettings, WorkflowSettings, DocumentTypes, TransactionTypesSettings, TransportTypesSettings, SkillsSettings, TruckBrandsSettings, WorkHistoryEventTypesSettings, VehicleSettings, SystemInformation, DatabaseBackup, BrandingSettings, DocumentTypeEdit, DocumentTypeView, DatabaseCleanup) | `ArrowLeft` | 2 ea | High | Same back-arrow pattern in every settings sub-page | P2 |
| `src/app/pages/roles/{PermissionsMatrix,CreateRole}.tsx` | `ArrowLeft` | 2 ea | High | Same | P2 |
| `src/app/pages/workflow/{WorkPermitTracking,WorkflowAnalytics,VisaTracking,WorkflowManagement}.tsx` | `ArrowLeft` | 2 ea | High | Same | P2 |
| `src/app/pages/job-ads/JobAdForm.tsx` | `ArrowLeft` | 2 | High | Same | P2 |
| `src/app/pages/vehicles/{WorkshopsList,VehicleDetail,MaintenanceTypesList,MaintenanceRecordsList,VehicleForm}.tsx` | `ArrowLeft` | 2 ea | High | Same | P2 |
| `src/app/pages/documents/{EditDocument,DocumentVerification,EmployeeDocumentExplorer,DocumentPreview,DocumentUpload}.tsx` | `ArrowLeft` | 2 ea | High | Same | P2 |
| **Residual physical positioning** | | | | | |
| `src/app/components/ui/sheet.tsx` | `left-0`, `right-0`, `slide-in-from-{left,right}` (2 + 2 + 4) | 8 | Medium | `side` prop is physical by design; either keep semantics + flip at call-site, or rename to `side="start"\|"end"` and emit `start-0`/`end-0` + `slide-in-from-{start,end}` | P2 |
| `src/app/components/ui/sidebar.tsx` | `left-0`, `right-0` (paired with `side` prop) | 4 | Medium | Same as Sheet — `side="left"\|"right"` is physical; consumers usually want logical start | P2 |
| `src/app/components/ui/carousel.tsx` | `left-1/2`, `-translate-x-1/2` (centering) | 4 | Low | Centering math is symmetric; arrow icon swap is the real fix (covered above) | P3 |
| `src/app/pages/roles/PermissionsMatrix.tsx` | `sticky left-0` × 3 (frozen "Module / Action" column) | 3 | Medium | Replace with `sticky start-0`; otherwise the frozen column anchors to the *visual right* in Arabic, leaving the wrong column scrolling | P1 |
| **PDF / inline style (not on-screen)** | | | | | |
| `src/app/components/employees/EmployeePdfDocument.tsx` | inline `left: 36, right: 36` (PDF footer) | 1 | Low | `@react-pdf/renderer` does not flip; intentional symmetric padding | P3 |
| `src/app/components/applicants/ApplicantPdfExport.tsx` | inline `left: 36, right: 36` (PDF footer) | 1 | Low | Same | P3 |
| **Already-safe (logical class) — no action** | | | | | |
| 100% of files (was: `ml-/mr-/pl-/pr-/text-left/text-right/rounded-l/rounded-r/border-l/border-r-N`) | — | 0 | n/a | Phase 5 codemod complete — keep `i18n:check` running in CI to prevent regressions | — |

**Pattern totals (sweep result):**

| Pattern | Hits | Files | Status |
|---|---:|---:|---|
| `ml-N` | 0 | 0 | ✅ codemod complete |
| `mr-N` | 0 | 0 | ✅ codemod complete |
| `pl-N` | 0 | 0 | ✅ codemod complete |
| `pr-N` | 0 | 0 | ✅ codemod complete |
| `text-left` | 0 | 0 | ✅ codemod complete |
| `text-right` | 0 | 0 | ✅ codemod complete |
| `rounded-l-N` | 0 | 0 | ✅ codemod complete |
| `rounded-r-N` | 0 | 0 | ✅ codemod complete |
| `border-l-N` | 0 | 0 | ✅ codemod complete |
| `border-r-N` | 0 | 0 | ✅ codemod complete |
| `left-N` (positional) | 7 | 4 | ⚠ residual |
| `right-N` (positional) | 4 | 2 | ⚠ residual |
| `ChevronLeft` | 28 | 14 | ⚠ icon flip needed (3 already flipped) |
| `ChevronRight` | 53 | 28 | ⚠ icon flip needed (5 already flipped) |
| `ArrowLeft` | ~110 | 75 | ⚠ icon flip needed (5 already flipped) |
| `ArrowRight` | ~14 | 5 | ⚠ icon flip needed (1 already flipped) |
| **Files w/ directional icon AND no `rtl:` flip** | — | **80** | ⚠ backlog |

---

## 4 · Top 20 Highest-Risk RTL Files

Ranked by `(directional-icon count) + 2 × (positional-class count) − (already-has-rtl-flip)`.

| # | File | Why it's high-risk |
|---|---|---|
| 1 | `src/app/components/ui/breadcrumb.tsx` | Used on **every** page; `ChevronRight` separator points the wrong way globally in Arabic |
| 2 | `src/app/components/ui/sheet.tsx` | `side="right"` Sheet (drawer/dialog) anchors to physical right in Arabic — should anchor to logical start |
| 3 | `src/app/components/ui/sidebar.tsx` | Main app sidebar with conditional `side` prop — physical anchoring; collapse-offcanvas math is physical |
| 4 | `src/app/components/ui/dropdown-menu.tsx` | Sub-menu `ChevronRight` indicator points away from the sub-menu in Arabic |
| 5 | `src/app/components/ui/context-menu.tsx` | Same sub-menu chevron issue |
| 6 | `src/app/components/ui/menubar.tsx` | Same sub-menu chevron issue |
| 7 | `src/app/components/ui/carousel.tsx` | Prev/Next must SWAP roles (not just rotate) so swiping right in Arabic advances forward |
| 8 | `src/app/pages/roles/PermissionsMatrix.tsx` | `sticky left-0` frozen column anchors wrong; first column scrolls behind data in Arabic |
| 9 | `src/app/pages/documents/DocumentsCompliance.tsx` | 8 directional icons, none flipped |
| 10 | `src/app/pages/attendance/AttendanceSheet.tsx` | 6 directional icons, calendar nav inverts |
| 11 | `src/app/pages/logs/LogsDashboard.tsx` | 6 directional icons (pagination + breadcrumb + back) |
| 12 | `src/app/pages/applicants/EditCandidate.tsx` | 6 directional icons across multi-step form |
| 13 | `src/app/pages/applicants/EditApplicant.tsx` | Same multi-step form |
| 14 | `src/app/pages/applicants/AddApplicant.tsx` | Same multi-step form |
| 15 | `src/app/pages/applicants/CandidateProfile.tsx` | 5 directional icons; profile-tab carousel |
| 16 | `src/app/pages/applicants/ApplicantProfile.tsx` | 5 directional icons; profile-tab carousel |
| 17 | `src/app/pages/workflow/WorkflowTimeline.tsx` | `ArrowLeft`/`ArrowRight` represent time direction — must swap *roles* in RTL, not flip |
| 18 | `src/app/pages/workflow/WorkflowStageDetail.tsx` | Stage-progression "→" arrows |
| 19 | `src/app/pages/workflow/WorkflowOverview.tsx` | Stage-progression "→" arrows |
| 20 | `src/app/pages/pipelines/WorkflowBoardPage.tsx` | Kanban column arrows |

---

## 5 · Top 10 Components Likely to Break in Arabic

Ranked by visual prominence × likelihood of mis-render once `dir="rtl"` is set.

| # | Component | Failure mode in Arabic |
|---|---|---|
| 1 | **Breadcrumb separator** (`components/ui/breadcrumb.tsx`) | `›` chevron points left → reads visually as parent on right of child, contradicting RTL crumb order |
| 2 | **Sheet / drawer** (`components/ui/sheet.tsx`) | A `side="right"` notification or filter drawer slides in from the *visual right* (which is logical start in RTL) — usually unwanted; expected behaviour is "from logical end" |
| 3 | **Sidebar collapse offcanvas** (`components/ui/sidebar.tsx`) | The collapse direction (sidebar slides off the visual left or right of the screen) is physically hard-coded; in Arabic the main sidebar should slide off the *visual right* |
| 4 | **Dropdown / Context / Menubar sub-menu** | The `›` indicator points right while the sub-menu opens to the left — visually disconnected |
| 5 | **Pagination buttons** (`components/ui/pagination.tsx`) | Already has `rtl:` flip; verify "Previous" stays on the logical-start side |
| 6 | **Calendar prev/next month** (`components/ui/calendar.tsx`) | Already has `rtl:` flip; verify "previous month" arrow still goes back in time |
| 7 | **Carousel arrows** (`components/ui/carousel.tsx`) | Pure rotation is *not* enough — the underlying `scrollPrev`/`scrollNext` must also swap when `dir=rtl` (Embla supports `direction: 'rtl'`) |
| 8 | **Workflow / pipeline stage arrows** (`components/workflow/StageTransition.tsx`, `pages/workflow/Workflow{Timeline,Overview,StageDetail}.tsx`, `pages/pipelines/WorkflowBoardPage.tsx`) | "→" denotes progression; in Arabic the visual flow is right-to-left so arrows must point left to read as "next stage" |
| 9 | **Page-header back-arrow** (`ArrowLeft` on ~50 pages) | Every "← Back" arrow points the wrong way in Arabic, suggesting "forward" |
| 10 | **PermissionsMatrix sticky first column** (`pages/roles/PermissionsMatrix.tsx`) | `sticky left-0` keeps the column glued to the visual left in Arabic, but the rest of the table flows right-to-left → frozen column ends up at the trailing edge of the data |

---

## 6 · Recommended RTL Cleanup Phases

### Phase RTL-A · Direction-aware icon primitive (1 day)

Add two tiny wrapper components in `src/app/components/ui/` (or co-locate
under `src/i18n/icons.tsx`):

```tsx
// Conceptual — do not implement here.
//
//   <ChevronStart/>  →  ChevronLeft  in LTR,  ChevronRight in RTL
//   <ChevronEnd/>    →  ChevronRight in LTR,  ChevronLeft  in RTL
//   <ArrowStart/>    →  ArrowLeft    in LTR,  ArrowRight   in RTL
//   <ArrowEnd/>      →  ArrowRight   in LTR,  ArrowLeft    in RTL
```

Two implementation choices:

1. **CSS-only**: render `ChevronLeft` always and add `rtl:rotate-180`. Pros:
   one className, no JS branching. Cons: rotation includes vertical axis, so
   for asymmetric glyphs (e.g. `ArrowLeft` with serif tail) the result looks
   off; a reflection (`rtl:scale-x-[-1]`) is closer but inverts antialiasing.
2. **Runtime swap**: `useLanguage().dir === 'rtl' ? <ChevronRight/> : <ChevronLeft/>`.
   Pros: pixel-correct icons. Cons: extra render path; component must be a
   client-only React component.

Recommended: **CSS-only with `rtl:rotate-180`** (cheap, consistent with the
existing 13 already-flipped files); fall back to runtime swap only for the
3–4 cases where rotation looks visually wrong.

### Phase RTL-B · Mechanical icon-flip codemod (1 day)

Run a regex sweep over the **80 backlog files** identified in §3:

```
<(Chevron|Arrow)(Left|Right)\s+([^/]*?)className="([^"]*)"
        →  …className="$4 rtl:rotate-180"
```

Skip files already containing `rtl:rotate-180` near the icon. Manual review
for the 7 cases where the icon is *already* directional (carousel, workflow
timeline, stage-transition arrow, kanban) — those need *role* swaps, not
rotation. The codemod should:

- emit a list of touched files for QA
- leave `rtl:` classes already present untouched
- never modify `i18n/`, `imports/pasted_text/`, or PDF components

### Phase RTL-C · UI-primitive logical-positioning sweep (½ day)

Touch only 4 files:

1. `components/ui/sheet.tsx` — replace `right-0 / left-0 / border-{e,s} /
   slide-{in,out}-from-{right,left}` so a single `side="end"` works in both
   LTR and RTL. Keep `side="left"` / `"right"` as deprecated aliases for
   backward compat.
2. `components/ui/sidebar.tsx` — same pattern; the `side="left"` default
   becomes "logical start"; `group-data-[side=left]:border-e` is already
   logical, only the `left-0` / `right-0` constants need to become `start-0` /
   `end-0`.
3. `components/ui/carousel.tsx` — wire Embla `direction: dir` from
   `useLanguage()`; replace `<ArrowLeft/>` / `<ArrowRight/>` with
   `<ArrowStart/>` / `<ArrowEnd/>` so prev/next *swap roles* in Arabic.
4. `pages/roles/PermissionsMatrix.tsx` — change `sticky left-0` → `sticky
   start-0` (or use `inset-inline-start: 0` if Tailwind v4 lacks
   `start-N` for `sticky`).

### Phase RTL-D · End-to-end Arabic QA pass (½ day)

Hand-tested smoke checklist (Phase 5 has the pseudo-locale infra; this is the
real-language pass):

- Login → Dashboard → every sidebar group expands
- Open every primitive that uses Sheet, dropdown sub-menu, breadcrumb,
  pagination, calendar, carousel, dialog, drawer
- Create / edit each: Applicant, Candidate, Employee, Agency, Vehicle, Document
- Pipeline / workflow board (drag-and-drop direction sanity)
- Public auth pages (login, signup, forgot, activation, reset, DPA, landing,
  jobs)
- PermissionsMatrix scroll behaviour
- Toaster slide-in direction (Sonner has `dir` support; verify it's wired)

### Phase RTL-E · CI guard (¼ day)

Extend `scripts/i18n-check-literals.mjs` (or add `i18n-check-rtl.mjs`) to
**fail** the build when:

- A file imports `ChevronLeft` / `ChevronRight` / `ArrowLeft` / `ArrowRight`
  without containing `rtl:rotate-180` *or* the component is one of the
  whitelisted "intentionally directional" files
- Any source file outside the whitelisted UI primitives uses
  `\bml-|\bmr-|\bpl-|\bpr-|text-left|text-right|rounded-l-|rounded-r-|border-l-[0-9]|border-r-[0-9]|\bleft-[0-9]|\bright-[0-9]\b`

Wire as a new `npm run i18n:check-rtl` script under `i18n:check`.

### Effort summary

| Phase | Effort | Files touched | Owner |
|---|---|---|---|
| RTL-A direction-aware icons | 1 d | +2 new files | frontend |
| RTL-B icon-flip codemod | 1 d | ~80 files (mechanical) | frontend |
| RTL-C primitive logical-positioning | ½ d | 4 files | frontend |
| RTL-D Arabic QA | ½ d | (read-only) | QA + frontend |
| RTL-E CI guard | ¼ d | +1 script, +1 npm script | tooling |
| **Total** | **~3.25 d** | ~85 source files | — |

---

## 7 · Open Questions / Out of Scope

1. **Sheet & Sidebar `side` prop semantics.** Should `side="left"` mean
   "physical left" (current behaviour) or "logical start" (RTL-flipped)?
   Recommend introducing `"start" | "end"` aliases and gradually deprecating
   the physical names. This is an API change — needs sign-off.
2. **Embla carousel `direction`.** Setting `direction: 'rtl'` reverses both
   the swipe and the slide order. We need to confirm slide content order
   (which slide is "first") is still correct in Arabic — this depends on the
   array order callers pass in.
3. **Icon visual fidelity.** `rtl:rotate-180` rotates around centre, which
   inverts both axes. For symmetric glyphs (chevrons, equilateral arrows)
   this is correct. For asymmetric glyphs we may need `rtl:scale-x-[-1]` (a
   horizontal mirror) — needs a designer review.
4. **PDF outputs.** `@react-pdf/renderer` lacks RTL primitives;
   right-aligning Arabic body text in PDFs may need a separate effort
   (string-level `‫` embedding marks, or `lang="ar" dir="rtl"` props in
   `Document`). Out of scope here.
5. **Tailwind v4 `sticky start-0`.** Tailwind v4 logical utilities cover
   `start-*` for absolute positioning but I have not personally verified
   `sticky start-0` resolves to `inset-inline-start: 0`. Confirm in the v4
   docs before RTL-C.

---

## 8 · Final Answers

- **How many physical Tailwind direction classes survived Phase 5?** Zero
  (all of `ml-/mr-/pl-/pr-/text-left/text-right/rounded-l/rounded-r/border-l-N/border-r-N` are gone).
- **What is the dominant residual RTL bug?** Directional icon glyphs without
  `rtl:rotate-180`. **80 of 93** icon-using files lack the flip class.
- **Which UI primitives still hard-code physical positioning?** Four:
  `sheet.tsx`, `sidebar.tsx`, `carousel.tsx`, `PermissionsMatrix.tsx`.
- **Estimated total fix effort?** ~3¼ engineering days (1 day primitive +
  1 day codemod + ½ day primitives + ½ day QA + ¼ day CI guard).
- **Suggested next prompt:** *"Implement Phase RTL-A: direction-aware
  Chevron/Arrow primitives + Phase RTL-B mechanical codemod. Branch
  `claude/phase-6-rtl-icons`. Touch only the 80 backlog files identified in
  Audit 04 §3 and the new primitive file. Do not modify Sheet, Sidebar,
  Carousel, or PermissionsMatrix yet — those are RTL-C."*
