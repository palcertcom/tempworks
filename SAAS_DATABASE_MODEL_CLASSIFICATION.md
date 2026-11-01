# SaaS Database Model Classification

**Schema:** `backend/prisma/schema.prisma` (66 models)
**Convention used below:**
- **GLOBAL** — single row set shared by all tenants; never gets a `tenantId`.
- **TENANT** — gets `tenantId UUID NOT NULL` and is filtered by `TenantPrismaService` + RLS.
- **TENANT (agency-scoped)** — TENANT + already has or gains `agencyId`; agency-scope guard applies.
- **MEMBERSHIP/RBAC** — joins users to tenants/agencies; lives outside the tenant scope guard but every read enforces actor ownership.
- **PLATFORM-ADMIN** — only the super-admin app may read/write; protected by `PlatformPrismaService`.
- **NEEDS DECISION** — flagged for an explicit ADR.

> Notation: `(+ tenantId)` = add. `(unique → (tenantId, X))` = change unique constraint. `(idx)` = add composite index.

---

## A. Identity & Tenancy (new + reshaped)

| Model | Class | Required changes | Risk |
|---|---|---|---|
| **Tenant** *(NEW)* | GLOBAL (provisioning) | Create. `id, slug @unique, name, status, planId, region, customDomain @unique, branding(jsonb), createdAt`. | LOW |
| **TenantMembership** *(NEW)* | MEMBERSHIP | `id, userId, tenantId, status, invitedBy, joinedAt`; `@@unique([userId, tenantId])`; `@@index([tenantId, status])`. | LOW |
| **MembershipRole** *(NEW)* | MEMBERSHIP | join table `(membershipId, roleId)`; replaces `User.roleId` semantics within a tenant. | LOW |
| **AgencyMembership** *(NEW)* | MEMBERSHIP | `id, membershipId, agencyId, scope (FULL/READ/RECRUITER)`. Existing `EmployeeAgencyAccess` + `AgencyUserPermission` align with this. | LOW |
| **PlatformAdmin** *(NEW)* | PLATFORM-ADMIN | `id, userId @unique, level, grantedBy, grantedAt`. Replaces `Agency.isSystem` JWT bypass. | LOW |
| **PlatformAuditLog** *(NEW)* | PLATFORM-ADMIN | every super-admin action; append-only, partitioned by month. | LOW |
| **TenantDomain** *(NEW)* | GLOBAL | `id, tenantId, host @unique, verifiedAt`. For custom domains. | LOW |

---

## B. User & Auth

| Model | Class | `tenantId`? | Required changes | Risk |
|---|---|---|---|---|
| **User** | GLOBAL | **No** | Drop `roleId`, `agencyId` semantics (keep columns nullable as legacy until Phase 3 contract). Email stays globally unique (login). Add `emailVerified`, `mfaEnabled`. Add relation `memberships TenantMembership[]`. | HIGH — many references |
| **Role** | GLOBAL (system templates) **+** TENANT (custom) | Optional | Add `tenantId String?`; `@@unique([tenantId, name])` (drop global `name @unique`). System roles have `tenantId = null` and `isSystem = true`. | MEDIUM |
| **Permission** | GLOBAL | No | Keep as system catalog. No change. | LOW |
| **RolePermission** | GLOBAL/TENANT (follows Role) | Inherits | No structural change; FK cascade unchanged. | LOW |
| **ActivationToken** | TENANT (or GLOBAL?) | **NEEDS DECISION** | If a user is invited to a tenant, the token is tenant-scoped → add `tenantId`. If used for global account activation, leave global. Recommended: `tenantId` nullable; non-null for tenant invites. | LOW |
| **PasswordResetToken** | GLOBAL | No | Remains global (acts on the global `User`). | LOW |
| **TwoFactorChallenge** | GLOBAL | No | Tied to user/session, not to a tenant. | LOW |

---

## C. Agency & Tenant-Internal Org

| Model | Class | `tenantId`? | Required changes | Risk |
|---|---|---|---|---|
| **Agency** | TENANT | **+ tenantId** | `+ tenantId UUID NOT NULL`. Drop `isSystem` (replaced by `PlatformAdmin`). `@@unique([tenantId, name])`. `@@index([tenantId])`. **Backfill**: every existing customer agency = its own new Tenant; the Tempworks `isSystem=true` agency disappears (its users become PlatformAdmins). | HIGH |
| **EmployeeAgencyAccess** | TENANT | **+ tenantId** | `@@unique([tenantId, employeeId, agencyId])`. | MEDIUM |
| **AgencyUserPermission** | TENANT | + tenantId (via membership) | Migrate to `MembershipRole` overrides + retain table for fine-grained per-user grants (rename `MembershipPermission`). | MEDIUM |
| **AgencyPermissionOverride** | TENANT | + tenantId | `@@unique([tenantId, agencyId, permissionId])`. | LOW |

---

## D. Recruitment & Employees

