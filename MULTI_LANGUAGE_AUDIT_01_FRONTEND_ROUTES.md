# Multi-Language Audit · Part 01 — Frontend Routes / Pages

> **Scope:** every screen registered in `src/app/routes.ts`. This audit is
> read-only: no source changes, no commits.
>
> **Out of scope (covered by later audits):** layout/navigation components,
> dialogs/modals, forms, tables/grids, toasts, status/enum labels, backend
> exceptions/validation/email templates, RTL deep dive, database-driven
> labels.

---

## 1. Existing i18n setup

**Status:** ✅ Installed and operational.

| Concern                                | Detected                                                                                                       |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Library                                | `i18next ^26.0.8`, `react-i18next ^17.0.6`, `i18next-browser-languagedetector ^8.2.1` (in root `package.json`) |
| Initialization                         | `src/i18n/index.ts` — custom backend lazy-loads non-English JSON via `import('./locales/${lng}/${ns}.json')`   |
| Provider                               | `src/i18n/LanguageContext.tsx` — `<LanguageProvider>` wraps the app (`src/app/App.tsx`)                        |
| Switcher                               | `src/i18n/LanguageSwitcher.tsx` — mounted on every public page and in `Topbar`                                 |
| Languages configured                   | `en`, `sk`, `de`, `ru`, `ar`, `tr` (+ hidden `pseudo` in dev builds)                                           |
| Namespaces                             | 9 — `common`, `nav`, `auth`, `public`, `enums`, `errors`, `dashboard`, `ui`, `pages`                           |
| Translation keys                       | 889 keys total (en) — common 28, nav 67, auth 84, public 161, enums 116, errors 35, dashboard 79, ui 30, pages 289 |
| Locale parity                          | ✅ All 5 target locales × 9 namespaces match English (verified via `npm run i18n:check-keys`)                  |
| RTL handling                           | `<html dir>` flipped from `LanguageContext`; `RTL_LOCALES = ['ar']`; Tailwind v4 logical utilities throughout  |
| Persistence                            | `localStorage['tempworks.lang']` (key `STORAGE_KEY` in `src/i18n/config.ts`)                                   |
| Detection order                        | localStorage → navigator → htmlTag (i18next-browser-languagedetector default)                                  |
| Language updates document attributes   | ✅ `document.documentElement.lang` and `document.documentElement.dir` set in `LanguageContext` `useEffect`     |
| Date / number / currency               | `src/i18n/formatters.ts` (`formatDate`, `formatDateTime`, `formatNumber`, `formatCurrency`) using `Intl.*`     |
| Backend enum label helper              | `src/i18n/enumLabel.ts`                                                                                        |
| Backend error code helper              | `src/i18n/apiError.ts`                                                                                         |
| Pseudo-localization (dev)              | `src/i18n/pseudo.ts` — `[!! Áçƈéñţéđ !!]` wrapping; surfaces hardcoded English at runtime                       |
| Translator handoff guide               | `src/i18n/README.md`                                                                                           |
| Key parity / literal scanners          | `scripts/i18n-check-keys.mjs`, `scripts/i18n-check-literals.mjs` (npm scripts: `i18n:check-keys`, `i18n:check-literals`, `i18n:check`) |
| Backend dashboard usage                | Phase 4 in place: `Accept-Language` resolver in `backend/src/common/i18n/i18n.service.ts`; locale-aware emails |

The plumbing is complete. What remains is **filling in `t(...)` calls** at
the screen level so the rendered strings actually flow through the
translation pipeline.

---

## 2. Per-route inventory

**Source files inspected**

- `src/app/routes.ts` — single source of truth for 105 routes.
- `src/app/pages/**/*.tsx` — 103 page components.

**Methodology**

For every page file:
- `useTranslation` — does the file import / call `useTranslation` from
  `react-i18next`?
- `Hardcoded` — count of suspicious user-visible JSX literals (heuristic
  scan from `scripts/i18n-check-literals.mjs`, applied per file). False
  positives are possible; treat as a relative size signal, not a precise
  defect count.
- `Status` — derived from the two columns:
  - `fully-translated` — uses `t()` and **0** hardcoded literals detected.
  - `partial` — uses `t()` but still has hardcoded literals (chrome
    translated, body untouched).
  - `untranslated` — does **not** use `t()` and has hardcoded literals.
  - `trivial-no-body` — does **not** use `t()` and has 0 hardcoded
    literals; nothing to translate (typically a router stub or a layout-
    only screen).

**Priority guide**

- **P0** — appears on the user's daily path (login, dashboard, list pages,
  primary profile pages, the application form public flow). User-visible
  English on these screens is most damaging.
- **P1** — secondary list pages, notifications, profile, change password,
  view-only detail panels, finance, reports.
- **P2** — settings & admin pages used infrequently by privileged roles.
- **P3** — deep-link views, tracking/timeline screens, role/permission
  matrix.

### Public flow (10 routes)

| #  | Route                          | Component                  | File path                                                  | Area    | useT | Hardcoded | Status            | Priority |
| -- | ------------------------------ | -------------------------- | ---------------------------------------------------------- | ------- | :--: | :-------: | ----------------- | :------: |
| 1  | `/`                            | LandingPage                | `src/app/pages/public/LandingPage.tsx`                     | public  | y    | 0         | fully-translated  | P0       |
| 2  | `/login`                       | LoginPage                  | `src/app/pages/public/LoginPage.tsx`                       | auth    | y    | 0         | fully-translated  | P0       |
| 3  | `/activate`                    | ActivationPage             | `src/app/pages/public/ActivationPage.tsx`                  | auth    | y    | 0         | fully-translated  | P0       |
| 4  | `/forgot-password`             | ForgotPasswordPage         | `src/app/pages/public/ForgotPasswordPage.tsx`              | auth    | y    | 0         | fully-translated  | P0       |
| 5  | `/reset-password`              | ResetPasswordPage          | `src/app/pages/public/ResetPasswordPage.tsx`               | auth    | y    | 0         | fully-translated  | P0       |
| 6  | `/apply`                       | PublicEmployeeApplication  | `src/app/pages/public/PublicEmployeeApplication.tsx`       | public  | y    | 0         | fully-translated¹ | P0       |
| 7  | `/application-success`         | ApplicationSuccess         | `src/app/pages/public/ApplicationSuccess.tsx`              | public  | y    | 0         | fully-translated  | P0       |
| 8  | `/jobs`                        | JobListings                | `src/app/pages/public/JobListings.tsx`                     | public  | y    | 0         | fully-translated  | P0       |
| 9  | `/jobs/:slug`                  | JobDetail                  | `src/app/pages/public/JobDetail.tsx`                       | public  | y    | 0         | fully-translated  | P0       |
| 10 | `/data-processing-agreement`   | DataProcessingAgreement    | `src/app/pages/public/DataProcessingAgreement.tsx`         | public  | y    | 45        | partial²          | P1       |

