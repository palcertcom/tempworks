# TempWorks Europe — Employee Recruitment & Compliance Management System

A full-stack, production-ready web application for managing driver/employee recruitment, compliance, documents, visa/work-permit workflows, and agency relationships across Europe.

---

## Project Overview

TempWorks Europe is an enterprise-grade recruitment and compliance platform that enables HR teams, compliance officers, and recruitment agencies to:

- Track employees through a 14-stage onboarding workflow
- Manage document uploads, verification, and expiry tracking
- Monitor compliance alerts (expired/expiring documents)
- Handle visa and work permit applications
- Manage multi-agency users and employees
- Process job applications via a public portal
- Generate reports and analytics across all modules

---

## Architecture Overview

```
/
├── src/                    ← Frontend (React 18 + Vite + Tailwind CSS)
│   └── app/
│       ├── components/     ← UI components (shadcn/ui + custom)
│       ├── pages/          ← 38+ page components
│       ├── services/       ← API client (api.ts) + hooks
│       ├── hooks/          ← useApi, useAuth hooks
│       └── data/           ← Type definitions + mock data (legacy)
├── backend/                ← Backend (NestJS + TypeScript + Prisma)
│   ├── prisma/
│   │   ├── schema.prisma   ← Database schema (20 models)
│   │   └── seed.ts         ← Seed data
│   └── src/
│       ├── auth/           ← JWT auth module
│       ├── users/          ← User management
│       ├── roles/          ← RBAC roles & permissions
│       ├── employees/      ← Employee management
│       ├── applicants/     ← Applicant management
│       ├── applications/   ← Application processing
│       ├── documents/      ← Document upload & compliance
│       ├── workflow/       ← 14-stage workflow pipeline
│       ├── agencies/       ← Agency management
│       ├── compliance/     ← Compliance monitoring
│       ├── reports/        ← Analytics & reporting
│       ├── notifications/  ← In-app notifications
│       ├── settings/       ← System configuration
│       ├── logs/           ← Audit logging
│       ├── prisma/         ← Prisma service
│       └── common/         ← Shared DTOs, filters, decorators
├── ANALYSIS.md             ← Reverse engineering analysis
└── README.md               ← This file
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, Vite, TypeScript, Tailwind CSS |
| UI Components | shadcn/ui (Radix UI), Lucide Icons, Recharts |
| Routing | React Router v7 |
| Forms | React Hook Form |
| Backend | NestJS 10, TypeScript |
| ORM | Prisma 5 |
| Database | PostgreSQL |
| Auth | JWT (access 15m + refresh 7d), bcrypt |
| Validation | class-validator, class-transformer |
| API Docs | Swagger/OpenAPI (@nestjs/swagger) |
| File Upload | Multer |
| Notifications | Sonner (toast) |

---

## Setup Instructions

### Prerequisites

- Node.js ≥ 18
- PostgreSQL ≥ 14
- npm or pnpm

### 1. Clone & Install Frontend

```bash
# Install frontend dependencies (at repo root)
npm install
```

### 2. Setup Backend

```bash
cd backend
npm install
```

### 3. Configure Environment Variables

**Backend:**
```bash
cp backend/.env.example backend/.env
# Edit backend/.env with your PostgreSQL connection details
```

**Frontend:**
```bash
cp .env.example .env
# VITE_API_URL=http://localhost:3000/api/v1 (default)
```

### 4. Database Setup

```bash
cd backend

# Generate Prisma client
npm run prisma:generate

# Run migrations (creates all tables)
npm run prisma:migrate
# or for production:
npx prisma migrate deploy

# Seed initial data (roles, permissions, admin user, lookup data)
npm run seed
```

---

## Running the Application

### Development Mode

```bash
# Terminal 1 — Backend API
cd backend
npm run start:dev
# API: http://localhost:3000/api/v1
# Swagger: http://localhost:3000/api/docs

# Terminal 2 — Frontend
cd ..   # back to repo root
npm run dev
# Frontend: http://localhost:5173
```

### Production Build

```bash
# Backend
cd backend
npm run build
npm run start:prod

# Frontend
npm run build
# Serve dist/ with nginx or your preferred static server
```

---

## Environment Variables

### Backend (`backend/.env`)

| Variable | Description | Default |
|---|---|---|
| `DATABASE_URL` | PostgreSQL connection string | — |
| `JWT_SECRET` | Access token secret | — |
| `JWT_REFRESH_SECRET` | Refresh token secret | — |
| `JWT_ACCESS_EXPIRES_IN` | Access token TTL | `15m` |
| `JWT_REFRESH_EXPIRES_IN` | Refresh token TTL | `7d` |
| `PORT` | API server port | `3000` |
| `NODE_ENV` | Environment | `development` |
| `FRONTEND_URL` | CORS origin | `http://localhost:5173` |
| `UPLOAD_DEST` | File upload directory | `./uploads` |
| `MAX_FILE_SIZE` | Max upload size (bytes) | `10485760` (10MB) |

### Frontend (`.env`)

| Variable | Description | Default |
|---|---|---|
| `VITE_API_URL` | Backend API base URL | `http://localhost:3000/api/v1` |
| `VITE_APP_NAME` | App display name | `TempWorks Europe` |

---

## Database Schema

The database contains **20 models** covering the full domain:

### Core Entities
- **User** — Staff accounts with roles and agency assignment
- **Role** — Named roles with permission sets (8 default roles)
- **Permission** — Granular module:action permissions (55 total)
- **Agency** — Multi-tenant recruitment agencies