| Model | Class | `tenantId`? | Required changes | Risk |
|---|---|---|---|---|
| **Applicant** | TENANT (agency) | **+ tenantId** | Add `tenantId`; index `(tenantId, agencyId, status, createdAt)`. Email NOT unique today → keep that way; add **soft** uniqueness `(tenantId, email)` if business requires. | MEDIUM |
| **ApplicantFinancialProfile** | TENANT | + tenantId (denorm) | Composite index `(tenantId, applicantId)`. | LOW |
| **ApplicantAgencyHistory** | TENANT | + tenantId | `(tenantId, applicantId, agencyId)` index. | LOW |
| **ApplicationDraft** | TENANT | + tenantId | `@@unique([tenantId, createdById])`. | LOW |
| **CandidateDeleteRequest** | TENANT | + tenantId | `(tenantId, applicantId)` index. | LOW |
| **Employee** | TENANT (agency) | **+ tenantId** | **CRITICAL:** drop `email @unique`; add `@@unique([tenantId, email])` and `@@unique([tenantId, employeeCode])`. Index `(tenantId, agencyId, status)`. | HIGH — legacy code expects global unique |
| **EmployeeStage** | TENANT | + tenantId (denorm from Employee) | `@@unique([tenantId, employeeId, stageOrder])`. | LOW |
| **EmployeeWorkHistory** | TENANT | + tenantId | `(tenantId, employeeId)` index. | LOW |
| **EmployeeWorkHistoryAttachment** | TENANT | + tenantId | `(tenantId, workHistoryId)` index. | LOW |
| **EmployeeWorkflowAssignment** | TENANT | + tenantId | `(tenantId, employeeId, workflowId)`. | LOW |
| **CandidateWorkflowAssignment** | TENANT | + tenantId | as above for applicants. | LOW |

---

## E. Compliance, Documents, Visas

| Model | Class | `tenantId`? | Required changes | Risk |
|---|---|---|---|---|
| **Document** | TENANT | **+ tenantId** (denorm) | Currently entity-indirect. Add `tenantId` denormalized at write time. Drop `docId @unique` global → `@@unique([tenantId, docId])`. Index `(tenantId, entityType, entityId)`. | HIGH — many references; rebuild backfill carefully |
| **DocumentType** | GLOBAL catalog **+** TENANT overrides | optional | Keep system catalog (`tenantId = null`). Allow `tenantId` non-null custom types. `@@unique([tenantId, name])`. | MEDIUM |
| **WorkPermit** | TENANT | + tenantId (denorm via Employee) | `(tenantId, employeeId, expiresAt)` index. | LOW |
| **Visa** | TENANT | + tenantId | `(tenantId, entityType, entityId)`. | LOW |
| **ComplianceAlert** | TENANT | **+ tenantId** | Currently entity-indirect. Add `tenantId` denormalized; index `(tenantId, status, severity, createdAt)`. | HIGH |

---

## F. Finance, Attendance, Vehicles

| Model | Class | `tenantId`? | Required changes | Risk |
|---|---|---|---|---|
| **FinancialRecord** | TENANT | **+ tenantId** | Index `(tenantId, entityType, entityId, createdAt)`. Money columns confirmed `Decimal(18,4)` + currency. | HIGH |
| **AttendanceRecord** | TENANT | + tenantId | `@@unique([tenantId, employeeId, date])`. Partition candidate. | MEDIUM |
| **AttendanceLockedPeriod** | TENANT | **+ tenantId** | Drop `@@unique([year, month])` → `@@unique([tenantId, year, month])`. **CRITICAL** correctness fix. | CRITICAL |
| **Vehicle** | TENANT (agency) | + tenantId | Already has `agencyId`; add `tenantId`. `(tenantId, agencyId)` index. | LOW |
| **VehicleDriverAssignment** | TENANT | + tenantId | `(tenantId, vehicleId)`. | LOW |
| **VehicleDocument** | TENANT | + tenantId | merges with Document strategy if unified later. | LOW |
| **MaintenanceRecord** | TENANT | + tenantId | `(tenantId, vehicleId, date)`. | LOW |
| **MaintenanceType** | GLOBAL catalog **+** TENANT overrides | optional | `@@unique([tenantId, name])` with null-tenant for catalog. | LOW |
| **Workshop** | TENANT | **+ tenantId** | Currently global; tenants must own their workshop list. | MEDIUM |

---

## G. Workflow & Pipeline

| Model | Class | `tenantId`? | Required changes | Risk |
|---|---|---|---|---|
| **Workflow** | TENANT | **+ tenantId** | Default `isPublic=false`; system templates remain `tenantId=null` and read-only. On first use, copy template into tenant. | HIGH |
| **WorkflowStage** | TENANT | + tenantId (denorm) | `@@unique([tenantId, workflowId, order])`. | MEDIUM |
| **WorkflowAccessUser** | TENANT | + tenantId | `@@unique([tenantId, workflowId, userId])`. | LOW |
| **EmployeeStageApproval** | TENANT | + tenantId | `(tenantId, employeeId, stageId)`. | LOW |