¹ The page wrapper is fully translated; the multi-step applicant form
   inside (`ApplicantFormSteps.tsx`) holds **138** hardcoded literals — the
   single largest hotspot in the codebase. Counted against the form
   audit, not this page.
² Body of the legal document deliberately remains English (lawyer-reviewed
   wording); only chrome (header, back link, footer) is translated.

### Dashboard chrome / index (1 route)

| #  | Route        | Component | File path                       | Area      | useT | Hardcoded | Status            | Priority |
| -- | ------------ | --------- | ------------------------------- | --------- | :--: | :-------: | ----------------- | :------: |
| 11 | `/dashboard` | Dashboard | `src/app/pages/Dashboard.tsx`   | dashboard | y    | 0         | fully-translated  | P0       |

### Employees (8 routes)

| #  | Route                                              | Component                  | File path                                                | Area     | useT | Hardcoded | Status        | Priority |
| -- | -------------------------------------------------- | -------------------------- | -------------------------------------------------------- | -------- | :--: | :-------: | ------------- | :------: |
| 12 | `/dashboard/employees`                             | EmployeesList              | `src/app/pages/employees/EmployeesList.tsx`              | employee | y    | 12        | partial       | P0       |
| 13 | `/dashboard/employees/add`                         | AddEmployee                | `src/app/pages/employees/AddEmployee.tsx`                | employee | y    | 24        | partial       | P0       |
| 14 | `/dashboard/employees/:id`                         | EmployeeProfile            | `src/app/pages/employees/EmployeeProfile.tsx`            | employee | n    | 22        | untranslated  | P0       |
| 15 | `/dashboard/employees/:id/edit`                    | EditEmployee               | `src/app/pages/employees/EditEmployee.tsx`               | employee | y    | 27        | partial       | P0       |
| 16 | `/dashboard/employees/:id/certifications`          | EmployeeCertifications     | `src/app/pages/employees/EmployeeCertifications.tsx`     | employee | n    | 8         | untranslated  | P1       |
| 17 | `/dashboard/employees/:id/training`                | EmployeeTrainingHistory    | `src/app/pages/employees/EmployeeTrainingHistory.tsx`    | employee | n    | 12        | untranslated  | P1       |
| 18 | `/dashboard/employees/:id/compliance-timeline`     | EmployeeComplianceTimeline | `src/app/pages/employees/EmployeeComplianceTimeline.tsx` | employee | n    | 17        | untranslated  | P1       |
| 19 | `/dashboard/employees/:id/performance`             | EmployeePerformanceReview  | `src/app/pages/employees/EmployeePerformanceReview.tsx`  | employee | n    | 12        | untranslated  | P1       |

### Applicants & Candidates (8 routes)

| #  | Route                                  | Component                | File path                                              | Area      | useT | Hardcoded | Status        | Priority |
| -- | -------------------------------------- | ------------------------ | ------------------------------------------------------ | --------- | :--: | :-------: | ------------- | :------: |
| 20 | `/dashboard/applicants`                | ApplicantsList           | `src/app/pages/applicants/ApplicantsList.tsx`          | applicant | y    | 19        | partial       | P0       |
| 21 | `/dashboard/applicants/add`            | AddApplicant             | `src/app/pages/applicants/AddApplicant.tsx`            | applicant | y    | 4         | partial       | P0       |
| 22 | `/dashboard/applicants/delete-requests`| CandidateDeleteRequests  | `src/app/pages/applicants/CandidateDeleteRequests.tsx` | applicant | n    | 9         | untranslated  | P2       |
| 23 | `/dashboard/applicants/:id`            | ApplicantProfile         | `src/app/pages/applicants/ApplicantProfile.tsx`        | applicant | n    | 72        | untranslated  | P0       |
| 24 | `/dashboard/applicants/:id/edit`       | EditApplicant            | `src/app/pages/applicants/EditApplicant.tsx`           | applicant | y    | 5         | partial       | P0       |
| 25 | `/dashboard/candidates`                | CandidatesList           | `src/app/pages/applicants/CandidatesList.tsx`          | candidate | y    | 24        | partial       | P0       |
| 26 | `/dashboard/candidates/:id`            | CandidateProfile         | `src/app/pages/applicants/CandidateProfile.tsx`        | candidate | n    | 69        | untranslated  | P0       |
| 27 | `/dashboard/candidates/:id/edit`       | EditCandidate            | `src/app/pages/applicants/EditCandidate.tsx`           | candidate | y    | 5         | partial       | P0       |

### Documents & Compliance (8 routes)

| #  | Route                                | Component                | File path                                              | Area      | useT | Hardcoded | Status            | Priority |
| -- | ------------------------------------ | ------------------------ | ------------------------------------------------------ | --------- | :--: | :-------: | ----------------- | :------: |
| 28 | `/dashboard/documents`               | DocumentsDashboard       | `src/app/pages/documents/DocumentsDashboard.tsx`       | documents | y    | 5         | partial           | P0       |
| 29 | `/dashboard/documents/upload`        | DocumentUpload           | `src/app/pages/documents/DocumentUpload.tsx`           | documents | n    | 12        | untranslated      | P1       |
| 30 | `/dashboard/documents/:id`           | DocumentPreview          | `src/app/pages/documents/DocumentPreview.tsx`          | documents | n    | 10        | untranslated      | P1       |
| 31 | `/dashboard/documents/:id/edit`      | EditDocument             | `src/app/pages/documents/EditDocument.tsx`             | documents | n    | 9         | untranslated      | P1       |
| 32 | `/dashboard/documents/:id/verify`    | DocumentVerification     | `src/app/pages/documents/DocumentVerification.tsx`     | documents | y    | 8         | partial           | P1       |
| 33 | `/dashboard/document-explorer`       | EmployeeDocumentExplorer | `src/app/pages/documents/EmployeeDocumentExplorer.tsx` | documents | y    | 22        | partial           | P1       |
| 34 | `/dashboard/documents-compliance`    | DocumentsCompliance      | `src/app/pages/documents/DocumentsCompliance.tsx`      | documents | y    | 18        | partial           | P0       |
| 35 | `/dashboard/compliance`              | ComplianceDashboard      | `src/app/pages/compliance/ComplianceDashboard.tsx`     | documents | y    | 0         | fully-translated  | P0       |
| 36 | `/dashboard/compliance/alerts`       | ComplianceAlerts         | `src/app/pages/compliance/ComplianceAlerts.tsx`        | documents | y    | 0         | fully-translated  | P1       |
| 37 | `/dashboard/compliance/employees/:id`| EmployeeCompliance       | `src/app/pages/compliance/EmployeeCompliance.tsx`      | documents | n    | 8         | untranslated      | P2       |

