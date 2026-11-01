# TempWorks Europe – Repository Analysis

## Discovered Modules

| Module | Routes | Status |
|---|---|---|
| Auth | /login | Frontend only |
| Dashboard | /dashboard | Frontend only (mock stats) |
| Employees | /dashboard/employees/* | Frontend only (mock data) |
| Applicants | /dashboard/applicants/* | Frontend only (mock data) |
| Applications | /dashboard/applications/*, /apply | Frontend only |
| Documents | /dashboard/documents/*, /document-explorer | Frontend only |
| Workflow | /dashboard/workflow/*, /workflow-management | Frontend only |
| Agencies | /dashboard/agencies/* | Frontend only |
| Compliance | /dashboard/compliance/* | Frontend only |
| Reports | /dashboard/reports | Frontend only |
| Notifications | /dashboard/notifications | Frontend only |
| Users | /dashboard/users/* | Frontend only |
| Roles/Permissions | /dashboard/roles/* | Frontend only |
| Settings | /dashboard/settings/* | Frontend only |
| System Logs | /dashboard/logs | Frontend only |

## Discovered Screens (38+)

- Landing Page, Login, Public Application Form, Application Success
- Dashboard (KPIs, pipeline, alerts, trends)
- Employees: List, Add, Profile, Edit, Certifications, Training History, Compliance Timeline, Performance Review
- Applicants: List, Add, Profile, Edit
- Applications: List, Details, Driver Application Form
- Documents: Dashboard, Upload, Preview, Verification, Document Explorer, Compliance View
- Workflow: Overview (14 stages), Work Permit Tracking, Visa Tracking, Stage Details, Timeline, Analytics, Management
- Agencies: List, Add, Profile, User Management
- Compliance: Dashboard, Alerts, Driver Compliance
- Reports Dashboard
- Notifications Center
- Users: List, Add, Edit
- Roles: List, Create/Edit, Permissions Matrix
- Settings: Hub, Job Types, Workflow, Document Types (CRUD), Notification Rules, Security
- System Logs Dashboard
- Profile, Change Password

## Inferred Entities

### Core
- **User**: Authentication, RBAC, multi-agency support
- **Role**: Named roles with permission sets
- **Permission**: Granular module/action permissions
- **Agency**: Multi-tenant agencies (recruiters work within agencies)

### Recruitment
- **Employee** (formerly Driver): Active workforce members
- **Applicant**: Job candidates in recruitment pipeline
- **Application**: Formal job application linking applicant to process
- **JobType**: Categories of employment (Driver, Warehouse, etc.)

### Workflow
- **WorkflowStage**: 14-stage recruitment pipeline (Application → Deployment)
- **EmployeeWorkflowStage**: Per-employee stage tracking with status/dates
- **WorkPermit**: Work authorization tracking
- **Visa**: Visa application and tracking

### Documents & Compliance
- **Document**: Uploaded documents with expiry tracking
- **DocumentType**: Configured document categories
- **ComplianceAlert**: Automated alerts for expiring/missing documents

### System
- **Notification**: In-app notifications per user
- **AuditLog**: Complete audit trail of mutations
- **SystemSetting**: Key-value configuration store
- **NotificationRule**: Automated notification trigger rules

## Major Workflows

1. **Recruitment Pipeline**: Applicant submits → HR reviews → Document verification → Work permit → Visa → Arrival → Training → Deployment
2. **Document Management**: Upload → Type assignment → Expiry tracking → Alert generation → Renewal
3. **Compliance Monitoring**: Scheduled checks → Alert creation → Notification dispatch → Resolution tracking
4. **User Management**: Create user → Assign role → Link to agency → Set permissions
5. **Agency Management**: Create agency → Add users → Monitor employee pool → Review compliance

## Missing Backend Features (All)

- Authentication API (login, refresh, logout)
- All CRUD endpoints for every entity
- File upload handling (documents)
- JWT + refresh token flow
- Role-based access control enforcement
- Pagination, filtering, sorting APIs
- Dashboard aggregation queries
- Compliance alert generation logic
- Notification system
- Audit logging
- Report generation and CSV export
- Email notification dispatch

## Proposed Architecture

```
/
├── src/              ← Frontend (React + Vite)
├── backend/          ← Backend (NestJS + Prisma)
│   ├── prisma/       ← Schema, migrations, seed
│   ├── src/
│   │   ├── auth/
│   │   ├── users/
│   │   ├── roles/
│   │   ├── employees/
│   │   ├── applicants/
│   │   ├── applications/
│   │   ├── documents/
│   │   ├── workflow/
│   │   ├── agencies/
│   │   ├── compliance/
│   │   ├── reports/
│   │   ├── notifications/
│   │   ├── settings/
│   │   ├── logs/
│   │   ├── prisma/
│   │   └── common/
│   └── uploads/      ← File storage
└── README.md
```

## Key Assumptions

1. PostgreSQL as the primary database
2. NestJS as the API framework (enterprise-grade, modular, TypeScript-first)
3. Prisma as ORM (type-safe, migration-based)
4. JWT access tokens (15m) + refresh tokens (7d) stored in httpOnly cookies
5. Files stored on local disk (uploads/) — can be swapped for S3
6. All entities support soft delete via `deletedAt` timestamp
7. Multi-tenancy via `agencyId` on users and employees
8. Swagger available at /api/docs
9. API prefix: /api/v1