---

## H. Notifications & Settings

| Model | Class | `tenantId`? | Required changes | Risk |
|---|---|---|---|---|
| **Notification** | TENANT | + tenantId | `(tenantId, userId, readAt, createdAt)`. Partition candidate. | MEDIUM |
| **NotificationPreference** | TENANT | + tenantId | `@@unique([tenantId, userId])` (a user can have a preference per tenant). | MEDIUM |
| **NotificationRule** | GLOBAL **+** TENANT overrides | optional | Keep template rules global; allow tenants to override. | LOW |
| **SystemSetting** | SPLIT | partial | Branding/locale/feature config moves to `Tenant.branding` JSON + `tenant_settings` table. Truly global flags stay here. | MEDIUM |

---

## I. Job Ads & Reports

| Model | Class | `tenantId`? | Required changes | Risk |
|---|---|---|---|---|
| **JobAd** | TENANT | **+ tenantId** | Drop `slug @unique` → `@@unique([tenantId, slug])`. Public URLs become `acme.app.tempworks.com/jobs/<slug>` (tenant from host). | HIGH |
| **JobAdRequiredDocument** | TENANT | + tenantId (denorm) | `(tenantId, jobAdId)`. | LOW |
| **Report** | TENANT | + tenantId | Drop `name @unique` → `@@unique([tenantId, name])`. | MEDIUM |
| **ReportFilter** | TENANT | + tenantId | inherit. | LOW |
| **ReportColumn** | TENANT | + tenantId | inherit. | LOW |
| **ReportSorting** | TENANT | + tenantId | inherit. | LOW |

---

## J. Identifier Sequences, Audit, Backup, Recycle Bin

| Model | Class | `tenantId`? | Required changes | Risk |
|---|---|---|---|---|
| **IdentifierSequence** | TENANT | **+ tenantId** | `@@unique([tenantId, prefix, year, month])`. **Must be backfilled per-tenant before next applicant/employee insert.** | CRITICAL |
| **AuditLog** | TENANT (+ PLATFORM mirror) | + tenantId | `(tenantId, createdAt)` partitioned. Platform-admin actions also written to `platform_audit_log`. | HIGH |
| **SystemBackup** | PLATFORM-ADMIN | No | Backup metadata stays platform-admin. Add a separate per-tenant **export** model: `TenantExport(id, tenantId, status, storageKey)`. | MEDIUM |
| **RecycleBinItem** *(if exists in `recycle-bin` module)* | TENANT | + tenantId | `(tenantId, entityType, entityId, deletedAt)`. Restore must verify `tenantId` match. | HIGH |

---

## K. Index & Constraint Patch Summary (canonical examples)

```prisma
// Employee
@@unique([tenantId, email])
@@unique([tenantId, employeeCode])
@@index([tenantId, agencyId, status])
@@index([tenantId, status, createdAt])

// Applicant
@@index([tenantId, agencyId, status, createdAt])
@@index([tenantId, email])

// Document
@@unique([tenantId, docId])
@@index([tenantId, entityType, entityId])
@@index([tenantId, expiresAt]) // for scheduler

// JobAd
@@unique([tenantId, slug])

// Report
@@unique([tenantId, name])

// IdentifierSequence
@@unique([tenantId, prefix, year, month])

// AttendanceLockedPeriod
@@unique([tenantId, year, month])
```

---

## L. RLS Coverage Plan

Enable `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` on every TENANT and TENANT-agency model in this document. Policy template:

```sql
CREATE POLICY tenant_isolation ON <table>
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY platform_admin_bypass ON <table>
  TO platform_admin USING (true) WITH CHECK (true);
```

GLOBAL tables (User, Permission, system Roles, system catalogs, SystemBackup) keep RLS disabled. PLATFORM-ADMIN tables keep RLS disabled and are network-isolated.

---

## M. Open Decisions (ADR-Required)

| ADR | Question | Recommended Default |
|---|---|---|
| ADR-001 | Email uniqueness on `User` | **Global unique** (login is global). |
| ADR-002 | Email uniqueness on `Employee` / `Applicant` | **Per tenant** unique on Employee; **non-unique** on Applicant (current behavior). |
| ADR-003 | `DocumentType`, `MaintenanceType`, `NotificationRule` | **Catalog (tenantId null) + tenant overrides.** |
| ADR-004 | `Workflow` system templates | **Read-only templates; clone-on-use into tenant.** |
| ADR-005 | `AuditLog` per-tenant or global | **Per-tenant primary + platform mirror for super-admin actions.** |
| ADR-006 | Identifier prefix collisions across tenants | **`(tenantId, prefix, year, month)`; reset counters at tenant creation.** |
| ADR-007 | Tenant-aware backups | **Keep `pg_dump` for ops; build separate logical `TenantExport`.** |
| ADR-008 | Branding location | **`Tenant.branding` JSONB; legacy `SystemSetting branding_*` migrated.** |