### Workflow & Pipelines (10 routes)

| #  | Route                                  | Component                | File path                                              | Area     | useT | Hardcoded | Status            | Priority |
| -- | -------------------------------------- | ------------------------ | ------------------------------------------------------ | -------- | :--: | :-------: | ----------------- | :------: |
| 38 | `/dashboard/workflow`                  | WorkflowOverview         | `src/app/pages/workflow/WorkflowOverview.tsx`          | workflow | y    | 0         | fully-translated  | P1       |
| 39 | `/dashboard/workflow/work-permits`     | WorkPermitTracking       | `src/app/pages/workflow/WorkPermitTracking.tsx`        | workflow | n    | 3         | untranslated      | P2       |
| 40 | `/dashboard/workflow/visas`            | VisaTracking             | `src/app/pages/workflow/VisaTracking.tsx`              | workflow | n    | 2         | untranslated      | P2       |
| 41 | `/dashboard/workflow/stage/:stageId`   | StageDetails             | `src/app/pages/workflow/StageDetails.tsx`              | workflow | n    | 8         | untranslated      | P2       |
| 42 | `/dashboard/workflow/timeline`         | WorkflowTimeline         | `src/app/pages/workflow/WorkflowTimeline.tsx`          | workflow | n    | 8         | untranslated      | P2       |
| 43 | `/dashboard/workflow/analytics`        | WorkflowAnalytics        | `src/app/pages/workflow/WorkflowAnalytics.tsx`         | workflow | n    | 19        | untranslated      | P2       |
| 44 | `/dashboard/workflow-management`       | WorkflowManagement       | `src/app/pages/workflow/WorkflowManagement.tsx`        | workflow | n    | 6         | untranslated      | P2       |
| 45 | `/dashboard/workflows`                 | WorkflowsPage            | `src/app/pages/pipelines/WorkflowsPage.tsx`            | workflow | y    | 8         | partial           | P0       |
| 46 | `/dashboard/workflows/:id`             | WorkflowBoardPage        | `src/app/pages/pipelines/WorkflowBoardPage.tsx`        | workflow | n    | 8         | untranslated      | P1       |
| 47 | `/dashboard/workflows/stage/:stageId`  | WorkflowStageDetailsPage | `src/app/pages/pipelines/WorkflowStageDetailsPage.tsx` | workflow | n    | 18        | untranslated      | P1       |

### Agencies (5 routes)

| #  | Route                              | Component             | File path                                              | Area    | useT | Hardcoded | Status        | Priority |
| -- | ---------------------------------- | --------------------- | ------------------------------------------------------ | ------- | :--: | :-------: | ------------- | :------: |
| 48 | `/dashboard/agencies`              | AgenciesList          | `src/app/pages/agencies/AgenciesList.tsx`              | agency  | y    | 9         | partial       | P0       |
| 49 | `/dashboard/agencies/add`          | AddAgency             | `src/app/pages/agencies/AddAgency.tsx`                 | agency  | y    | 15        | partial       | P0       |
| 50 | `/dashboard/agencies/:id`          | AgencyProfile         | `src/app/pages/agencies/AgencyProfile.tsx`             | agency  | n    | 16        | untranslated  | P1       |
| 51 | `/dashboard/agencies/:id/edit`     | EditAgency            | `src/app/pages/agencies/EditAgency.tsx`                | agency  | y    | 18        | partial       | P0       |
| 52 | `/dashboard/agencies/:id/users`    | AgencyUsersManagement | `src/app/pages/agencies/AgencyUsersManagement.tsx`     | agency  | n    | 7         | untranslated  | P2       |
| 53 | `/dashboard/my-agency`             | MyAgencyProfile       | `src/app/pages/agencies/MyAgencyProfile.tsx`           | agency  | n    | 1         | untranslated  | P2       |

### Vehicles (8 routes)

| #  | Route                                          | Component              | File path                                            | Area    | useT | Hardcoded | Status       | Priority |
| -- | ---------------------------------------------- | ---------------------- | ---------------------------------------------------- | ------- | :--: | :-------: | ------------ | :------: |
| 54 | `/dashboard/vehicles`                          | VehiclesList           | `src/app/pages/vehicles/VehiclesList.tsx`            | vehicle | y    | 10        | partial      | P0       |
| 55 | `/dashboard/vehicles/new`                      | VehicleForm            | `src/app/pages/vehicles/VehicleForm.tsx`             | vehicle | n    | 21        | untranslated | P1       |
| 56 | `/dashboard/vehicles/:id`                      | VehicleDetail          | `src/app/pages/vehicles/VehicleDetail.tsx`           | vehicle | n    | 39        | untranslated | P1       |
| 57 | `/dashboard/vehicles/:id/edit`                 | VehicleForm            | `src/app/pages/vehicles/VehicleForm.tsx`             | vehicle | n    | 21        | untranslated | P1       |
| 58 | `/dashboard/vehicles/workshops`                | WorkshopsList          | `src/app/pages/vehicles/WorkshopsList.tsx`           | vehicle | y    | 5         | partial      | P1       |
| 59 | `/dashboard/vehicles/maintenance-types`        | MaintenanceTypesList   | `src/app/pages/vehicles/MaintenanceTypesList.tsx`    | vehicle | n    | 7         | untranslated | P2       |
| 60 | `/dashboard/vehicles/maintenance-records`      | MaintenanceRecordsList | `src/app/pages/vehicles/MaintenanceRecordsList.tsx`  | vehicle | y    | 5         | partial      | P1       |

### Attendance (2 routes)

