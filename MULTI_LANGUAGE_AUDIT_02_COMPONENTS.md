# Multi-Language Audit · Part 02 — Components, Forms, Dialogs, Tables, Toasts

> **Scope:** the non-route surface — layout/navigation, shared UI primitives,
> feature components under `src/app/components/**`, plus dialog/modal/form/
> table/toast usage **inside the page tree** (`src/app/pages/**`).
>
> **Companion:** [`MULTI_LANGUAGE_AUDIT_01_FRONTEND_ROUTES.md`](./MULTI_LANGUAGE_AUDIT_01_FRONTEND_ROUTES.md)
> covers the route/page level. Read it first.
>
> **Read-only:** no source code modified, no commit made.

---

## 1. Methodology

For every `.tsx` file under `src/app/components/**` and `src/app/pages/**`
we recorded:

| Signal               | How we measure it |
| -------------------- | ----------------- |
| `useT`               | File imports / calls `useTranslation` from `react-i18next` |
| Hardcoded literals   | Heuristic `>Some text<` regex from `scripts/i18n-check-literals.mjs`, applied per file. Skips strings that already live inside `t(…)` or `<Trans>`, lines that are comments, URL/path/enum-code shapes, very short tokens |
| Dialog markers       | Any of `<Dialog`, `<AlertDialog`, `<Sheet`, `<Drawer`, `<Popover` |
| Confirm calls        | Imperative `confirm({ … })` from `components/ui/ConfirmDialog` |
| Form markers         | `<form>` element or `onSubmit=` handler |
| Table markers        | `<Table` / `<thead>` / `<tbody>` |
| Toast invocations    | All `toast.<level>(…)` calls (uses `sonner`) |
| Toast literal-string | `toast.<level>('…'`/`"…"`/<code>`…`</code>`) — message hardcoded inline |
| Toast `t()` wrapped  | `toast.<level>(t(…))` |
| Toast `apiError`     | `toast.<level>(apiError(err…))` |

**Status legend** (per item):

- 🟢 **fully translated** — uses `t()`, no detected literals, toasts wrapped.
- 🟡 **partial** — uses `t()` but still has hardcoded literals or unwrapped toasts.
- 🔴 **untranslated** — no `useTranslation`, has hardcoded user-visible text.
- ⚪ **no user-visible text** — UI primitive whose only strings come from props (e.g. shadcn `<Button>`, `<Input>`) or a structural file.

**Priority guide** — same as Part 01:

- **High** — high traffic, user-visible on every session (layout, common dialogs, top-frequency toasts).
- **Medium** — secondary screens, admin/settings dialogs, less-frequent toasts.
- **Low** — UI primitives without user-visible content, dev-only widgets, dead code.

---

## 2. Layout & Navigation

### 2.1 Layout components

| File                                     | Component   | Hardcoded | useT | Toasts (lit / t / apiError) | Status            | Priority | Notes |
| ---------------------------------------- | ----------- | --------: | :--: | :-------------------------: | ----------------- | :------: | ----- |
| `src/app/components/layout/MainLayout.tsx` | MainLayout  |         0 |  n   |          0 / 0 / 0          | ⚪ no text        | Low      | Pure structural wrapper (Sidebar + `<Outlet />`). Holds the collapse-toggle state. |
| `src/app/components/layout/Sidebar.tsx`    | Sidebar     |         0 |  y   |          0 / 0 / 0          | 🟢 full           | High     | Phase 1 ✓. All nav items use `nav.<labelKey>`; Vehicles children translated; "Recruitment Platform" subtitle translated; collapse arrow uses `rtl:rotate-180`. |
| `src/app/components/layout/Topbar.tsx`     | Topbar      |         0 |  y   |          0 / 5 / 0          | 🟡 near-full      | High     | Phase 1 ✓ for chrome (search placeholder, user dropdown, notification bell, language switcher). 6 toast calls; 5 wrapped in `t()`, 1 (`Failed to mark all as read`) wrapped via `t('topbar.markAllReadFailed')`. ChangePassword dialog inside Topbar fully translated via `nav.changePassword.*`. |

### 2.2 Layout sub-components mounted in Topbar / Sidebar

| Concern                              | File / location                                  | Status | Notes |
| ------------------------------------ | ------------------------------------------------ | ------ | ----- |
| Notification bell drop-down panel    | Inside `Topbar.tsx`                              | 🟢     | Header, mark-all, footer link, time-ago, empty-state, unread badge — all from `nav.topbar.*`. |
| User dropdown menu                   | Inside `Topbar.tsx`                              | 🟢     | Profile / Agency Profile / Change Password / Theme / Color Scheme / Logout — from `nav.topbar.*`. |
| ChangePassword dialog (inline modal) | Inside `Topbar.tsx`                              | 🟢     | All labels, placeholders, strength meter, error/success toasts — `nav.changePassword.*`. |
| Language switcher                    | `src/i18n/LanguageSwitcher.tsx`                  | 🟢     | aria-label translated; `LOCALE_LABELS` are native names. |
| Sidebar collapsed-icon tooltip       | Inside `Sidebar.tsx`                             | 🟢     | Tooltip text reads from `nav.<key>`; arrow uses `rtl:translate-x-1`. |

### 2.3 Breadcrumbs, Footer

There is no global breadcrumb component (`src/app/components/ui/breadcrumb.tsx` is the shadcn primitive — exposed but unused in the page tree at this time). The public footer lives inside individual public pages (`LandingPage.tsx`, `DataProcessingAgreement.tsx`) and is fully translated under `public.landing.footer.*` / `public.dpa.*`.

### 2.4 Dashboard cards

The dashboard "cards" (KPI, applicants overview, recruitment workflow, recent activity, recent employees, expired documents, quick actions) are all inlined in `src/app/pages/Dashboard.tsx` — **status 🟢 fully translated** (Phase 1+2). They draw from the `dashboard` namespace.

---

## 3. Shared UI primitives (`src/app/components/ui/*`)

We classify the 50 shadcn/Radix primitives by whether they render any user-visible text of their own.

### 3.1 Primitives that **render their own text** (already translated)

| File                  | Component            | Translated strings                                                  | Source ns / keys                | Status |
| --------------------- | -------------------- | ------------------------------------------------------------------- | ------------------------------- | ------ |
| `ConfirmDialog.tsx`   | `confirm()` defaults | "Are you sure?" / "Confirm" / "Cancel"                              | `ui.confirmDialog.*`            | 🟢     |
| `AddressForm.tsx`     | `<AddressForm>`      | Address Line 1/2, City, Country, Zip + placeholders                 | `ui.address.*`                  | 🟢     |
| `CountrySelect.tsx`   | `<CountrySelect>`    | "Select country" placeholder, "— None —"                            | `ui.country.*`                  | 🟢     |
| `PhoneInput.tsx`      | `<PhoneInput>`       | "Code" placeholder, "e.g. 20 7123 4567"                             | `ui.phone.*`                    | 🟢     |
| `SimpleCaptcha.tsx`   | `<SimpleCaptcha>`    | New challenge title + aria, "Enter the answer", Verified, Incorrect | `ui.captcha.*`                  | 🟢     |
| `pagination.tsx`      | Prev/Next            | aria + sm-screen labels, "More pages" sr-only                        | `ui.pagination.*`               | 🟢     |
| `dialog.tsx`          | Default close button | sr-only "Close"                                                     | `ui.dialog.close`               | 🟢     |
| `sheet.tsx`           | Default close button | sr-only "Close"                                                     | `ui.dialog.close`               | 🟢     |
| `sidebar.tsx` (UI)    | Mobile sheet + rail  | Sheet title/desc (sr-only), Trigger sr-only, Rail aria-label/title  | `ui.sidebar.*`                  | 🟢     |
| `sonner.tsx`          | Toaster              | None of its own; sets `dir` from active locale                       | n/a                             | 🟢     |
| `calendar.tsx`        | DayPicker wrapper    | None directly — uses `date-fns` per-locale data + `rtl:rotate-180`   | n/a                             | 🟢     |

**Total above: 11 primitives, all 🟢.**

### 3.2 Primitives with **no user-visible text** (pass-through wrappers)

The following are pure structural shadcn primitives that only render text supplied by callers — translation belongs to the caller, not the primitive:

```
accordion alert alert-dialog aspect-ratio avatar badge breadcrumb button card
carousel chart checkbox collapsible command context-menu drawer dropdown-menu
form hover-card input input-otp label menubar navigation-menu popover progress
radio-group ReCaptchaV2 resizable scroll-area select separator skeleton slider
switch table tabs textarea toggle toggle-group tooltip
```

**Status:** ⚪ no text — **39 primitives**.

> Two minor exceptions:
> - `alert.tsx` — has a 1-character literal hit (false positive, structural).
> - `carousel.tsx` — 2 literal hits (sr-only text); see §6.

### 3.3 Component file recap

```
ui primitives translated:        11
ui primitives no-text:           39
ui primitives partial/needs work: 2  (alert.tsx, carousel.tsx — minor)
```

---

## 4. Feature components (non-page, non-UI-primitive)

Files under `src/app/components/{applicants,attendance,employees,finance,filters,workflow}` and the standalone WhatsAppButton.

| File                                                    | Hardcoded | useT | Toast (lit / t) | Has dialog | Has table | Status         | Priority | Notes |
| ------------------------------------------------------- | --------: | :--: | :-------------: | :--------: | :-------: | -------------- | :------: | ----- |
| `applicants/ApplicantFormSteps.tsx`                     |   **138** |  n   |     0 / 0       |     n      |    n      | 🔴 untranslated | **High** | The single biggest hotspot in the codebase. Multi-step form embedded inside `/apply` and `Add/Edit Applicant`. ~138 visible English strings: section headers, field labels, placeholders, validation hints, declarations. |
| `applicants/ApplicantPdfExport.tsx`                     |        23 |  n   |     0 / 0       |     n      |    n      | 🔴 untranslated | Medium   | Generates PDF — uses `@react-pdf/renderer`. Strings inside the PDF are embedded English. |
| `applicants/ApplicationDataView.tsx`                    |        17 |  n   |     0 / 0       |     n      |    n      | 🔴 untranslated | High     | Read-only display of applicant data; reused inside profile pages. |
| `attendance/AttendanceTab.tsx`                          |         1 |  n   |    6 / 0        |     y      |    y      | 🔴 untranslated | High     | Editable attendance grid; inline dialogs for lock/unlock, shift edits. 13 toast invocations — 6 hardcoded literals. |
| `employees/EmployeePdfDocument.tsx`                     |         4 |  n   |     0 / 0       |     n      |    n      | 🔴 untranslated | Medium   | Generated PDF (`@react-pdf/renderer`). |
| `employees/WorkHistoryTimeline.tsx`                     |         6 |  n   |    7 / 0        |     y      |    n      | 🔴 untranslated | High     | Embedded inside EmployeeProfile / EditEmployee; dialogs for add / edit / delete history rows. 12 toasts, 7 literal. Calls `confirm({…})` for delete with hardcoded title/body. |
| `figma/ImageWithFallback.tsx`                           |         0 |  n   |     0 / 0       |     n      |    n      | ⚪ no text      | Low      | Pure renderer. |
| `filters/FilterSystem.tsx`                              |         5 |  n   |     0 / 0       |     n      |    n      | 🔴 untranslated | High     | Reusable filter chip system used by EmployeeDocumentExplorer and other list pages. Filter labels and "Clear all" remain English. |
| `finance/FinancialRecordsTab.tsx`                       |        30 |  n   |   14 / 0        |     n      |    y      | 🔴 untranslated | High     | Embedded in ApplicantProfile / CandidateProfile / EmployeeProfile / FinanceDashboard. Phase 2 fixed `Intl` formatters here; strings & toasts still English. 22 toast invocations / 14 literals. |
| `WhatsAppButton.tsx`                                    |         0 |  n   |     0 / 0       |     n      |    n      | ⚪ no text      | Low      | Floating WhatsApp link. |
| `workflow/StageTransition.tsx`                          |         4 |  n   |     0 / 0       |     y      |    n      | 🔴 untranslated | Medium   | Transition dialog (advance/skip/reject) inside workflow pages. |

**Sub-totals**

- 11 feature components.
- 9 are 🔴 untranslated (231 hardcoded literals total inside these 9 files alone).
- 2 are ⚪ no text.
- 0 use `useTranslation` today.

`ApplicantFormSteps.tsx` alone accounts for 138/231 = **60%** of the non-UI feature-component literal load.

---

## 5. Dialogs / modals / drawers / popovers — by call site

We found **24 page files** that mount one or more `<Dialog>` / `<AlertDialog>` / `<Sheet>` / `<Drawer>` / `<Popover>`, and **27 page files** that call the imperative `confirm({ … })`.

### 5.1 Imperative `confirm({…})` call sites (delete / restore / lock confirmations)

`confirm()` is a host-rendered dialog whose **default labels** (title, confirm, cancel) are translated via `ui.confirmDialog.*`. But callers can pass `title` / `description` / `confirmText` / `cancelText` — and most callers pass **English literals**.

| Page file                                                      | useT | Notes |
| -------------------------------------------------------------- | :--: | ----- |
| `pages/applicants/ApplicantProfile.tsx`                        |  n   | Delete applicant, convert to candidate. **English literals.** |
| `pages/applicants/ApplicantsList.tsx`                          |  y   | Delete confirmation: bulk + per-row. **English literals** still passed to `confirm`. |
| `pages/applicants/CandidateProfile.tsx`                        |  n   | Convert / delete confirmations. English. |
| `pages/applicants/CandidatesList.tsx`                          |  y   | Bulk delete confirmation. English. |
| `pages/attendance/AttendanceList.tsx`                          |  y   | Lock / unlock period confirmation. English. |
| `pages/attendance/AttendanceSheet.tsx`                         |  n   | Save / lock / discard. English. |
| `pages/documents/DocumentPreview.tsx`                          |  n   | Approve / reject / delete confirms. English. |
| `pages/documents/DocumentsCompliance.tsx`                      |  y   | Bulk approve / delete. English. |
| `pages/documents/DocumentVerification.tsx`                     |  y   | Approve / reject batch. English. |
| `pages/logs/LogsDashboard.tsx`                                 |  y   | Clear logs confirmation. English. |
| `pages/pipelines/WorkflowSettingsPage.tsx`                     |  n   | Delete stage / archive workflow. English. |
| `pages/recycle-bin/DeletedRecords.tsx`                         |  y   | Restore + permanently delete confirms. English. |
| `pages/roles/RolesList.tsx`                                    |  y   | Delete role. English. |
| `pages/settings/DatabaseBackup.tsx`                            |  n   | Restore backup, delete backup. English. |
| `pages/settings/DatabaseCleanup.tsx`                           |  n   | Run cleanup. English. |
| `pages/settings/DocumentTypes.tsx`                             |  n   | Delete document type. English. |
| `pages/settings/DocumentTypeView.tsx`                          |  n   | Delete from view. English. |
| `pages/settings/JobTypes.tsx`                                  |  n   | Delete job type. English. |
| `pages/settings/MaintenanceTypesSettings.tsx` *(orphan file)*  |  n   | Delete maintenance type. English. |
| `pages/settings/SkillsSettings.tsx`                            |  n   | Delete skill. English. |
| `pages/settings/TransactionTypesSettings.tsx`                  |  n   | English. |
| `pages/settings/TrailerTypesSettings.tsx`                      |  n   | English. |
| `pages/settings/TransportTypesSettings.tsx`                    |  n   | English. |
| `pages/settings/TruckBrandsSettings.tsx`                       |  n   | English. |
| `pages/settings/VehicleSettings.tsx`                           |  n   | English. |
| `pages/settings/WorkHistoryEventTypesSettings.tsx`             |  n   | English. |
| `pages/users/UsersList.tsx`                                    |  y   | Activate / deactivate / delete. English. |
| `pages/vehicles/MaintenanceTypesList.tsx`                      |  n   | Delete. English. |
| `pages/vehicles/VehicleDetail.tsx`                             |  n   | Multiple confirms. English. |
| `pages/vehicles/VehiclesList.tsx`                              |  y   | Delete vehicle. English. |
| `pages/vehicles/WorkshopsList.tsx`                             |  y   | Delete workshop. English. |
| `pages/workflow/WorkflowOverview.tsx`                          |  y   | English. |

### 5.2 `<Dialog>` / `<AlertDialog>` / `<Sheet>` / `<Drawer>` / `<Popover>` mount sites

Each entry is a custom modal that ships its own JSX (titles, body, action buttons). All listed below contain hardcoded English strings unless marked 🟢.

| Page file                                                | Modal purpose(s)                                          | Status | Priority |
| -------------------------------------------------------- | --------------------------------------------------------- | ------ | :------: |
| `pages/agencies/AgenciesList.tsx`                        | Bulk export sheet, filter popover                         | 🔴     | High     |
| `pages/agencies/AgencyUsersManagement.tsx`               | Add/edit user dialog, deactivate confirmation             | 🔴     | Medium   |
| `pages/agencies/EditAgency.tsx`                          | Permission overrides dialog, delete agency confirm        | 🟡     | Medium   |
| `pages/applicants/AddApplicant.tsx`                      | Required-document upload dialog                           | 🟡     | High     |
| `pages/applicants/ApplicantProfile.tsx`                  | Add note dialog, convert dialog, finance entry dialog     | 🔴     | **High** |
| `pages/applicants/ApplicantsList.tsx`                    | Bulk-action sheet, column picker, filter sheet            | 🟡     | High     |
| `pages/applicants/CandidateDeleteRequests.tsx`           | Approve/reject dialog                                     | 🔴     | Medium   |
| `pages/applicants/CandidateProfile.tsx`                  | Same set as ApplicantProfile + workflow assignment        | 🔴     | **High** |
| `pages/applicants/CandidatesList.tsx`                    | Same as ApplicantsList                                    | 🟡     | High     |
| `pages/documents/DocumentPreview.tsx`                    | Reject reason dialog, history popover                     | 🔴     | High     |
| `pages/documents/DocumentsCompliance.tsx`                | Filter sheet, bulk action sheet                           | 🟡     | High     |
| `pages/employees/EmployeeProfile.tsx`                    | Add note, finance, training entry dialogs                 | 🔴     | **High** |
| `pages/employees/EmployeesList.tsx`                      | Column picker popover, filter sheet                       | 🟡     | High     |
| `pages/job-ads/JobAdsList.tsx`                           | Archive / publish confirmation dialog                     | 🟡     | Medium   |
| `pages/pipelines/WorkflowSettingsPage.tsx`               | New stage dialog, edit stage drawer, assignees popover    | 🔴     | Medium   |
| `pages/pipelines/WorkflowsPage.tsx`                      | New workflow dialog (header translated, body 🔴)          | 🟡     | Medium   |
| `pages/reports/ReportsDashboard.tsx`                     | New report wizard sheet, save dialog, export dialog       | 🟡     | High     |
| `pages/settings/MaintenanceTypesSettings.tsx`            | Add/edit dialog                                           | 🔴     | Low      |
| `pages/settings/VehicleSettings.tsx`                     | Multiple add/edit dialogs                                 | 🔴     | Medium   |
| `pages/users/EditUser.tsx`                               | Permission override dialog, deactivate confirm            | 🟡     | Medium   |
| **Inside feature components**                            |                                                          |        |          |
| `components/attendance/AttendanceTab.tsx`                | Lock/unlock period dialog, shift edit                     | 🔴     | High     |
| `components/employees/WorkHistoryTimeline.tsx`           | Add/edit work-history entry dialog                        | 🔴     | High     |
| `components/workflow/StageTransition.tsx`                | Advance/skip/reject dialog                                | 🔴     | Medium   |
| `components/ui/ConfirmDialog.tsx`                        | Imperative confirm host (default labels translated)       | 🟢     | n/a      |
| `Topbar.tsx > ChangePasswordDialog`                      | Inline change-password modal                              | 🟢     | n/a      |

**Note on the `ChangePassword` dialog vs. page.** The Topbar inline dialog (`<DialogContent>`) is fully translated; the standalone *page* at `/dashboard/change-password` (different file: `pages/profile/ChangePassword.tsx`) is partial — title/subtitle translated, validation rules and toast messages still hardcoded. The two should be unified onto the same key set during the next pass.

---

## 6. Forms

19 page files mount a `<form>` directly. Plus large embedded forms inside feature components.

### 6.1 Primary forms

| File                                       | Form purpose                       | useT | Hardcoded literals* | Status         | Priority |
| ------------------------------------------ | ---------------------------------- | :--: | :-----------------: | -------------- | :------: |
| `pages/public/LoginPage.tsx`               | Login + 2FA                        |  y   |          0          | 🟢 full        | n/a      |
| `pages/public/ForgotPasswordPage.tsx`      | Forgot password                    |  y   |          0          | 🟢 full        | n/a      |
| `pages/public/ResetPasswordPage.tsx`       | Reset password                     |  y   |          0          | 🟢 full        | n/a      |
| `pages/public/ActivationPage.tsx`          | Account activation                 |  y   |          0          | 🟢 full        | n/a      |
| `components/applicants/ApplicantFormSteps.tsx` | Multi-step applicant application | **n** |       **138**      | 🔴 untranslated | **High** |
| `pages/applicants/AddApplicant.tsx`        | Wraps ApplicantFormSteps           |  y   |          4          | 🟡 partial     | High     |
| `pages/applicants/EditApplicant.tsx`       | Wraps ApplicantFormSteps           |  y   |          5          | 🟡 partial     | High     |
| `pages/applicants/EditCandidate.tsx`       | Wraps ApplicantFormSteps           |  y   |          5          | 🟡 partial     | High     |
| `pages/employees/AddEmployee.tsx`          | Add employee                       |  y   |         24          | 🟡 partial     | High     |
| `pages/employees/EditEmployee.tsx`         | Edit employee                      |  y   |         27          | 🟡 partial     | High     |
| `pages/agencies/AddAgency.tsx`             | Add agency                         |  y   |         15          | 🟡 partial     | High     |
| `pages/agencies/EditAgency.tsx`            | Edit agency                        |  y   |         18          | 🟡 partial     | Medium   |
| `pages/users/AddUser.tsx`                  | Add user                           |  y   |         16          | 🟡 partial     | High     |
| `pages/users/EditUser.tsx`                 | Edit user                          |  y   |         25          | 🟡 partial     | High     |
| `pages/documents/DocumentUpload.tsx`       | Upload document                    |  n   |         12          | 🔴 untranslated | High     |
| `pages/documents/EditDocument.tsx`         | Edit document                      |  n   |          9          | 🔴 untranslated | Medium   |
| `pages/profile/ChangePassword.tsx`         | Change password (page version)     |  y   |          9          | 🟡 partial     | High     |
| `pages/profile/UserPreferences.tsx`        | Preferences (lang/tz/notifs)       |  y   |         24          | 🟡 partial     | High     |
| `pages/vehicles/VehicleForm.tsx`           | Add/Edit vehicle                   |  n   |         21          | 🔴 untranslated | High     |
| `pages/settings/DocumentTypeNew.tsx`       | New document type                  |  n   |         26          | 🔴 untranslated | Medium   |
| `pages/settings/DocumentTypeEdit.tsx`      | Edit document type                 |  n   |         26          | 🔴 untranslated | Medium   |
| `pages/pipelines/WorkflowsPage.tsx`        | Inline new-workflow form           |  y   |          8          | 🟡 partial     | Medium   |
| `pages/pipelines/WorkflowBoardPage.tsx`    | Inline forms for stage notes       |  n   |          8          | 🔴 untranslated | Medium   |

\* count is per-file — includes the form fields and the surrounding chrome.

### 6.2 What's missing in "partial" forms

The Phase 3 page-chrome PR translated headers, primary buttons and search placeholders. What still ships as English on the partial forms above:

- **Section headings** inside cards (e.g. "Personal Information", "Driving License", "Education", "Work Experience", "Skills" inside the applicant form).
- **Field labels and placeholders** — every `<Label>` + `<Input placeholder>`.
- **Helper / hint text** — short paragraphs explaining required documents, validation rules, password strength.
- **Inline validation hints** — "Please fill all required fields", "Photo is required", "Passwords do not match" (some of these are in `auth.json` but only the auth flow uses them).
- **Toggle/select option labels** that aren't enum-derived (e.g. "Yes" / "No" radio buttons).
- **Submit button labels** — "Save Changes", "Save and continue", "Submit", "Cancel" (some use `common.actions.*`, many do not).

### 6.3 Validation messages

`react-hook-form` + ad-hoc validators emit messages straight from JSX strings (no `class-validator` on the frontend). Backend validation messages are out of scope for this audit (see Part 04 backend). Today the frontend validation hints are 100% English.

---

## 7. Tables / lists / grids

30 page files render a `<Table>` (shadcn) or hand-rolled `<thead>/<tbody>`. The shadcn `<Table>` primitive itself has no built-in text — column headers, body rows, empty states, and row actions are supplied by callers.

### 7.1 Status by page

| File                                              | Status         | Headers translated | Empty state | Action labels (View/Edit/Delete) | Notes |
| ------------------------------------------------- | -------------- | :----------------: | :---------: | :------------------------------: | ----- |
| `pages/employees/EmployeesList.tsx`               | 🟡 partial     |    🟡 (3 of 6)    |     🔴      |     mix (some via `pages.employees.list.actions.*`)     | Status badge uses `enums.employeeStatus` ✓ |
| `pages/applicants/ApplicantsList.tsx`             | 🟡 partial     |    🔴             |     🔴      |     🔴                            | Status badge uses `enums.applicantStatus` ✓ |
| `pages/applicants/CandidatesList.tsx`             | 🟡 partial     |    🔴             |     🔴      |     🔴                            | Same as above |
| `pages/agencies/AgenciesList.tsx`                 | 🟡 partial     |    🔴             |     🔴      |     🔴                            | |
| `pages/users/UsersList.tsx`                       | 🟡 partial     |    🔴             |     🔴      |     🔴                            | |
| `pages/roles/RolesList.tsx`                       | 🟡 partial     |    🔴             |     🔴      |     🔴                            | |
| `pages/roles/CreateRole.tsx`                      | 🔴             |    🔴             |     🔴      |     🔴                            | Permissions matrix table |
| `pages/roles/PermissionsMatrix.tsx`               | 🔴             |    🔴             |     🔴      |     n/a                           | |
| `pages/vehicles/VehiclesList.tsx`                 | 🟡 partial     |    🔴             |     🔴      |     🔴                            | Status badge uses `enums.maintenanceStatus` ✓ |
| `pages/vehicles/MaintenanceRecordsList.tsx`       | 🟡 partial     |    🔴             |     🔴      |     🔴                            | |
| `pages/vehicles/MaintenanceTypesList.tsx`         | 🔴             |    🔴             |     🔴      |     🔴                            | |
| `pages/vehicles/WorkshopsList.tsx`                | 🟡 partial     |    🔴             |     🔴      |     🔴                            | |
| `pages/vehicles/VehicleDetail.tsx`                | 🔴             |    🔴             |     🔴      |     🔴                            | Documents table, maintenance table |
| `pages/documents/DocumentsCompliance.tsx`         | 🟡 partial     |    🔴             |     🔴      |     🔴                            | |
| `pages/documents/DocumentsDashboard.tsx`          | 🟡 partial     |    🔴             |     🔴      |     🔴                            | |
| `pages/documents/DocumentVerification.tsx`        | 🟡 partial     |    🔴             |     🔴      |     🔴                            | |
| `pages/documents/EmployeeDocumentExplorer.tsx`    | 🟡 partial     |    🔴             |     🔴      |     🔴                            | |
| `pages/finance/FinanceDashboard.tsx`              | 🟡 partial     |    🔴             |     🔴      |     🔴                            | Currency formatted via `formatCurrency` ✓ |
| `pages/job-ads/JobAdsList.tsx`                    | 🟡 partial     |    🔴             |     🔴      |     🔴                            | |
| `pages/attendance/AttendanceList.tsx`             | 🟡 partial     |    🔴             |     🔴      |     🔴                            | |
| `pages/attendance/AttendanceSheet.tsx`            | 🔴             |    🔴             |     🔴      |     🔴                            | Date columns formatted via `Intl` (locale OK) |
| `pages/notifications/NotificationCenter.tsx`     | 🟡 partial     |    🔴 (list, not table) | 🔴   |     🔴                            | Type icons + badges from `enums.notificationType` ✓ |
| `pages/logs/LogsDashboard.tsx`                    | 🟡 partial     |    🔴             |     🔴      |     🔴                            | |
| `pages/recycle-bin/DeletedRecords.tsx`            | 🟡 partial     |    🔴             |     🔴      |     🔴                            | |
| `pages/reports/ReportsDashboard.tsx`              | 🟡 partial     |    🔴             |     🔴      |     🔴                            | |
| `pages/compliance/ComplianceDashboard.tsx`        | 🟢 fully       |    🔴             |     🔴      |     🔴                            | Page chrome translated; row data English |
| `pages/settings/DocumentTypes.tsx`                | 🔴             |    🔴             |     🔴      |     🔴                            | |
| `pages/settings/DatabaseBackup.tsx`               | 🔴             |    🔴             |     🔴      |     🔴                            | |
| `pages/workflow/WorkPermitTracking.tsx`           | 🔴             |    🔴             |     🔴      |     🔴                            | |
| `pages/workflow/VisaTracking.tsx`                 | 🔴             |    🔴             |     🔴      |     🔴                            | |
| **Embedded tables in feature components**         |                |                    |             |                                  | |
| `components/finance/FinancialRecordsTab.tsx`      | 🔴             |    🔴             |     🔴      |     🔴                            | Used inside multiple profile pages |
| `components/attendance/AttendanceTab.tsx`         | 🔴             |    🔴             |     🔴      |     🔴                            | |

### 7.2 Common table strings ripe for `common.json`

The following appear in nearly every list page and should be promoted to a single shared key set:

```
common.table.empty                  "No results"
common.table.loading                "Loading…"
common.table.noResultsForFilter     "No results match your filters"
common.table.rowsPerPage            "Rows per page"
common.table.of                     "of"
common.table.page                   "Page {{current}} of {{total}}"
common.table.selected_one           "{{count}} row selected"
common.table.selected_other         "{{count}} rows selected"
common.table.clearSelection         "Clear selection"
common.table.exportSelected         "Export selected"
common.actions.exportCsv            "Export CSV"
common.actions.exportExcel          "Export Excel"
common.actions.exportPdf            "Export PDF"
common.actions.refresh              "Refresh"
common.actions.columns              "Columns"
```

`common.json` already has `actions.*`, `states.*`, `language.*`, `branding.*` — extend with a `table.*` block and a few extra `actions.*` keys, then dashboard-wide tables can drop their per-page literals.

---

## 8. Toasts, alerts, messages

**Top-level numbers (pages + components)**

| Metric                                | Count |
| ------------------------------------- | ----: |
| Files calling `toast.<level>(…)`     |    74 |
| Total `toast.<level>(…)` invocations |   602 |
| Hardcoded literal-string toasts      |   367 |
| Wrapped in `t(…)`                    |    18 |
| Wrapped in `apiError(…)`             |     1 |
| Effectively unwrapped                | ~600  |

**Translation rate for toasts:** ~3% — the lowest-translated surface in the app and the most visible after page load.

### 8.1 Pages with the most untranslated toasts

| #  | File                                                  | Literal toasts |
| -- | ----------------------------------------------------- | -------------: |
|  1 | `pages/applicants/CandidateProfile.tsx`               |             24 |
|  2 | `pages/applicants/ApplicantProfile.tsx`               |             23 |
|  3 | `pages/vehicles/VehicleDetail.tsx`                    |             17 |
|  4 | `pages/employees/EmployeeProfile.tsx`                 |             15 |
|  5 | `pages/applicants/CandidatesList.tsx`                 |             14 |
|  6 | `pages/agencies/EditAgency.tsx`                       |             14 |
|  7 | `components/finance/FinancialRecordsTab.tsx`          |             14 |
|  8 | `pages/applicants/ApplicantsList.tsx`                 |             10 |
|  9 | `pages/agencies/AddAgency.tsx`                        |             10 |
| 10 | `pages/vehicles/VehicleForm.tsx`                      |              8 |
| 11 | `pages/users/UsersList.tsx`                           |              8 |
| 12 | `pages/settings/VehicleSettings.tsx`                  |              8 |
| 13 | `pages/reports/ReportsDashboard.tsx`                  |              8 |
| 14 | `pages/job-ads/JobAdForm.tsx`                         |              7 |
| 15 | `pages/vehicles/WorkshopsList.tsx`                    |              7 |
| 16 | `pages/vehicles/MaintenanceTypesList.tsx`             |              7 |
| 17 | `pages/vehicles/MaintenanceRecordsList.tsx`           |              7 |
| 18 | `components/attendance/AttendanceTab.tsx`             |              6 |
| 19 | `components/employees/WorkHistoryTimeline.tsx`        |              7 |
| 20 | `pages/employees/EmployeesList.tsx`                   |              6 |

### 8.2 Common toast message families

Most untranslated toasts repeat the same 12-or-so phrasings across the app. Promote these into shared keys (proposed location below):

```
toasts.created.<entity>          e.g. "Employee created"
toasts.updated.<entity>          e.g. "Vehicle updated"
toasts.deleted.<entity>          e.g. "Document deleted"
toasts.restored.<entity>          e.g. "Record restored"
toasts.archived.<entity>
toasts.published.<entity>
toasts.copied                     "Copied to clipboard"
toasts.uploadStarted              "Upload started"
toasts.uploadComplete             "Upload complete"
toasts.exportStarted              "Generating export…"
toasts.exportComplete             "Export ready"
toasts.exportFailed               "Export failed"
toasts.networkOffline             "No internet connection"
toasts.errorGeneric               "Something went wrong"
toasts.savePreferencesSuccess     "Preferences saved"
toasts.permissionDenied           "You don't have permission to do that"
```

Backend errors should flow through `apiError(err, t('toasts.errorGeneric'))`; plain success messages can use `common.toast.<verb>` keys.

### 8.3 Error-bar / inline alert messages (non-toast)

Several pages render an inline red alert via `setError('…')`. Examples:

| File                                                 | Trigger                              | Status |
| ---------------------------------------------------- | ------------------------------------ | ------ |
| `pages/public/LoginPage.tsx`                         | Login / 2FA failure                  | 🟢 (uses `apiError`) |
| `pages/public/ResetPasswordPage.tsx`                 | Token / strength / mismatch errors   | 🟢 |
| `pages/public/ActivationPage.tsx`                    | Token / strength / mismatch errors   | 🟢 |
| `pages/public/ForgotPasswordPage.tsx`                | Submission failure                   | 🟢 |
| `pages/profile/ChangePassword.tsx`                   | Validation errors                    | 🔴 |
| `pages/applicants/ApplicantProfile.tsx`              | Conversion / save errors             | 🔴 |
| `pages/employees/EmployeeProfile.tsx`                | Save errors                          | 🔴 |
| `pages/vehicles/VehicleDetail.tsx`                   | Save / delete errors                 | 🔴 |
| `pages/settings/DatabaseBackup.tsx`                  | Restore errors                       | 🔴 |

---

## 9. Top 20 components / forms / tables to translate next

Ranked by **(literal count) × (visible frequency)**. Items that cascade across multiple pages (shared components) are prioritized over single-page items with similar literal counts.

| #  | File                                                  | Type        | Untranslated literals | Reach                              | Priority |
| -- | ----------------------------------------------------- | ----------- | --------------------: | ---------------------------------- | :------: |
|  1 | `components/applicants/ApplicantFormSteps.tsx`        | Form        |                  138  | `/apply` + Add/Edit Applicant + Edit Candidate (4 routes)  | **High** |
|  2 | `pages/applicants/ApplicantProfile.tsx`               | Page+modal  |                   72  | Profile detail (high traffic)       | **High** |
|  3 | `pages/applicants/CandidateProfile.tsx`               | Page+modal  |                   69  | Profile detail (high traffic)       | **High** |
|  4 | `pages/vehicles/VehicleDetail.tsx`                    | Page+table  |                   39  | Vehicle detail with embedded tables | **High** |
|  5 | `components/finance/FinancialRecordsTab.tsx`          | Component   |                   30  | Embedded in 4 profile pages + Finance dashboard | **High** |
|  6 | `pages/employees/EditEmployee.tsx`                    | Form        |                   27  | Employee edit                       | High     |
|  7 | `pages/users/EditUser.tsx`                            | Form        |                   25  | User admin                          | High     |
|  8 | `pages/employees/AddEmployee.tsx`                     | Form        |                   24  | Employee add                        | High     |
|  9 | `pages/applicants/CandidatesList.tsx`                 | Page+table  |                   24  | Candidates list (high traffic)      | High     |
| 10 | `pages/finance/FinanceDashboard.tsx`                  | Page+table  |                   24  | Finance dashboard                   | High     |
| 11 | `pages/profile/UserPreferences.tsx`                   | Form        |                   24  | Already partial; finish the form    | High     |
| 12 | `components/applicants/ApplicantPdfExport.tsx`        | PDF         |                   23  | Export file                         | Medium   |
| 13 | `pages/employees/EmployeeProfile.tsx`                 | Page+modal  |                   22  | Profile detail                      | High     |
| 14 | `pages/documents/EmployeeDocumentExplorer.tsx`        | Page+table  |                   22  | Document explorer                   | Medium   |
| 15 | `pages/vehicles/VehicleForm.tsx`                      | Form        |                   21  | Add/Edit vehicle                    | High     |
| 16 | `pages/logs/LogsDashboard.tsx`                        | Page+table  |                   21  | Audit logs                          | Medium   |
| 17 | `pages/applicants/ApplicantsList.tsx`                 | Page+table  |                   19  | Applicants list (high traffic)      | High     |
| 18 | `pages/workflow/WorkflowAnalytics.tsx`                | Page+chart  |                   19  | Charts                              | Medium   |
| 19 | `pages/agencies/EditAgency.tsx`                       | Form        |                   18  | Agency edit                         | Medium   |
| 20 | `pages/documents/DocumentsCompliance.tsx`             | Page+table  |                   18  | Compliance hub                      | High     |

Honourable mentions (just under): `pages/users/UsersList.tsx` (17), `components/applicants/ApplicationDataView.tsx` (17), `pages/employees/EmployeeComplianceTimeline.tsx` (17), `pages/users/AddUser.tsx` (16), `pages/agencies/AgencyProfile.tsx` (16), `pages/agencies/AddAgency.tsx` (15), `pages/profile/Profile.tsx` (15).

---

## 10. Common shared strings → `common.json`

The audit kept finding the same handful of phrases hardcoded in dozens of files. Promote these into `common.json` so every page consumes one source:

```jsonc
{
  "actions": {                         // already exists; extend
    "save": "Save",
    "saveChanges": "Save changes",
    "saveAndContinue": "Save and continue",
    "submit": "Submit",
    "create": "Create",
    "update": "Update",
    "delete": "Delete",
    "remove": "Remove",
    "archive": "Archive",
    "restore": "Restore",
    "approve": "Approve",
    "reject": "Reject",
    "duplicate": "Duplicate",
    "copy": "Copy",
    "yes": "Yes",
    "no": "No",
    "refresh": "Refresh",
    "exportCsv": "Export CSV",
    "exportExcel": "Export Excel",
    "exportPdf": "Export PDF",
    "columns": "Columns",
    "selectAll": "Select all",
    "clearAll": "Clear all",
    "clearFilters": "Clear filters"
  },
  "states": {                          // already exists; extend
    "loading": "Loading…",
    "saving": "Saving…",
    "submitting": "Submitting…",
    "uploading": "Uploading…",
    "empty": "No results",
    "noResults": "No results match your filters.",
    "error": "Something went wrong",
    "tryAgain": "Please try again",
    "comingSoon": "Coming soon",
    "notImplemented": "Not implemented yet"
  },
  "table": {                           // NEW
    "rowsPerPage": "Rows per page",
    "of": "of",
    "page": "Page {{current}} of {{total}}",
    "selected_one": "{{count}} row selected",
    "selected_other": "{{count}} rows selected",
    "clearSelection": "Clear selection",
    "exportSelected": "Export selected",
    "noResults": "No results"
  },
  "filters": {                         // NEW
    "all": "All",
    "active": "Active",
    "inactive": "Inactive",
    "from": "From",
    "to": "To",
    "search": "Search",
    "advancedFilters": "Advanced filters",
    "clear": "Clear"
  },
  "toast": {                           // NEW
    "created": "Created",
    "updated": "Updated",
    "deleted": "Deleted",
    "restored": "Restored",
    "archived": "Archived",
    "published": "Published",
    "saved": "Saved",
    "copied": "Copied to clipboard",
    "exportStarted": "Generating export…",
    "exportComplete": "Export ready",
    "exportFailed": "Export failed",
    "uploadStarted": "Upload started",
    "uploadComplete": "Upload complete",
    "uploadFailed": "Upload failed",
    "networkOffline": "No internet connection",
    "permissionDenied": "You don't have permission to do that"
  },
  "form": {                            // NEW
    "required": "Required",
    "optional": "Optional",
    "fieldRequired": "This field is required",
    "selectOption": "Select an option",
    "yes": "Yes",
    "no": "No",
    "saving": "Saving…",
    "saveSuccess": "Saved successfully"
  }
}
```

> **Plural rule reminder.** For Russian (`ru`), Slovak (`sk`) and Arabic
> (`ar`), `selected_*` and any other counted noun needs `_few`, `_many`,
> and (Arabic only) `_zero`, `_two`. The existing key-parity script
> (`scripts/i18n-check-keys.mjs`) is plural-aware.

---

## 11. Module-specific namespaces needed

These are the namespaces the audit recommends adding or extending. Today
we have 9 namespaces (`common, nav, auth, public, dashboard, ui, pages,
errors, enums`). The ones below are **proposed** as new sub-trees inside
existing namespaces — no new top-level namespace is required, which keeps
the lazy-load split count predictable.

| Sub-namespace                   | Inside                | Why |
| ------------------------------- | --------------------- | ----- |
| `pages.applicants.profile`      | `pages`               | ApplicantProfile + CandidateProfile share most strings; tabs, action buttons, finance & note dialogs |
| `pages.candidates.profile`      | `pages`               | CandidateProfile-only deltas (workflow assignment, conversion to employee) |
| `pages.employees.profile`       | `pages`               | EmployeeProfile tabs, work history, certifications, training, compliance, performance, finance |
| `pages.agencies.profile`        | `pages`               | AgencyProfile + EditAgency permission-override dialog |
| `pages.vehicles.detail`         | `pages`               | VehicleDetail (39 literals) and embedded documents/maintenance tables |
| `pages.vehicles.form`           | `pages`               | VehicleForm fields, sections, validation hints |
| `pages.documents.preview`       | `pages`               | DocumentPreview reject reason dialog, history popover |
| `pages.documents.upload`        | `pages`               | Upload form, drag-and-drop hints, file constraints |
| `pages.workflow.analytics`      | `pages`               | Analytics page (charts axes labels, KPI tiles) |
| `pages.workflow.tracking`       | `pages`               | WorkPermitTracking + VisaTracking (very similar) |
| `pages.settings.documentTypes`  | `pages`               | New / Edit / View screens |
| `pages.settings.security`       | `pages`               | Security policy form |
| `pages.settings.systemInfo`     | `pages`               | Diagnostics labels |
| `pages.settings.databaseBackup` | `pages`               | Backup management |
| `pages.profile.preferences`     | `pages`               | Preferences page (lang/tz already partial) |
| `applicants.form`               | NEW namespace `forms` | Multi-step applicant form — large enough to justify its own ns |
| `forms.fields`                  | NEW namespace `forms` | Generic field labels reused across forms (Name, Email, Phone, Address, …) |
| `forms.validation`              | NEW namespace `forms` | Inline validation messages |
| `tables.<module>`               | NEW namespace `tables`| Per-module column headers and row actions |
| `toasts.<entity>`               | NEW namespace `toasts`| Standardized toast templates |

Recommendation: add **two new namespaces** — `forms` and `tables` (and optionally `toasts` if `common.toast.*` proves too generic). This keeps the bundle split tidy and lets the literal scanner attribute hits.

---

## 12. Recommended Phase 2 implementation scope

> "Phase 2" of the post-audit work — independent of the original five-phase plan.

### 12.1 Goal

Turn the dashboard's most-touched detail surfaces from English bodies into translated bodies, and standardize toast / table / form chrome.

### 12.2 Scope

1. **New shared keys (low-risk, parallel-safe).**
   Extend `common.json` with `table.*`, `filters.*`, `toast.*`, `form.*`
   blocks (see §10). Add `forms` and `tables` namespaces as scaffolds with
   English seeded; Russian/Slovak/Arabic plural variants from day one.

2. **Promote `apiError(err)` to every catch block that toasts.**
   Replace `toast.error(err?.message ?? 'Failed to …')` with
   `toast.error(apiError(err, t('toast.errorGeneric')))`. Sweep the 70+
   files. Mostly mechanical.

3. **Detail / profile pages (the daily-use bodies).**
   Translate:
   - `ApplicantProfile.tsx`
   - `CandidateProfile.tsx`
   - `EmployeeProfile.tsx`
   - `AgencyProfile.tsx`
   - `VehicleDetail.tsx`
   - All embedded tabs (`WorkHistoryTimeline`, `FinancialRecordsTab`,
     `AttendanceTab`, `ApplicationDataView`).

4. **Big forms.**
   - `ApplicantFormSteps.tsx` — the largest hotspot. Extract a
     `forms.applicant.*` keyset; translate steps, sections, fields,
     validation, declaration text, submit/back buttons.
   - `VehicleForm.tsx`, `DocumentUpload.tsx`, `EditDocument.tsx`.
   - `DocumentTypeNew.tsx` / `DocumentTypeEdit.tsx`.

5. **Reusable feature components.**
   - `FilterSystem.tsx` — reach: list pages.
   - `StageTransition.tsx` — reach: workflow pages.
   - `WorkHistoryTimeline.tsx` — reach: employee profile.
   - `AttendanceTab.tsx` — reach: attendance + employee profile.

6. **Confirm-dialog literals.**
   For every `confirm({ title: 'Delete …', description: '…', … })` call,
   replace the literal title/description/confirmText with `t(…)` from
   the appropriate `pages.<module>.list.deleteConfirm.*` keys (some
   already exist; some need adding).

7. **Inline validation hints.**
   Extract the ~50 inline form-validation strings into
   `forms.validation.*` and route both old and new validators through
   `t()`.

### 12.3 Out of scope for this Phase 2

- PDF / Excel / CSV export contents — defer until backend export labels
  audit (Part 04).
- The legal body of `DataProcessingAgreement.tsx` — wait for legal
  review before localising.
- `roles/PermissionsMatrix.tsx` and `roles/CreateRole.tsx` — depends on
  permission/role label localisation strategy (DB or frontend?). Cover
  in the database-driven labels audit (Part 05).
- WhatsApp / floating CTA components — already 0 literals.

### 12.4 Acceptance criteria

- `npm run i18n:check-keys` passes for all 6 locales × 11 namespaces (9 existing + 2 new).
- `npm run i18n:check-literals` reports < **400** literals across the
  page tree (down from 1459 today). The legal body of DPA accounts for
  ~45 of the remaining; the rest will be the long tail of marketing /
  exports.
- Pseudo-localization (`?lang=pseudo`) on every page in scope shows all
  user-visible strings wrapped in `[!! … !!]`.
- Build green, bundle size delta ≤ +50 KB (lazy-loaded locales absorb
  the new keys).

### 12.5 Effort estimate (rough)

- **Common keys + scaffolding:** 0.5 day.
- **`apiError` sweep:** 0.5 day mechanical, 0.5 day review.
- **Profile pages (5 files):** 2 days.
- **Big forms (`ApplicantFormSteps` + 4 others):** 3 days (the applicant
  form alone is a day).
- **Feature components (4 files):** 1.5 days.
- **Confirm dialog sweep:** 0.5 day.
- **Inline validation:** 0.5 day.

**~9 engineering days** to land Phase 2 above. Pushes pragmatic
coverage from 47% to ~78%.

---

## 13. Final takeaways

- **Plumbing:** ✅ in place. `useTranslation`, `apiError`, `enumLabel`,
  `formatDate/Number/Currency`, lazy locales, `<html lang/dir>` flip,
  pseudo-localization — all live.
- **Layout & nav:** ✅ done. Sidebar, Topbar, Dashboard chrome,
  ChangePassword inline dialog, language switcher.
- **UI primitives:** ✅ 11 of 11 with their own text are translated; 39
  pass-through primitives don't need translation.
- **Feature components:** 9 of 11 untranslated — biggest residual
  literal load (231 hits, 138 in `ApplicantFormSteps` alone).
- **Dialogs / confirms:** the `ConfirmDialog` host is translated but
  ~30 callers pass English literals. Mostly delete confirmations.
- **Forms:** 4 public auth forms 🟢; 13 dashboard forms partial; 6
  forms not started. The applicant multi-step form is the dominant
  weight.
- **Tables:** column headers and empty states are 100% English in all
  30 tables. Status badges already pull translations via
  `enumLabel(…)`. Common chrome should move to `common.table.*`.
- **Toasts:** worst-translated surface — only ~3% of 602 calls flow
  through `t()` / `apiError`. Big visible win available with one sweep.
- **Top 20 next-pass list** in §9 — focus on those for the highest
  ratio of literals removed per file.
- **Suggested next prompt:**

  > Implement Phase 2 of the components audit. Start with
  > `pages/applicants/ApplicantProfile.tsx` and
  > `pages/applicants/CandidateProfile.tsx` (highest-traffic profile
  > pages, 72 + 69 hardcoded literals). Add a `pages.applicants.profile.*`
  > / `pages.candidates.profile.*` keyset. Sweep all `confirm({ … })`
  > and `toast.error(…)` calls in those two files through `t()` and
  > `apiError`. Run `npm run i18n:check-keys` and
  > `npm run i18n:check-literals` before commit. Push to a new branch.

---

## 14. What this audit deliberately does **not** cover

- **Status / enum labels** rendered from backend-provided codes (Part
  03 — already covered partially: `enums.json` exists).
- **Backend exception messages, validation messages, email templates,
  generated exports** (Part 04 — backend audit).
- **Database-driven labels** (DocumentType / JobType / WorkflowStage
  bodies, Role / Permission descriptions, JobAd content) — Part 05.
- **RTL deep dive** on every page (a separate visual review pass; the
  codemod from Phase 5 already converted directional Tailwind classes
  to logical utilities).
- **Routes/page-level audit** — done in Part 01.

End of Part 02.