### Recruitment Pipeline
- **Employee** — Active workforce (14-stage workflow)
- **Applicant** — Job candidates in recruitment pipeline
- **Application** — Links applicants to job applications
- **JobType** — Employment categories (Driver CE, Warehouse, etc.)

### Workflow
- **WorkflowStage** — 14 stages from Application to Deployment
- **EmployeeWorkflowStage** — Per-employee stage tracking
- **WorkPermit** — Work authorization records
- **Visa** — Visa application tracking

### Documents & Compliance
- **Document** — Uploaded files with expiry tracking
- **DocumentType** — Configurable document categories
- **ComplianceAlert** — Automated alerts for expiry/issues

### System
- **Notification** — Per-user in-app notifications
- **AuditLog** — Complete mutation history
- **SystemSetting** — Key-value configuration store
- **NotificationRule** — Automated notification triggers

---

## Migration & Seed Commands

```bash
cd backend

# Create new migration (development)
npx prisma migrate dev --name <migration_name>

# Apply migrations (production)
npx prisma migrate deploy

# Reset database and re-seed (DESTRUCTIVE)
npx prisma migrate reset

# Run seed file only
npm run seed
# or: npx ts-node prisma/seed.ts

# Open Prisma Studio (GUI)
npm run prisma:studio
```

---

## Default Seeded Credentials

After running `npm run seed`:

| Email | Password | Role |
|---|---|---|
| `admin@tempworks.com` | `Admin@123456` | System Admin |
| `hr@tempworks.com` | `Hr@123456` | HR Manager |
| `compliance@tempworks.com` | `Compliance@123456` | Compliance Officer |
| `recruiter@tempworks.com` | `Recruiter@123456` | Recruiter |

> **Important:** Change these passwords immediately in production.

---

## Swagger / OpenAPI

Swagger UI is available at: **http://localhost:3000/api/docs**

- All endpoints are documented with request/response schemas
- Use the "Authorize" button and paste a JWT bearer token
- Login via `POST /api/v1/auth/login` to get a token

---

## Key Modules & API Endpoints

| Module | Base Path | Key Endpoints |
|---|---|---|
| Auth | `/api/v1/auth` | POST /login, /logout, /refresh, /me |
| Users | `/api/v1/users` | CRUD + /me/profile |
| Roles | `/api/v1/roles` | CRUD + /permissions + /permissions-matrix |
| Employees | `/api/v1/employees` | CRUD + /documents, /workflow, /compliance, /certifications, /training, /performance |
| Applicants | `/api/v1/applicants` | CRUD + /application + /convert |
| Applications | `/api/v1/applications` | CRUD + /status + /notes + POST /public |
| Documents | `/api/v1/documents` | CRUD + /upload + /verify + /entity/:type/:id |
| Workflow | `/api/v1/workflow` | /stages, /overview, /analytics, /timeline/:id, work-permits, visas |
| Agencies | `/api/v1/agencies` | CRUD + /users + /employees + /stats |
| Compliance | `/api/v1/compliance` | /dashboard, /alerts, /employees/:id, /expiring-documents, /run-check |
| Reports | `/api/v1/reports` | /dashboard, /employees, /applications, /documents, /compliance |
| Notifications | `/api/v1/notifications` | CRUD + /unread-count + /mark-all-read |
| Settings | `/api/v1/settings` | CRUD + job-types + document-types + workflow-stages + notification-rules |
| Logs | `/api/v1/logs` | GET + /stats |

---

## Default Roles & Permissions

| Role | Description |
|---|---|
| System Admin | Full access to all modules |
| HR Manager | Employees, applicants, applications, documents, reports |
| Compliance Officer | Compliance, documents verification, alerts |
| Recruiter | Applicants, applications, basic employee read |
| Agency Manager | Manage own agency users and employees |
| Agency User | View own agency employees |
| Finance | Read-only + reports/export |
| Read Only | Read-only access to all modules |

---

## File Uploads

Files are stored in `backend/uploads/` directory.

- Max file size: 10MB
- Supported types: PDF, JPG, PNG, DOC, DOCX
- Files served at: `http://localhost:3000/uploads/<filename>`

For production, replace with S3 or equivalent object storage.

---

## Assumptions Made

1. **Multi-tenancy** via `agencyId` — users and employees belong to agencies
2. **Soft delete** on all major entities — `deletedAt` timestamp pattern
3. **File storage** is local disk (replace with S3 for production)
4. **Email** is not implemented (forgot password returns success message)
5. **Document entity polymorphism** — documents can belong to employees or applicants via `entityType`/`entityId`
6. **Workflow stages** are initialized for each new employee automatically
7. **Compliance checks** run on-demand via `/api/v1/compliance/run-check`

---

## Deployment Notes

1. Set all environment variables (especially `JWT_SECRET`, `JWT_REFRESH_SECRET`)
2. Run `npx prisma migrate deploy` before starting
3. Set `NODE_ENV=production`
4. Configure a reverse proxy (nginx) to serve both frontend and backend
5. Mount an external volume for `backend/uploads/`
6. Consider adding a cron job to call `/api/v1/compliance/run-check` daily

---

## Future Improvements

- Email notifications (integrate SendGrid or AWS SES)
- S3 file storage integration
- WebSocket support for real-time notifications
- Advanced reporting with PDF/CSV export
- Two-factor authentication (TOTP)
- OAuth2 / SSO integration
- Scheduled compliance checks via cron
- Mobile-responsive enhancements