| #  | Route                       | Component       | File path                                       | Area       | useT | Hardcoded | Status        | Priority |
| -- | --------------------------- | --------------- | ----------------------------------------------- | ---------- | :--: | :-------: | ------------- | :------: |
| 61 | `/dashboard/attendance`     | AttendanceList  | `src/app/pages/attendance/AttendanceList.tsx`   | attendance | y    | 6         | partial       | P0       |
| 62 | `/dashboard/attendance/:id` | AttendanceSheet | `src/app/pages/attendance/AttendanceSheet.tsx`  | attendance | n    | 7         | untranslated  | P1       |

### Finance (1 route)

| #  | Route                | Component        | File path                                  | Area    | useT | Hardcoded | Status   | Priority |
| -- | -------------------- | ---------------- | ------------------------------------------ | ------- | :--: | :-------: | -------- | :------: |
| 63 | `/dashboard/finance` | FinanceDashboard | `src/app/pages/finance/FinanceDashboard.tsx`| finance | y    | 24        | partial  | P0       |

### Job Ads (3 routes)

| #  | Route                          | Component   | File path                                 | Area    | useT | Hardcoded | Status        | Priority |
| -- | ------------------------------ | ----------- | ----------------------------------------- | ------- | :--: | :-------: | ------------- | :------: |
| 64 | `/dashboard/job-ads`           | JobAdsList  | `src/app/pages/job-ads/JobAdsList.tsx`    | job-ads | y    | 9         | partial       | P0       |
| 65 | `/dashboard/job-ads/new`       | JobAdForm   | `src/app/pages/job-ads/JobAdForm.tsx`     | job-ads | n    | 9         | untranslated  | P1       |
| 66 | `/dashboard/job-ads/:id/edit`  | JobAdForm   | `src/app/pages/job-ads/JobAdForm.tsx`     | job-ads | n    | 9         | untranslated  | P1       |

### Notifications (2 routes)

| #  | Route                           | Component            | File path                                              | Area          | useT | Hardcoded | Status        | Priority |
| -- | ------------------------------- | -------------------- | ------------------------------------------------------ | ------------- | :--: | :-------: | ------------- | :------: |
| 67 | `/dashboard/notifications`      | NotificationCenter   | `src/app/pages/notifications/NotificationCenter.tsx`   | notifications | y    | 14        | partial       | P0       |
| 68 | `/dashboard/notifications/settings`| NotificationSettings | `src/app/pages/notifications/NotificationSettings.tsx`| notifications | n    | 3         | untranslated  | P2       |

### Users / Roles / Permissions (6 routes)

| #  | Route                                  | Component         | File path                                            | Area  | useT | Hardcoded | Status        | Priority |
| -- | -------------------------------------- | ----------------- | ---------------------------------------------------- | ----- | :--: | :-------: | ------------- | :------: |
| 69 | `/dashboard/users`                     | UsersList         | `src/app/pages/users/UsersList.tsx`                  | admin | y    | 17        | partial       | P0       |
| 70 | `/dashboard/users/add`                 | AddUser           | `src/app/pages/users/AddUser.tsx`                    | admin | y    | 16        | partial       | P0       |
| 71 | `/dashboard/users/:id/edit`            | EditUser          | `src/app/pages/users/EditUser.tsx`                   | admin | y    | 25        | partial       | P0       |
| 72 | `/dashboard/roles`                     | RolesList         | `src/app/pages/roles/RolesList.tsx`                  | admin | y    | 6         | partial       | P0       |
| 73 | `/dashboard/roles/create`              | CreateRole        | `src/app/pages/roles/CreateRole.tsx`                 | admin | n    | 6         | untranslated  | P1       |
| 74 | `/dashboard/roles/:id/edit`            | CreateRole        | `src/app/pages/roles/CreateRole.tsx`                 | admin | n    | 6         | untranslated  | P1       |
| 75 | `/dashboard/roles/permissions-matrix`  | PermissionsMatrix | `src/app/pages/roles/PermissionsMatrix.tsx`          | admin | n    | 3         | untranslated  | P2       |

### Reports (1 route)

| #  | Route                | Component        | File path                                  | Area    | useT | Hardcoded | Status   | Priority |
| -- | -------------------- | ---------------- | ------------------------------------------ | ------- | :--: | :-------: | -------- | :------: |
| 76 | `/dashboard/reports` | ReportsDashboard | `src/app/pages/reports/ReportsDashboard.tsx`| reports | y    | 18        | partial  | P0       |

### Logs / Recycle Bin (2 routes)

| #  | Route                  | Component      | File path                                          | Area  | useT | Hardcoded | Status   | Priority |
| -- | ---------------------- | -------------- | -------------------------------------------------- | ----- | :--: | :-------: | -------- | :------: |
| 77 | `/dashboard/logs`      | LogsDashboard  | `src/app/pages/logs/LogsDashboard.tsx`             | admin | y    | 21        | partial  | P1       |
| 78 | `/dashboard/recycle-bin` | DeletedRecords | `src/app/pages/recycle-bin/DeletedRecords.tsx`     | admin | y    | 11        | partial  | P1       |

### Profile / Preferences / Change Password (4 routes)

| #  | Route                                | Component        | File path                                       | Area    | useT | Hardcoded | Status   | Priority |
| -- | ------------------------------------ | ---------------- | ----------------------------------------------- | ------- | :--: | :-------: | -------- | :------: |
| 79 | `/dashboard/profile`                 | Profile          | `src/app/pages/profile/Profile.tsx`             | profile | y    | 15        | partial  | P0       |
| 80 | `/dashboard/profile/change-password` | ChangePassword   | `src/app/pages/profile/ChangePassword.tsx`      | profile | y    | 9         | partial  | P0       |
| 81 | `/dashboard/change-password`         | ChangePassword   | `src/app/pages/profile/ChangePassword.tsx`      | profile | y    | 9         | partial  | P0       |
| 82 | `/dashboard/preferences`             | UserPreferences  | `src/app/pages/profile/UserPreferences.tsx`     | profile | y    | 24        | partial  | P0       |

### Settings (23 routes)

| #   | Route                                          | Component                     | File path                                                | Area     | useT | Hardcoded | Status            | Priority |
| --- | ---------------------------------------------- | ----------------------------- | -------------------------------------------------------- | -------- | :--: | :-------: | ----------------- | :------: |
| 83  | `/dashboard/settings`                          | Settings                      | `src/app/pages/settings/Settings.tsx`                    | settings | y    | 28        | partial           | P0       |
| 84  | `/dashboard/settings/job-types`                | JobTypes                      | `src/app/pages/settings/JobTypes.tsx`                    | settings | n    | 10        | untranslated      | P2       |
| 85  | `/dashboard/settings/workflow`                 | WorkflowSettings              | `src/app/pages/settings/WorkflowSettings.tsx`            | settings | n    | 2         | untranslated      | P3       |
| 86  | `/dashboard/settings/workflow-configuration`   | WorkflowConfiguration         | `src/app/pages/settings/WorkflowConfiguration.tsx`       | settings | n    | 0         | trivial-no-body   | P3       |
| 87  | `/dashboard/settings/document-types`           | DocumentTypes                 | `src/app/pages/settings/DocumentTypes.tsx`               | settings | n    | 9         | untranslated      | P2       |
| 88  | `/dashboard/settings/document-types/new`       | DocumentTypeNew               | `src/app/pages/settings/DocumentTypeNew.tsx`             | settings | n    | 26        | untranslated      | P2       |
| 89  | `/dashboard/settings/document-types/:id`       | DocumentTypeView              | `src/app/pages/settings/DocumentTypeView.tsx`            | settings | n    | 19        | untranslated      | P2       |
| 90  | `/dashboard/settings/document-types/:id/edit`  | DocumentTypeEdit              | `src/app/pages/settings/DocumentTypeEdit.tsx`            | settings | n    | 26        | untranslated      | P2       |
| 91  | `/dashboard/settings/notifications`            | NotificationRules             | `src/app/pages/settings/NotificationRules.tsx`           | settings | n    | 0         | trivial-no-body   | P3       |
| 92  | `/dashboard/settings/security`                 | SecuritySettings              | `src/app/pages/settings/SecuritySettings.tsx`            | settings | n    | 16        | untranslated      | P1       |
| 93  | `/dashboard/settings/color-scheme`             | ColorScheme                   | `src/app/pages/settings/ColorScheme.tsx`                 | settings | n    | 2         | untranslated      | P3       |
| 94  | `/dashboard/settings/database-cleanup`         | DatabaseCleanup               | `src/app/pages/settings/DatabaseCleanup.tsx`             | settings | n    | 12        | untranslated      | P2       |
| 95  | `/dashboard/settings/database-backup`          | DatabaseBackup                | `src/app/pages/settings/DatabaseBackup.tsx`              | settings | n    | 29        | untranslated      | P2       |
| 96  | `/dashboard/settings/system-information`       | SystemInformation             | `src/app/pages/settings/SystemInformation.tsx`           | settings | n    | 16        | untranslated      | P2       |
| 97  | `/dashboard/settings/branding`                 | BrandingSettings              | `src/app/pages/settings/BrandingSettings.tsx`            | settings | n    | 4         | untranslated      | P2       |
| 98  | `/dashboard/settings/skills`                   | SkillsSettings                | `src/app/pages/settings/SkillsSettings.tsx`              | settings | n    | 5         | untranslated      | P2       |
| 99  | `/dashboard/settings/transport-types`          | TransportTypesSettings        | `src/app/pages/settings/TransportTypesSettings.tsx`      | settings | n    | 5         | untranslated      | P3       |
| 100 | `/dashboard/settings/truck-brands`             | TruckBrandsSettings           | `src/app/pages/settings/TruckBrandsSettings.tsx`         | settings | n    | 5         | untranslated      | P3       |
| 101 | `/dashboard/settings/trailer-types`            | TrailerTypesSettings          | `src/app/pages/settings/TrailerTypesSettings.tsx`        | settings | n    | 5         | untranslated      | P3       |
| 102 | `/dashboard/settings/vehicles`                 | VehicleSettings               | `src/app/pages/settings/VehicleSettings.tsx`             | settings | n    | 10        | untranslated      | P2       |
| 103 | `/dashboard/settings/transaction-types`        | TransactionTypesSettings      | `src/app/pages/settings/TransactionTypesSettings.tsx`    | settings | n    | 6         | untranslated      | P2       |
| 104 | `/dashboard/settings/work-history-event-types` | WorkHistoryEventTypesSettings | `src/app/pages/settings/WorkHistoryEventTypesSettings.tsx`| settings| n    | 8         | untranslated      | P2       |
| 105 | `/dashboard/settings/workflows/:id`            | WorkflowSettingsPage          | `src/app/pages/pipelines/WorkflowSettingsPage.tsx`       | settings | n    | 11        | untranslated      | P2       |

> The `MaintenanceTypesSettings.tsx` page exists in `src/app/pages/settings/`
> but isn't reachable via `routes.ts`; see "Orphaned files" below.

### Orphaned page files (not reachable via `routes.ts`)

| File                                                  | Notes                                                              |
| ----------------------------------------------------- | ------------------------------------------------------------------ |
| `src/app/pages/settings/MaintenanceTypesSettings.tsx` | Uses `MaintenanceTypesList` at `/dashboard/vehicles/maintenance-types` instead. Probably dead code; flag for review. |

---

## 3. Coverage summary

### By status

| Status               | Count | Share |
| -------------------- | ----: | ----: |
| **fully-translated** |    13 | 12.4% |
| **partial**          |    36 | 34.3% |
| **untranslated**     |    54 | 51.4% |
| **trivial-no-body**  |     2 |  1.9% |
| **total**            |   105 |  100% |

### Estimated translation coverage

A pure file-level percentage hides the fact that "partial" pages have
their *header chrome* translated (added in Phases 2-3) while *bodies*
remain English. Two views:

- **Strict (zero hardcoded literals = translated):** **15 / 105 = 14%**
  (13 fully + 2 trivial-no-body).
- **Pragmatic (chrome translated = at least the page title and primary
  buttons render in the user's language):** **49 / 105 = 47%**
  (13 fully + 36 partial).

The pragmatic view matches how a returning user perceives the app: list
pages, navigation, and primary CTAs are in their language; deep form
fields and detail panels fall back to English.

### By area

| Area              | Total | fully | partial | untranslated | Pragmatic % |
| ----------------- | ----: | ----: | ------: | -----------: | ----------: |
| public            |    10 |     9 |       1 |            0 |        100% |
| dashboard (index) |     1 |     1 |       0 |            0 |        100% |
| documents/compliance |  10 |     3 |       4 |            3 |         70% |
| applicants/candidates |  8 |     0 |       5 |            3 |         63% |
| profile           |     4 |     0 |       4 |            0 |        100% |
| employee          |     8 |     0 |       3 |            5 |         38% |
| agency            |     6 |     0 |       3 |            3 |         50% |
| workflow          |    10 |     1 |       1 |            8 |         20% |
| vehicle           |     7 |     0 |       3 |            4 |         43% |
| attendance        |     2 |     0 |       1 |            1 |         50% |
| finance           |     1 |     0 |       1 |            0 |        100% |
| job-ads           |     3 |     0 |       1 |            2 |         33% |
| notifications     |     2 |     0 |       1 |            1 |         50% |
| admin (users/roles/logs/recycle-bin) | 8 | 0 | 4 | 4 | 50% |
| reports           |     1 |     0 |       1 |            0 |        100% |
| settings          |    23 |     0 |       1 |           20 |          4% |
| **total**         |   105 |    13 |      36 |           54 |         47% |

Settings is the biggest visible gap — nearly every settings sub-page
has not been touched.

---

## 4. Top 20 untranslated screens

Ranked by `Hardcoded` literal count (a proxy for translation effort and
user impact). All entries below are status `untranslated` (no
`useTranslation` hook).

| #  | Route                                              | Component                  | Hardcoded | Priority | Why it matters                                           |
| -- | -------------------------------------------------- | -------------------------- | --------: | :------: | -------------------------------------------------------- |
|  1 | `/dashboard/applicants/:id`                        | ApplicantProfile           |        72 | P0       | Profile is a daily-use detail page; biggest dashboard hotspot |
|  2 | `/dashboard/candidates/:id`                        | CandidateProfile           |        69 | P0       | Sister page to applicant profile; same impact            |
|  3 | `/dashboard/vehicles/:id`                          | VehicleDetail              |        39 | P1       | Heavy vehicle detail panel                                |
|  4 | `/dashboard/settings/database-backup`              | DatabaseBackup             |        29 | P2       | Admin only; lots of UI                                    |
|  5 | `/dashboard/settings/document-types/new`           | DocumentTypeNew            |        26 | P2       | Admin doc-type form; needed before DB translations land   |
|  6 | `/dashboard/settings/document-types/:id/edit`      | DocumentTypeEdit           |        26 | P2       | Same as above (edit)                                      |
|  7 | `/dashboard/employees/:id`                         | EmployeeProfile            |        22 | P0       | Profile counterpart to ApplicantProfile                   |
|  8 | `/dashboard/vehicles/new`                          | VehicleForm                |        21 | P1       | Add Vehicle form                                          |
|  9 | `/dashboard/vehicles/:id/edit`                     | VehicleForm                |        21 | P1       | Edit Vehicle form (same component)                        |
| 10 | `/dashboard/workflow/analytics`                    | WorkflowAnalytics          |        19 | P2       | Charts page                                               |
| 11 | `/dashboard/settings/document-types/:id`           | DocumentTypeView           |        19 | P2       | Read-only view                                            |
| 12 | `/dashboard/workflows/stage/:stageId`              | WorkflowStageDetailsPage   |        18 | P1       | Stage details deep-link                                   |
| 13 | `/dashboard/employees/:id/compliance-timeline`     | EmployeeComplianceTimeline |        17 | P1       | Compliance chronology                                     |
| 14 | `/dashboard/settings/system-information`           | SystemInformation          |        16 | P2       | Admin-only diagnostics                                    |
| 15 | `/dashboard/settings/security`                     | SecuritySettings           |        16 | P1       | Auth policy / 2FA settings                                |
| 16 | `/dashboard/agencies/:id`                          | AgencyProfile              |        16 | P1       | Agency detail panel                                       |
| 17 | `/dashboard/settings/database-cleanup`             | DatabaseCleanup            |        12 | P2       | Admin only                                                |
| 18 | `/dashboard/employees/:id/training`                | EmployeeTrainingHistory    |        12 | P1       | Employee training tab                                     |
| 19 | `/dashboard/employees/:id/performance`             | EmployeePerformanceReview  |        12 | P1       | Performance tab                                           |
| 20 | `/dashboard/documents/upload`                      | DocumentUpload             |        12 | P1       | Upload form                                               |

Honourable mentions (just outside the top 20):

`/dashboard/settings/workflows/:id` (11), `/dashboard/documents/:id` (10),
`/dashboard/settings/vehicles` (10), `/dashboard/settings/job-types` (10),
`/dashboard/settings/maintenance-types` style pages, plus the chunky
public `/data-processing-agreement` (45 — but those are legal-text
literals retained in English by design, body deferred indefinitely).

---

## 5. Recommended Phase 2 targets

> Phase 2 in this plan = "next translation push." Numbering starts again
> at 1 here; this is independent of the original five-phase plan in
> `MULTI_LANGUAGE_IMPLEMENTATION_PLAN.md`.

The goal of the next pass is to **eliminate the longest user-visible
English text on the daily-use path**. Profiles dwarf everything else, so
they go first.

### Tier 1 — Profile pages (the daily-use detail screens)

Single biggest pragmatic win. These four files alone account for ~225
hardcoded literals, all on screens a user opens many times per day.

1. `src/app/pages/applicants/ApplicantProfile.tsx` (72 literals · P0)
2. `src/app/pages/applicants/CandidateProfile.tsx` (69 literals · P0)
3. `src/app/pages/employees/EmployeeProfile.tsx` (22 literals · P0)
4. `src/app/pages/agencies/AgencyProfile.tsx` (16 literals · P1)

Acceptance: `useTranslation('pages')`, all section titles, tab labels,
KPI rows, "Edit" / "Delete" / "Convert to Candidate" buttons, status
badges (use the existing `enums` namespace + `enumLabel()`), empty
states, confirmation dialog text. New keys go under
`pages.applicants.profile.*`, `pages.candidates.profile.*`,
`pages.employees.profile.*`, `pages.agencies.profile.*` — those leaf
namespaces already exist; just expand them.

### Tier 2 — Vehicle, Workflow, Documents detail pages (P1)

5. `src/app/pages/vehicles/VehicleDetail.tsx` (39)
6. `src/app/pages/vehicles/VehicleForm.tsx` (21, used by both `new` and `:id/edit`)
7. `src/app/pages/pipelines/WorkflowStageDetailsPage.tsx` (18)
8. `src/app/pages/documents/DocumentPreview.tsx` (10)
9. `src/app/pages/documents/DocumentUpload.tsx` (12)
10. `src/app/pages/documents/EditDocument.tsx` (9)

### Tier 3 — Employee profile sub-tabs (P1)

11. `src/app/pages/employees/EmployeeComplianceTimeline.tsx` (17)
12. `src/app/pages/employees/EmployeeTrainingHistory.tsx` (12)
13. `src/app/pages/employees/EmployeePerformanceReview.tsx` (12)
14. `src/app/pages/employees/EmployeeCertifications.tsx` (8)

### Tier 4 — Admin & Settings sweeps (P2 — "fix once")

The settings folder is the long tail. Recommend a single, mostly
mechanical PR that wires `useTranslation('pages')` into every settings
page, mapping the existing English h1/subtitle to the keys already in
`pages.settings.*` (which we populated in Phase 3). Many of these pages
have only 5–16 literals each, mostly buttons/labels.

15. `src/app/pages/settings/DocumentTypeNew.tsx` + `DocumentTypeEdit.tsx` + `DocumentTypeView.tsx` + `DocumentTypes.tsx`
16. `src/app/pages/settings/JobTypes.tsx`
17. `src/app/pages/settings/SkillsSettings.tsx`
18. `src/app/pages/settings/SecuritySettings.tsx`
19. `src/app/pages/settings/SystemInformation.tsx`
20. `src/app/pages/settings/DatabaseBackup.tsx`, `DatabaseCleanup.tsx`
21. The four vehicle-related settings (`TransportTypes`, `TruckBrands`, `TrailerTypes`, `VehicleSettings`)
22. `TransactionTypesSettings.tsx`, `WorkHistoryEventTypesSettings.tsx`, `BrandingSettings.tsx`, `ColorScheme.tsx`
23. `WorkflowSettings.tsx`, `WorkflowConfiguration.tsx`, `pipelines/WorkflowSettingsPage.tsx`

### Tier 5 — Workflow / Compliance long tail (P2-P3)

24. `src/app/pages/workflow/WorkflowAnalytics.tsx` (19)
25. `src/app/pages/workflow/WorkflowTimeline.tsx` (8)
26. `src/app/pages/workflow/WorkflowManagement.tsx` (6)
27. `src/app/pages/workflow/StageDetails.tsx` (8)
28. `src/app/pages/workflow/WorkflowStageDetail.tsx` (9)
29. `src/app/pages/workflow/WorkPermitTracking.tsx` (3)
30. `src/app/pages/workflow/VisaTracking.tsx` (2)
31. `src/app/pages/compliance/EmployeeCompliance.tsx` (8)
32. `src/app/pages/pipelines/WorkflowBoardPage.tsx` (8)

### Tier 6 — Already translated; nothing to do

13 routes are already at zero hardcoded literals: the entire public flow
(except DPA legal body), `Dashboard`, `ComplianceDashboard`,
`ComplianceAlerts`, `WorkflowOverview`. Periodically re-run
`npm run i18n:check-literals` after PRs to keep them clean.

---

## 6. Approach guidance for the next pass

1. **Reuse existing keyspaces.** `pages.<module>.*` was built in Phase 3.
   The next pass mostly extends those subtrees with `profile.*`,
   `detail.*`, `form.*`, `tabs.*` keys.
2. **Use existing helpers.** `enumLabel('documentStatus', code)` for
   status badges, `formatDate/Currency/Number` for any value rendered to
   the user, `apiError(err)` for backend-error toasts.
3. **Hold the line.** Add `npm run i18n:check-literals` to CI (advisory)
   and `npm run i18n:check-keys` (required). The latter is already
   passing for all 5 target locales × 9 namespaces.
4. **Pseudo-localization while developing.** Pick "Pseudo (dev)" in the
   language switcher. Anything appearing without `[!! … !!]` brackets is a
   leftover hardcoded string.
5. **Keep page-level scope.** Skip deep modals/dialogs — they will be
   handled in their own audit (`MULTI_LANGUAGE_AUDIT_…_DIALOGS.md`).

---

## 7. Files this audit will recommend changing

This audit recommends — but does not perform — edits to the following
files. The list is the union of all `untranslated` and `partial` pages
above:

```
# Untranslated (54)
src/app/pages/agencies/AgencyProfile.tsx
src/app/pages/agencies/AgencyUsersManagement.tsx
src/app/pages/agencies/MyAgencyProfile.tsx
src/app/pages/applicants/ApplicantProfile.tsx
src/app/pages/applicants/CandidateDeleteRequests.tsx
src/app/pages/applicants/CandidateProfile.tsx
src/app/pages/attendance/AttendanceSheet.tsx
src/app/pages/compliance/EmployeeCompliance.tsx
src/app/pages/documents/DocumentPreview.tsx
src/app/pages/documents/DocumentUpload.tsx
src/app/pages/documents/EditDocument.tsx
src/app/pages/employees/EmployeeCertifications.tsx
src/app/pages/employees/EmployeeComplianceTimeline.tsx
src/app/pages/employees/EmployeePerformanceReview.tsx
src/app/pages/employees/EmployeeProfile.tsx
src/app/pages/employees/EmployeeTrainingHistory.tsx
src/app/pages/job-ads/JobAdForm.tsx
src/app/pages/notifications/NotificationSettings.tsx
src/app/pages/pipelines/WorkflowBoardPage.tsx
src/app/pages/pipelines/WorkflowSettingsPage.tsx
src/app/pages/pipelines/WorkflowStageDetailsPage.tsx
src/app/pages/roles/CreateRole.tsx
src/app/pages/roles/PermissionsMatrix.tsx
src/app/pages/settings/BrandingSettings.tsx
src/app/pages/settings/ColorScheme.tsx
src/app/pages/settings/DatabaseBackup.tsx
src/app/pages/settings/DatabaseCleanup.tsx
src/app/pages/settings/DocumentTypeEdit.tsx
src/app/pages/settings/DocumentTypeNew.tsx
src/app/pages/settings/DocumentTypeView.tsx
src/app/pages/settings/DocumentTypes.tsx
src/app/pages/settings/JobTypes.tsx
src/app/pages/settings/SecuritySettings.tsx
src/app/pages/settings/SkillsSettings.tsx
src/app/pages/settings/SystemInformation.tsx
src/app/pages/settings/TrailerTypesSettings.tsx
src/app/pages/settings/TransactionTypesSettings.tsx
src/app/pages/settings/TransportTypesSettings.tsx
src/app/pages/settings/TruckBrandsSettings.tsx
src/app/pages/settings/VehicleSettings.tsx
src/app/pages/settings/WorkflowSettings.tsx
src/app/pages/settings/WorkHistoryEventTypesSettings.tsx
src/app/pages/vehicles/MaintenanceTypesList.tsx
src/app/pages/vehicles/VehicleDetail.tsx
src/app/pages/vehicles/VehicleForm.tsx
src/app/pages/workflow/StageDetails.tsx
src/app/pages/workflow/VisaTracking.tsx
src/app/pages/workflow/WorkPermitTracking.tsx
src/app/pages/workflow/WorkflowAnalytics.tsx
src/app/pages/workflow/WorkflowManagement.tsx
src/app/pages/workflow/WorkflowStageDetail.tsx
src/app/pages/workflow/WorkflowTimeline.tsx

# Partial — extend keys + replace remaining literals (36)
src/app/pages/agencies/AddAgency.tsx
src/app/pages/agencies/AgenciesList.tsx
src/app/pages/agencies/EditAgency.tsx
src/app/pages/applicants/AddApplicant.tsx
src/app/pages/applicants/ApplicantsList.tsx
src/app/pages/applicants/CandidatesList.tsx
src/app/pages/applicants/EditApplicant.tsx
src/app/pages/applicants/EditCandidate.tsx
src/app/pages/attendance/AttendanceList.tsx
src/app/pages/documents/DocumentsCompliance.tsx
src/app/pages/documents/DocumentsDashboard.tsx
src/app/pages/documents/DocumentVerification.tsx
src/app/pages/documents/EmployeeDocumentExplorer.tsx
src/app/pages/employees/AddEmployee.tsx
src/app/pages/employees/EditEmployee.tsx
src/app/pages/employees/EmployeesList.tsx
src/app/pages/finance/FinanceDashboard.tsx
src/app/pages/job-ads/JobAdsList.tsx
src/app/pages/logs/LogsDashboard.tsx
src/app/pages/notifications/NotificationCenter.tsx
src/app/pages/pipelines/WorkflowsPage.tsx
src/app/pages/profile/ChangePassword.tsx
src/app/pages/profile/Profile.tsx
src/app/pages/profile/UserPreferences.tsx
src/app/pages/public/DataProcessingAgreement.tsx   # body intentionally kept English
src/app/pages/recycle-bin/DeletedRecords.tsx
src/app/pages/reports/ReportsDashboard.tsx
src/app/pages/roles/RolesList.tsx
src/app/pages/settings/Settings.tsx
src/app/pages/users/AddUser.tsx
src/app/pages/users/EditUser.tsx
src/app/pages/users/UsersList.tsx
src/app/pages/vehicles/MaintenanceRecordsList.tsx
src/app/pages/vehicles/VehiclesList.tsx
src/app/pages/vehicles/WorkshopsList.tsx
src/app/pages/workflow/WorkflowOverview.tsx        # 0 literals; included to triple-check
```

---

## 8. What this audit deliberately does **not** cover

These will be addressed in subsequent audit parts:

- **Layout / navigation components** (`Sidebar`, `Topbar`, `MainLayout`,
  breadcrumbs, dropdown menus, the language switcher itself).
- **Shared UI primitives** under `src/app/components/ui/*` (button,
  input, dialog, sheet, table, calendar, etc.).
- **Modals / dialogs / drawers / popovers / sheets** — including
  `ConfirmDialog`, the change-password dialog inside the Topbar, and
  every per-feature dialog.
- **Forms** — the full field/label/placeholder/validation surface,
  which is far larger than the page-level chrome reported here. Note
  that **`src/app/components/applicants/ApplicantFormSteps.tsx`**
  alone has **138 hardcoded literals**, more than any single page.
- **Tables / grids / lists** column headers and empty states.
- **Toasts / alerts** — 380 toast invocations across 74 files; only ~19
  are wrapped in `t()` / `apiError()` today.
- **Backend exceptions / validation messages / email templates**.
- **Database-driven labels** (DocumentType, JobType, WorkflowStage, …).
- **RTL deep dive** beyond the codemod-clean state of the current
  branch.
- **Status / enum labels** rendered from backend data.

---

## 9. Final answers

- **Is multi-language implemented system-wide?** Plumbing **yes**, content
  coverage **partial**. Phases 1-5 already shipped a working stack
  (i18next + lazy locales + RTL + 6 locales + Phase 4 backend codes).
  Pages that were touched in Phases 1-3 are fully or partially
  translated; pages that were not touched still render English.
- **Estimated translation coverage:** **47%** pragmatic
  (chrome-translated) / **14%** strict (zero hardcoded literals).
- **Top 10 untranslated screens** (pure file ranking, includes detail
  panels):
  1. `/dashboard/applicants/:id` — ApplicantProfile (72)
  2. `/dashboard/candidates/:id` — CandidateProfile (69)
  3. `/dashboard/vehicles/:id` — VehicleDetail (39)
  4. `/dashboard/settings/database-backup` — DatabaseBackup (29)
  5. `/dashboard/settings/document-types/new` — DocumentTypeNew (26)
  6. `/dashboard/settings/document-types/:id/edit` — DocumentTypeEdit (26)
  7. `/dashboard/employees/:id` — EmployeeProfile (22)
  8. `/dashboard/vehicles/new` & `/:id/edit` — VehicleForm (21)
  9. `/dashboard/workflow/analytics` — WorkflowAnalytics (19)
  10. `/dashboard/settings/document-types/:id` — DocumentTypeView (19)
- **Recommended Phase 2 targets:** Tier 1 (the four profile pages) plus
  the vehicle detail/form. That single PR converts the four highest-
  traffic detail pages and removes ~225 hardcoded literals, lifting
  pragmatic coverage from 47% to roughly 55–60%.
- **Suggested next prompt to send:**

  > Implement Phase 2 of the route audit. Translate the four profile
  > pages — `ApplicantProfile`, `CandidateProfile`, `EmployeeProfile`,
  > `AgencyProfile` — plus `VehicleDetail` and `VehicleForm`. Extend the
  > `pages` namespace with the missing keys for tabs, detail rows,
  > status labels, action buttons, and confirmation dialogs. Use
  > existing helpers (`enumLabel`, `formatDate`, `formatCurrency`,
  > `apiError`) where applicable. Run `npm run i18n:check-keys` and
  > `npm run i18n:check-literals` before commit. Push to a new branch.
