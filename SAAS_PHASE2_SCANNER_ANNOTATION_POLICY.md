# Phase 2.12 — Scanner Annotation Policy

> Sharpen the tools before cutting the bigger beams.
>
> Defines the allowed `// @tenant-reviewed:` annotation tags, where
> they may appear, how they expire, and how the scanner validates them.

---

## 1. The contract

Every direct `prisma.<model>.<op>` call site in application code must
fall into one of two categories:

1. **Allow-listed** — the file lives in `src/prisma/`,
   `src/saas/prisma/`, or `src/saas/__validation__/`. No annotation
   needed; the scanner skips these directories.
2. **Reviewed** — the line carries a `// @tenant-reviewed: <reason>`
   comment whose `<reason>` is in the policy below.

Any other `prisma.X.<op>` line is reported as `USAGE` by `saas:scan`
and counted against the strict-mode threshold.

## 2. Allowed reasons (alphabetical)

| Reason tag | Meaning | Allowed paths | Phase |
|---|---|---|---|
| `phase26-pilot-accessor` | Site routes through `PilotPrismaAccessor.client()`; model is GLOBAL — pilot is a pass-through. | `src/roles/**` | 2.6 |
| `phase27-pilot-scope` | Site spreads `getPilotScope(this.pilot, 'employee-work-history').tenantWhere()` (or `.tenantData()`). | `src/employee-work-history/**` | 2.7 |
| `phase27-audit-log` | `legacyPrisma.auditLog.create` — global side-effect kept legacy. | `src/employee-work-history/**` | 2.7 |
| `phase28-pilot-scope` | Same as 2.7 for compliance module. | `src/compliance/**` | 2.8 |
| `phase28-audit-log` | Audit log on legacyPrisma. | `src/compliance/**` | 2.8 |
| `phase29-pilot-scope` | Same as 2.7 for job-ads module. Notes: `uniqueSlug` lookup intentionally tenant-agnostic. | `src/job-ads/**` | 2.9 |
| `phase210-pilot-scope` | Same for notifications read paths. | `src/notifications/**` | 2.10 |
| `phase210-excluded-background` | Notifications scheduler / fanout — out of scope until job-context framework lands. | `src/notifications/**` | 2.10 |
| `phase210-global` | Per-user global model (`NotificationPreference`); no tenantId by design. | `src/notifications/**` | 2.10 |
| `phase211-pilot-scope` | Recycle-bin tenant-scoped entity sites. | `src/recycle-bin/**` | 2.11 |
| `phase211-pilot-scope (or global; spread is tenantWhereFor)` | Same as above with the per-entity dispatch helper. | `src/recycle-bin/**` | 2.11 |
| `phase211-pilot-scope (ownership pre-checked)` | Restore / hard-delete branches running on `legacyPrisma` after `assertTenantOwnership` already authorized. | `src/recycle-bin/**` | 2.11 |
| `phase211-pilot-scope (parent FR was tenant-checked)` | `FinancialRecordAttachment` reads scoped via the parent's tenant filter. | `src/recycle-bin/**` | 2.11 |
| `phase211-global` | Recycle-bin global / catalog entity sites (USER, ROLE, DOCUMENT_TYPE, MAINTENANCE_TYPE, WORKSHOP, REPORT). | `src/recycle-bin/**` | 2.11 |
| `phase211-excluded-platform` | DatabaseCleanupService — System Admin global wipe; intentionally cross-tenant. | `src/recycle-bin/**` | 2.11 |
| `phase214-pilot-scope` | Notifications scheduler adapter sites — tenant-catalog discovery and per-tenant fanout entry points wired to the Phase 2.13 job-context framework. | `src/notifications/**` | 2.14 |
| `phase215-pilot-scope` | Notifications fanout writers (`notifyUploaderAndRoles`, `notifyUsersByRoles`) — User scan narrowed via `agency.tenantId`, uploader probe scoped to active tenant, `notification.create.data` carries `tenantId` when tid is set. | `src/notifications/**` | 2.15 |
| `phase216-pilot-scope` | Finance read sites narrowed via `getPilotScope(...).tenantWhere()`. | `src/finance/**` | 2.16 |
| `phase216-excluded-mutation` | Finance write/mutation sites kept on `legacyPrisma` until Phase 2.17. | `src/finance/**` | 2.16 |
| `phase216-helper-read` | Finance helper reads (entity-name enrichment, person resolution) operating on already tenant-filtered IDs. | `src/finance/**` | 2.16 |
| `phase216-global` | Finance global catalog reads (`finance_transaction_types`, `system_settings`). | `src/finance/**` | 2.16 |
| `phase216-audit-log` | Finance audit-log reads/writes — global by design, parent already tenant-checked. | `src/finance/**` | 2.16 |
| `phase217-pilot-scope` | Finance write sites narrowed in Phase 2.17 — `create` spreads `scope.tenantData()`; `removeDeduction` adds a parent tenant pre-check. | `src/finance/**` | 2.17 |
| `phase217-pilot-scope-precheck` | Finance write sites that rely on the prior `findOne` (Phase 2.16, tenant-scoped) as the tenant gate; the by-id `update`/`soft-delete` is unreachable for foreign tenants. | `src/finance/**` | 2.17 |
| `phase2171-helper-narrowed` | Finance helper sites (`attachEntityNames`, `resolvePersonIdentity`, `resolveEntityNameForNotif`) routed through the pilot client and spreading `scope.tenantWhere()`. Closes a real cross-tenant create vulnerability uncovered during Phase 2.17.1 real-DB execution. | `src/finance/**` | 2.17.1 |
| `phase220-pilot-scope` | Documents read sites narrowed via `getPilotScope(...).tenantWhere()`. Includes `findAll`, `findOne`, `readDocumentBytes` metadata, `findByEntity`, `getExpiringDocuments`, owner-name enrichment. | `src/documents/**` | 2.20 |
| `phase220-global` | Documents catalog reads (`DocumentType`, `DocumentTypePermission`) — no `tenantId` column today; per-tenant catalog deferred to Phase 3. | `src/documents/**` | 2.20 |
| `phase220-excluded-mutation` | Documents write/mutation sites (`create`, `update`, `verify`, `renew`, `remove`, `upsertDocTypePermission`, `checkAndAutoCompleteStage`) kept on `legacyPrisma` until Phase 2.21+. | `src/documents/**` | 2.20 |
| `phase220-excluded-helper` | Documents private owner-name helper (`resolveEntityName`) routed through `legacyPrisma`; called only from mutation/download flows. | `src/documents/**` | 2.20 |
| `phase220-excluded-download` | Documents bulk-download / file-fetch read paths (`createBulkDownloadArchive`) kept on `legacyPrisma` until Phase 2.22+ (download pilot). | `src/documents/**` | 2.20 |
| `phase220-audit-log` | Documents audit-log writes — global by design (deferred to cross-module audit phase). | `src/documents/**` | 2.20 |
| `phase221-pilot-scope` | Documents write sites narrowed in Phase 2.21 — `create` + `publicCreate` + `renew` spread `scope.tenantData()`; `complianceAlert.create` writes `tenantId`. | `src/documents/**` | 2.21 |
| `phase221-pilot-scope-precheck` | Documents write sites that rely on the prior `findOne` (Phase 2.20, tenant-scoped) as the tenant gate; the by-id `update` / `verify` / `remove` / soft-delete is unreachable for foreign tenants. | `src/documents/**` | 2.21 |
| `phase221-storage-guard` | Documents `assertEntityOwnedByActiveTenant` entity-validation lookups that gate `storage.uploadFile`. Closes a cross-tenant orphan-file attack vector. | `src/documents/**` | 2.21 |
| `phase222-download-guard` | Documents download/bulk-archive metadata lookups that gate `fetchDocumentBuffer` / `storage.downloadByUrlOrKey`. `readDocumentBytes` (re-tagged from `phase220-pilot-scope` for taxonomy clarity) and `createBulkDownloadArchive` (switched from `legacyPrisma` to `this.prisma` with `...t` spread). Closes a cross-tenant byte-read attack vector in bulk archives. | `src/documents/**` | 2.22 |
| `phase223-pilot-scope` | Vehicles read sites narrowed via `getPilotScope(...).tenantWhere()`. Includes `listVehicles`, `getVehicle`, `findVehicleOrFail` (private mutation pre-check), `getDriverHistory` (parent-gated; `VehicleDriverAssignment` has no `tenantId`), `listMaintenanceRecords`, `getMaintenanceRecord`, `getDashboardStats` parallel counts/groups, `exportVehicles`, `fetchMaintenanceForExport`. | `src/vehicles/**` | 2.23 |
| `phase223-global` | Vehicles catalog reads (`MaintenanceType`, `Workshop`) — no `tenantId` column today; per-tenant catalog deferred to Phase 3. | `src/vehicles/**` | 2.23 |
| `phase223-excluded-mutation` | Vehicles write/mutation sites (`createVehicle`, `updateVehicle`, `deleteVehicle`, `assignDriver`, `unassignDriver`, `createMaintenanceRecord`, `updateMaintenanceRecord`, `deleteMaintenanceRecord`, catalog CRUD) kept on `legacyPrisma` until Phase 2.24+. | `src/vehicles/**` | 2.23 |
| `phase223-excluded-storage` | Vehicles storage / vehicle-document write sites (`addDocument`, `updateDocument`, `deleteDocument`) kept on `legacyPrisma` until Phase 2.25+. | `src/vehicles/**` | 2.23 |
| `phase224-pilot-scope` | Vehicles write sites narrowed in Phase 2.24 — `createVehicle` + `createMaintenanceRecord` spread `scope.tenantData()`; `assignDriver` employee probe + `updateMaintenanceRecord` / `deleteMaintenanceRecord` pre-checks via `this.prisma.X.findFirst({ id, ...t })`. | `src/vehicles/**` | 2.24 |
| `phase224-pilot-scope-precheck` | Vehicles by-id mutation sites gated by the prior tenant-scoped pre-check (`findVehicleOrFail` or `maintenanceRecord.findFirst`). The by-id mutation never reaches a foreign tenant's row in pilot mode. | `src/vehicles/**` | 2.24 |
| `phase225-pilot-scope` | Vehicles storage / vehicle-document write sites narrowed in Phase 2.25 — `addDocument` spreads `scope.tenantData()` on the new `VehicleDocument` row. | `src/vehicles/**` | 2.25 |
| `phase225-pilot-scope-precheck` | Vehicles `updateDocument` / `deleteDocument` by-id mutation sites gated by the NEW explicit `findVehicleOrFail(vehicleId)` parent gate (Phase 2.25). Closes a real cross-tenant mutation gap. | `src/vehicles/**` | 2.25 |
| `phase225-storage-guard` | Reserved for future storage-bound vehicle-document refactors (file-replacement, real-delete from bucket); today the storage guard is the parent vehicle gate. | `src/vehicles/**` | 2.25 |
| `phase226-pilot-scope` | Workflow read sites narrowed via `getPilotScope(...).tenantWhere()` (Applicant/Employee/WorkPermit/Visa direct tenantId) or `employee: { tenantId }` relation filter (EmployeeStage aggregates). Includes `getOverview`, `getAnalytics`, `getTimeline`, `getStageDetails`, `findWorkPermits`, `findVisas`. | `src/workflow/**` | 2.26 |
| `phase226-global` | Workflow `StageTemplate` reads — global catalog (no `tenantId` column today; per-tenant override deferred to Phase 3 per `SAAS_PHASE2_WORKFLOW_SYSTEM_TEMPLATE_DECISION.md`). | `src/workflow/**` | 2.26 |
| `phase226-excluded-mutation` | Workflow write/mutation sites (`updateEmployeeWorkflowStage`, `setEmployeeCurrentStage`, `createWorkPermit`, `updateWorkPermit`, `createVisa`, `updateVisa`) kept on `legacyPrisma` until Phase 2.27+. | `src/workflow/**` | 2.26 |
| `phase226-audit-log` | Workflow audit-log writes — global by design (deferred to cross-module audit phase). | `src/workflow/**` | 2.26 |
| `phase227-pilot-scope` | Workflow write sites narrowed in Phase 2.27 — `findEmployeeOrFail` / `findApplicantOrFail` parent gates, `createWorkPermit` / `createVisa` `scope.tenantData()` spreads, `updateWorkPermit` / `updateVisa` tenant-scoped pre-checks. | `src/workflow/**` | 2.27 |
| `phase227-pilot-scope-precheck` | Workflow by-id / by-key mutation sites gated by the prior tenant-scoped pre-check (`findEmployeeOrFail` parent gate or `workPermit/visa.findFirst({ id, ...t })`). The mutation never reaches a foreign tenant's row in pilot mode. | `src/workflow/**` | 2.27 |
| `phase228-pilot-scope` | Applicants read sites narrowed via `getPilotScope(...).tenantWhere()`. Includes `findAll`, `findOne` (migrated `findUnique`→`findFirst`), `findApplicantOrFail` private gate, `exportCsv`, `exportExcel`, `getDeleteRequests` via `applicant: { tenantId }` relation filter. | `src/applicants/**` | 2.28 |
| `phase228-pilot-scope-precheck` | Applicants child-of-applicant reads gated by the prior tenant-scoped `findOne` (Phase 2.28). `getFinancialProfile` / `getAgencyHistory` / `reviewDeleteRequest` lookup. | `src/applicants/**` | 2.28 |
| `phase228-global` | Applicants intentionally global lookups: email duplicate-check (Applicant.email @unique stays globally unique), raw SQL identifier generators, StageTemplate (Phase 2.26 catalog) and SystemSetting reads inside mutation paths. | `src/applicants/**` | 2.28 |
| `phase228-excluded-mutation` | Applicants write/lifecycle/conversion sites (every CRUD / status / convert / reassign / bulk / delete-request method) kept on `legacyPrisma` until Phase 2.29+. | `src/applicants/**` | 2.28 |
| `phase228-audit-log` | Applicants audit-log writes — global by design (deferred to cross-module audit phase). | `src/applicants/**` | 2.28 |
| `phase229-pilot-scope` | Applicants write sites narrowed in Phase 2.29 — `create` + `convertToEmployee.employee.create` spread `scope.tenantData()`; `findAgencyOrFail` agency gate. | `src/applicants/**` | 2.29 |
| `phase229-pilot-scope-precheck` | Applicants by-id mutation sites gated by the prior tenant-scoped `findOne` (Phase 2.28). The mutation never reaches a foreign tenant's row in pilot mode. | `src/applicants/**` | 2.29 |
| `phase229-bulk-filter` | Applicants `bulkAction` id pre-filter — `applicant.findMany({ id: { in }, ...t })` drops cross-tenant ids before the per-id loop. | `src/applicants/**` | 2.29 |
| `phase230-audit-log-pilot` | Audit-log emissions delegated to the shared `TenantAuditLogService` (replaces per-phase `*-audit-log` tags in piloted modules). | `src/finance/**`, `src/documents/**`, `src/workflow/**`, `src/applicants/**`, `src/saas/audit/**` | 2.30 |
| `phase231-storage-guard` | Applicants `uploadPhoto` parent tenant gate runs BEFORE `storage.uploadFile`. No bytes for cross-tenant ids in pilot mode. | `src/applicants/**` | 2.31 |
| `phase231-public-submit-attribution` | Applicants `publicSubmit` tenant attribution: ALS first, agency fallback, reject otherwise (pilot mode). NULL-tenant rows preserved in legacy. | `src/applicants/**` | 2.31 |
| `phase231-pilot-scope` | Reserved for follow-up applicants pilot sites that engage during Phase 2.31 review. | `src/applicants/**` | 2.31 |
| `phase232-conversion-gate` | Applicants `convertToEmployee` cross-module re-link calls (`Document.updateMany`, `FinancialRecord.updateMany`, `ApplicantFinancialProfile.updateMany`) narrowed on `tenantId` in pilot mode. Foreign-tenant rows that incidentally point at the applicant id stay untouched. | `src/applicants/**` | 2.32 |
| `phase233-pilot-scope` | Employees read sites narrowed via `tenantWhere()` spread (`findAll`, `findOne`, `exportExcel` by-id branch, parent gates inside `listAgencyAccess`). | `src/employees/**` | 2.33 |
| `phase233-pilot-scope-precheck` | Employees child reads gated by tenant-scoped `findOne` parent (Document / EmployeeStage / ComplianceAlert / EmployeeAgencyAccess by `employeeId` / ApplicantFinancialProfile by `employeeId`). | `src/employees/**` | 2.33 |
| `phase233-global` | Employees intentionally global lookups: `Employee.email` duplicate-check, `StageTemplate` reads inside `create`, `generateEmployeeNumber` raw SQL serial. | `src/employees/**` | 2.33 |
| `phase233-excluded-mutation` | Employees write/lifecycle/agency-access mutation sites kept on `legacyPrisma` until Phase 2.34+. | `src/employees/**` | 2.33 |
| `phase233-excluded-storage` | Employees `uploadPhoto` storage-write sites — deferred to Phase 2.34 storage-guard. | `src/employees/**` | 2.33 |
| `phase234-pilot-scope` | Employees write sites narrowed in Phase 2.34 — `create` spreads `scope.tenantData()`; `findEmployeeOrFail` parent gate. | `src/employees/**` | 2.34 |
| `phase234-pilot-scope-precheck` | Employees by-id mutation sites gated by the prior tenant-scoped `findOne` (Phase 2.33). | `src/employees/**` | 2.34 |
| `phase234-storage-guard` | Employees `uploadPhoto` parent tenant gate runs BEFORE `storage.uploadFile`. | `src/employees/**` | 2.34 |
| `phase234-agency-gate` | Employees agency-access write sites narrowed by dual gates (employee + agency tenant). | `src/employees/**` | 2.34 |
| `phase235-pilot-scope` | Agencies read sites narrowed via `tenantWhereOrSystem()` (active tenant OR `isSystem: true`). | `src/agencies/**` | 2.35 |
| `phase235-pilot-scope-precheck` | Agencies child reads gated by tenant-scoped `findOne` parent (User / Employee / EmployeeAgencyAccess by `agencyId` / AgencyPermissionOverride by `agencyId`). | `src/agencies/**` | 2.35 |
| `phase235-global` | Agencies intentionally global lookups: `listPublic` (apply-form public dropdown). | `src/agencies/**` | 2.35 |
| `phase235-excluded-mutation` | Agencies mutation / permission-override / manager-set sites kept on `legacyPrisma` until Phase 2.36+. | `src/agencies/**` | 2.35 |
| `phase235-excluded-storage` | Agencies `uploadLogo` storage-write sites — deferred to Phase 2.36 storage-guard. | `src/agencies/**` | 2.35 |
| `phase236-pilot-scope` | Agencies write sites narrowed in Phase 2.36 — `create` spreads `scope.tenantData()`. | `src/agencies/**` | 2.36 |
| `phase236-pilot-scope-precheck` | Agencies by-id mutation sites gated by the prior tenant-scoped `findOne` (Phase 2.35). | `src/agencies/**` | 2.36 |
| `phase236-storage-guard` | Agencies `uploadLogo` parent tenant gate runs BEFORE `storage.uploadFile`. | `src/agencies/**` | 2.36 |
| `phase236-permission-gate` | Agencies permission-override write sites narrowed by parent agency tenant gate. | `src/agencies/**` | 2.36 |
| `phase236-manager-gate` | Agencies `setManager` parent agency tenant gate runs BEFORE the user lookup. | `src/agencies/**` | 2.36 |
| `phase236-audit-log-pilot` | Agencies audit emissions delegated to the shared `TenantAuditLogService`. | `src/agencies/**` | 2.36 |
| `phase238-audit-log-pilot` | Compliance `updateAlert` audit emission delegated to `TenantAuditLogService` (replaces `phase28-audit-log`). | `src/compliance/**` | 2.38 |
| `phase238-scheduler-routing` | Compliance `generateAlertsForTenant` scheduler-safe entrypoint with explicit per-tenant ALS frame attach. | `src/compliance/**` | 2.38 |
| `phase239-tenant-job-dispatch` | Compliance `dispatchComplianceAlertGenerationForTenants` tenant fan-out helper. Refuses by default; gated by `TENANT_JOB_FANOUT_ENABLED` AND active compliance pilot. Calls `generateAlertsForTenant` per tenant. | `src/compliance/**` | 2.39 |
| `phase240-compliance-real-scheduler` | Compliance scheduler entry-point (`ComplianceScheduler.runScheduledComplianceAlertGeneration`). Disabled by default; calls only the Phase 2.39 dispatch helper. | `src/compliance/**` | 2.40 |
| `phase241-compliance-cron-framework` | Compliance `@Cron` entry-point (`ComplianceCron.tick`). Single decorated handler that delegates to `ComplianceScheduler.runScheduledComplianceAlertGeneration` and nothing else. | `src/compliance/**` | 2.41 |
| `phase242-notifications-pilot-scope` | Reserved for new notifications pilot sites that engage during Phase 2.42 review. Phase 2.10's `phase210-pilot-scope` covers the existing sites. | `src/notifications/**` | 2.42 |
| `phase242-notifications-fanout-deferred` | Reserved for any notifications fan-out site whose tenant attribution is explicitly deferred to a later product phase. | `src/notifications/**` | 2.42 |
| `phase242-notifications-audit-log` | Reserved for any future notifications mutation that introduces audit-log emission (none in scope today). | `src/notifications/**` | 2.42 |
| `phase243-compliance-notification-coupling` | Compliance `maybeNotifyOnAlertGeneration` helper invoked from `generateAlertsForTenant` after a per-tenant scan; default-off; gated by `COMPLIANCE_NOTIFY_ON_ALERT` + existing fan-out gates. | `src/compliance/**` | 2.43 |
| `phase243-compliance-notification-fanout` | Compliance call to `NotificationsService.notifyUsersByRoles` from inside the per-tenant ALS frame. | `src/compliance/**` | 2.43 |
| `phase243-compliance-notification-deferred-provider` | Reserved for any future external provider (email/SMS) coupling on compliance events. | `src/compliance/**` | 2.43 |
| `phase244-compliance-scheduler-health` | Compliance scheduler `summarizeHealth(result)` normalizer + structured `compliance.scheduler.health` log fingerprint emitted once per tick. Counts only; no PII. | `src/compliance/**` | 2.44 |
| `phase245-notifications-dedup` | Per-recipient in-app notification dedup helper (`createInAppWithDedup`) and the compliance coupling site that supplies a stable `relatedEntityId`. Identity: `(tenantId, userId, type, relatedEntity, relatedEntityId, createdAt >= now - window)`. Default off. | `src/notifications/**`, `src/compliance/**` | 2.45 |
| `phase246-notifications-internal-scan-dedup` | Internal scheduled notification scans (`checkExpiringCompliance`, `checkServiceDue`, `checkOverdue`, `checkScheduledMaintenance`) route `notification.create` through the Phase 2.45 `createInAppWithDedup` helper. Identity reuses the existing `(relatedEntity, relatedEntityId, type)` triple — no new identity strings. Default off. | `src/notifications/**` | 2.46 |
| `phase247-attendance-pilot-scope` | Attendance reads-first pilot. `listEmployeesWithStats` and `getEmployeeAttendance` add `scope().tenantWhere()` to the `Employee` parent and `AttendanceRecord` child queries. Default off. | `src/attendance/**` | 2.47 |
| `phase247-attendance-mutation-scope` | Attendance mutation parent gate: `findEmployeeForMutationOrFail` / `findRecordForMutationOrFail` load the parent through `pilot.client()` with `tenantWhere()`. Reduces to a plain by-id lookup with the flag off. Locked-period table is intentionally global. | `src/attendance/**` | 2.47 |
| `phase247-attendance-audit-log` | `AttendanceService.auditLog` continues to write through `legacyPrisma.auditLog.create`; routing through `TenantAuditLogService` is deferred to the mutation phase. | `src/attendance/**` | 2.47 |
| `phase247-attendance-deferred-export` | `exportExcel` queries (`employee.findMany`, `attendanceRecord.findMany`) stay on `legacyPrisma` until a follow-up phase that streams + paginates. | `src/attendance/**` | 2.47 |
| `phase248-attendance-mutation-pilot` | `upsertRecord` stamps `tenantId` via `scope().tenantData()` on the create branch. With pilot off, `tenantData()` returns `{}` so create is byte-identical to pre-2.48. | `src/attendance/**` | 2.48 |
| `phase248-attendance-audit-log-pilot` | `auditLog` routes through `TenantAuditLogService.write`; tenantId stamped on audit row when `TENANT_AUDIT_LOG_PILOT_ENABLED=true` AND active ALS tenant. | `src/attendance/**` | 2.48 |
| `phase248-attendance-export-scope` | `exportExcel` applies `scope().tenantWhere()` to both the parent `Employee` lookup and the bulk `attendanceRecord.findMany`. | `src/attendance/**` | 2.48 |
| `phase248-attendance-lock-deferred` | `AttendanceLockedPeriod` (`isPeriodLocked`, `listLockedPeriods`, `lockPeriod`, `unlockPeriod`) remains intentionally global — no `tenantId` column per the schema comment. **Superseded by Phase 2.49.** | `src/attendance/**` | 2.48 |
| `phase249-attendance-lock-period-tenant-scope` | `AttendanceLockedPeriod` lock APIs (`isPeriodLocked`, `listLockedPeriods`, `lockPeriod`, `unlockPeriod`) scope by `tenantId` when pilot active; legacy mode preserves NULL-tenant lookup. | `src/attendance/**` | 2.49 |
| `phase249-attendance-lock-period-migration` | Schema migration `saas_phase249_attendance_locked_period_tenant` (nullable `tenantId`, replaced unique constraint, partial unique on NULL-tenant rows). | `src/attendance/**`, `prisma/**` | 2.49 |
| `phase249-attendance-lock-period-backfill` | Reserved for optional production backfill scripts (Strategies B/C in the lock-period tenant-scope doc). | `src/attendance/**`, `scripts/**` | 2.49 |
| `phase250-attendance-audit-backfill` | One-shot dry-run-first backfill that maps historic NULL-tenant `audit_logs(entity='AttendanceRecord')` rows to `tenantId` via `attendance_records.tenantId`. Apply double-gated (`ATTENDANCE_AUDIT_BACKFILL_APPLY=true` + SAFE_CLONE/SAFE_STAGING). | `scripts/saas/phase2/**` | 2.50 |
| `phase251-cross-module-audit-backfill` | Generalised dry-run-first backfill across six target entities (`Document`, `FinancialRecord`, `WorkPermit`, `Visa`, `ComplianceAlert`, `Notification`). Direct `target.tenantId` join — no ambiguous resolution. Apply double-gated (`CROSS_MODULE_AUDIT_BACKFILL_APPLY=true` + SAFE_CLONE/SAFE_STAGING). | `scripts/saas/phase2/**` | 2.51 |
| `phase252-audit-log-read-pilot` | `LogsService.findAll` / `getStats` and `TenantAuditLogService.listForTenant` / `countForTenant` / `getByIdForTenant` apply `tenantWhere()` when the `audit-logs` pilot is active. Default off. | `src/logs/**`, `src/saas/audit/**` | 2.52 |
| `phase252-audit-log-retention-preview` | `TenantAuditLogService.previewRetention` returns counts only — no destructive Prisma calls under any flag combination. | `src/saas/audit/**` | 2.52 |
| `phase252-audit-log-export-deferred` | Reserved for any future audit export endpoint that defers tenant scoping. Currently no audit export exists in `src/logs`. | `src/logs/**` | 2.52 |
| `phase253-audit-log-retention-enforce` | One-shot dry-run-first soft-delete enforcement for audit_logs. Triple-gated by `AUDIT_LOG_RETENTION_ENABLED=true` + `AUDIT_LOG_RETENTION_APPLY=true` + SAFE_CLONE/SAFE_STAGING. Hard-delete forbidden by source-level harness assertion. | `scripts/saas/phase2/**` | 2.53 |
| `phase254-audit-log-hard-delete` | One-shot dry-run-first hard-delete pass for already soft-deleted audit_logs rows past `AUDIT_LOG_HARD_DELETE_GRACE_DAYS`. Triple-gated by `AUDIT_LOG_HARD_DELETE_ENABLED=true` + `AUDIT_LOG_HARD_DELETE_APPLY=true` + SAFE_CLONE/SAFE_STAGING + (for scope=tenant) explicit tenant id. Phase 2.54 introduces no new runtime hard-delete site. | `scripts/saas/phase2/**` | 2.54 |
| `phase255-audit-retention-runbook` | Operator-facing rollout runbook stitching Phases 2.50–2.54 into one production sequence + the doc-level check script that asserts coverage and the soft-delete-only / grace-cutoff invariants. | `scripts/saas/phase2/**`, `docs/runbooks/**` | 2.55 |
| `phase256-audit-log-rbac-tenant-binding` | Explicit refusal contract on `LogsService` audit reads when pilot is active, audit-logs is allow-listed, and either the actor is tenant-scoped OR FULL_ACCESS without the global-read gate, but no ALS tenant frame is present. | `src/logs/**` | 2.56 |
| `phase256-audit-log-global-read-gate` | `AUDIT_LOG_GLOBAL_READ_ENABLED` flag — default off; explicit opt-in lets FULL_ACCESS roles bypass the tenant predicate. | `src/logs/**` | 2.56 |
| `phase256-audit-log-actor-scope` | `auditTenantWhereForActor(scope)` composes the tenant predicate with the global-read gate so audit reads are never tenant-leaky and never silently global. | `src/logs/**` | 2.56 |
| `phase257-audit-log-http-read` | `TenantAuditController` GET routes (`/admin/tenant-audit{,/:id,/stats}`) and `LogsService.findOneForActor`. Reuse Phase 2.56 RBAC binding inside the service. | `src/logs/**` | 2.57 |
| `phase257-audit-log-http-retention-preview` | `GET /admin/tenant-audit/retention-preview` exposes `LogsService.previewRetentionForActor`, which wraps `TenantAuditLogService.previewRetention` (count-only). | `src/logs/**` | 2.57 |
| `phase257-audit-log-http-no-destructive-routes` | Source-level invariant: `TenantAuditController` exposes only GET routes. Phase 2.53/2.54 retention apply / hard-delete remain script-only. | `src/logs/**` | 2.57 |
| `phase258-audit-log-export-csv` | `GET /admin/tenant-audit/export.csv` and `LogsService.exportCsvForActor` — RFC-4180-style CSV body, CRLF line endings, fixed safe column list. Reuses Phase 2.56 RBAC binding. | `src/logs/**` | 2.58 |
| `phase258-audit-log-export-row-cap` | `AUDIT_LOG_EXPORT_MAX_ROWS` resolution (default 50000; invalid ⇒ 50000). Response headers `X-Audit-Export-Row-Count` / `Max-Rows` / `Capped`. | `src/logs/**` | 2.58 |
| `phase258-audit-log-export-no-destructive` | Source-level invariant: the CSV export touches `prisma.auditLog.findMany` only — no destructive Prisma call sites and no imports of Phase 2.53/2.54 scripts. | `src/logs/**` | 2.58 |
| `phase259-audit-log-http-rate-limit` | `AuditLogRateLimiter` service + `enforceRateLimit(caller, res?)` invoked at the top of every `TenantAuditController` GET handler. Throws HTTP 429 BEFORE the data path runs. | `src/logs/**` | 2.59 |
| `phase259-audit-log-rate-limit-keying` | `rateLimitKey(caller)` — `tenant:<id>` for tenant-scoped + FULL_ACCESS-without-global-gate; `global:<userId>` for FULL_ACCESS under `AUDIT_LOG_GLOBAL_READ_ENABLED=true`. | `src/logs/**` | 2.59 |
| `phase259-audit-log-rate-limit-disabled-default` | Limiter activates only when both `AUDIT_LOG_HTTP_RATE_LIMIT_ENABLED=true` and `AUDIT_LOG_HTTP_RATE_LIMIT_RPM > 0`; invalid values fall back to disabled. | `src/logs/**` | 2.59 |
| `phase260-audit-log-rate-limit-envelope` | Stable JSON envelope on 429 from `TenantAuditController.enforceRateLimit` (`error: 'rate_limited'`, `retryAfterSeconds`, `limit`, `remaining=0`, `windowSeconds`). Backed by `AuditLogRateLimiter.tryConsume(key)`. | `src/logs/**` | 2.60 |
| `phase260-audit-log-retry-after-header` | `Retry-After: <seconds>` HTTP header attached to 429 responses on every protected `/admin/tenant-audit/*` route. | `src/logs/**` | 2.60 |
| `phase261-pipeline-pilot-scope` | `WorkflowService` assignment-keyed reads (`getWorkflowCandidates`, `getWorkflowBoardView`, `getWorkflowStats`) apply `scope.tenantWhere()` to `Candidate/EmployeeWorkflowAssignment.tenantId`. Workflow CONFIG remains global. | `src/pipeline/**` | 2.61 |
| `phase261-pipeline-mutation-deferred` | Pipeline mutation parent gates / tenantId stamping deferred to a follow-up phase. CRUD continues to use the legacy path via `pilot.client()` (no-op when flag off). | `src/pipeline/**` | 2.61 |
| `phase261-pipeline-audit-log` | `legacyPrisma.auditLog.create` sites in `WorkflowService` continue to flow through the pilot client; routing through `TenantAuditLogService` deferred to the mutation-pilot phase. | `src/pipeline/**` | 2.61 |
| `phase261-pipeline-export-deferred` | Reserved for any future pipeline export endpoint that defers tenant scoping. No export exists today. | `src/pipeline/**` | 2.61 |
| `phase261-pipeline-transition-deferred` | Stage transition flow (`advanceToStage`, `approveStage`, etc.) keeps legacy behaviour; tenant parent gates deferred. **Superseded by Phase 2.62.** | `src/pipeline/**` | 2.61 |
| `phase262-pipeline-mutation-pilot` | `assignCandidate` stamps `tenantId` via `scope().tenantData()`; candidate parent gate (`findCandidateForPipelineMutationOrFail`) refuses cross-tenant candidate ids BEFORE write. | `src/pipeline/**` | 2.62 |
| `phase262-pipeline-transition-pilot` | Transition methods (`advanceToStage`, `updateProgress`, `toggleProgressFlag`, `submitApproval`) gate through assignment / progress parent helpers that refuse cross-tenant ids. | `src/pipeline/**` | 2.62 |
| `phase262-pipeline-audit-log-pilot` | 14 `legacyPrisma.auditLog.create` sites now flow through a private `auditLog(...)` helper that delegates to `TenantAuditLogService.write`. With audit pilot ON + ALS tenant, rows carry `tenantId`. | `src/pipeline/**` | 2.62 |
| `phase262-pipeline-workflow-config-global` | Workflow CRUD remains global — no `tenantId` column on `Workflow`. Documented; requires future schema migration. | `src/pipeline/**` | 2.62 |
| `phase262-pipeline-stage-config-global` | WorkflowStage CRUD remains global — stage rows owned by global workflows. Documented; requires future schema migration. | `src/pipeline/**` | 2.62 |
| `tenant-safe-report-runtime` | Reports engine uses `$queryRawUnsafe` with positional parameters and a registry-validated SQL string. | `src/reports/reports.service.ts` | 2.1 |

## 3. When annotations are allowed

An annotation is **only** valid when:

1. The reason tag is in the table above.
2. The site lives in a path the policy permits for that tag (the
   "Allowed paths" column).
3. The behaviour the tag claims is actually implemented at that site
   (e.g. `phase211-pilot-scope` requires the `where` to spread
   `tenantWhereFor(...)` — the scanner does not check this directly,
   but the per-pilot isolation harness will reveal regressions).

## 4. When annotations expire

Annotations are scoped to the phase that introduced them. They
**expire** when one of the following lands:

- **`phase2X-excluded-background`** expires when the corresponding
  scheduler/job-context refactor lands. After that, those sites move
  to `phase2X-pilot-scope` (or are deleted entirely).
- **`phase2X-excluded-platform`** expires only if a Phase 3 product
  decision splits the platform op into per-tenant operations.
- **`phase2X-pilot-scope`** ALL of these expire together when
  `TENANT_PRISMA_ENFORCEMENT` flips on globally and the wrapper-level
  tenant filter replaces the service-level spread. At that point the
  service spreads can be removed; the annotations follow.

The scanner will get a `--check-expired` mode in Phase 3 that flags
annotations whose expiry phase has passed.

## 5. What must happen before strict mode

`saas:scan` is REPORT-ONLY today. Strict mode (`saas:scan --strict`)
will fail the build on any unannotated `prisma.X.<op>` site.
Prerequisites for flipping to strict:

1. Every `USAGE` line in `saas:scan` output is either annotated or
   moved into `src/saas/prisma/` / `src/prisma/`.
2. Every annotated reason matches the policy above.
3. The `saas:scan:annotations` subcommand reports zero `UNKNOWN_REASON`
   and zero `WRONG_PATH` findings.
4. CI runs `saas:scan --strict` on every PR.

Phase 2.12 adds (1) the policy validation (`saas:scan:annotations`)
in WARN-only mode, (2) the `--strict-annotations` flag that returns
non-zero on policy violations, but does NOT yet flip the global
`saas:scan` to strict.

## 6. Reviewing exceptions

If a new direct prisma call needs an annotation that isn't in the
policy above:

1. The PR MUST add the new tag to this document with:
   - tag name
   - meaning (one sentence)
   - allowed paths
   - phase number
   - expiry condition
2. Reviewer must confirm the new tag is genuinely a new category and
   not a re-shaping of an existing one (e.g. don't add
   `phase212-pilot-scope-ish`).
3. The new tag is added to `KNOWN_REASONS` in
   `backend/scripts/scan-tenant-safe.ts` in the same PR.

## 7. How to avoid annotation laundering

"Annotation laundering" = adding `@tenant-reviewed: <bogus reason>`
to suppress the scanner without doing the actual review. Mitigations:

- The scanner's annotation validator (this PR) cross-checks the tag
  against `KNOWN_REASONS` and the path allow-list. A bogus reason or
  wrong path fails the check.
- `saas:phase2-pilot-regression` runs every pilot's isolation
  harness; if a tag claims tenant-safety but the site is in fact
  unsafe, the harness fails.
- Per-phase docs (`SAAS_PHASE2_<MODULE>_AUDIT.md`) record the
  expected annotation count. A diff in the count without an audit
  update is a code-review smell.
- Code review: any PR that adds a `@tenant-reviewed` line to a file
  not previously in the pilot allow-list triggers a manual review.

## 8. Operator-facing summary

```sh
# Today (REPORT-ONLY):
npm run saas:scan
# → "Total: <N>. Allowlist: …. Phase 0: scanner is in REPORT-ONLY mode."

# Phase 2.12 addition (WARN-ONLY):
npm run saas:scan:annotations
# → reports any annotation with a reason not in the policy or in a
#   path that doesn't match. Returns 0 unless --strict is passed.

# Phase 3 plan (STRICT, post-cutover):
npm run saas:scan -- --strict
# → fails the build on any unannotated USAGE.
```

---

## Phase 2.63 — Workflow tenant scope tags

- `phase263-workflow-tenant-scope` (allowed: `src/pipeline/`)
- `phase263-workflow-schema-migration` (allowed: `src/pipeline/`, `prisma/`)
- `phase263-workflow-global-template` (allowed: `src/pipeline/`)
- `phase263-workflow-stage-scope` (allowed: `src/pipeline/`)
- `phase263-workflow-audit-log` (allowed: `src/pipeline/`)

---

## Phase 3.0 — Product migration tags

- `phase300-product-migration-readiness` (allowed: `scripts/saas/phase3/`)
- `phase300-uniqueness-audit` (allowed: `scripts/saas/phase3/`, `src/`)
- `phase300-platform-admin-foundation` (allowed: `scripts/saas/phase3/`, `src/`)

---

## Phase 3.1 — Production-shaped readiness tags

- `phase310-tenant-backfill-completeness` (allowed: `scripts/saas/phase3/`)
- `phase310-production-duplicate-scan` (allowed: `scripts/saas/phase3/`)
- `phase310-platform-admin-readiness` (allowed: `scripts/saas/phase3/`)
- `phase310-readiness-check` (allowed: `scripts/saas/phase3/`)

---

## Phase 3.2 — Duplicate cleanup tags

- `phase320-duplicate-cleanup-plan` (allowed: `scripts/saas/phase3/`)
- `phase320-duplicate-cleanup-apply` (allowed: `scripts/saas/phase3/`)
- `phase320-duplicate-cleanup-harness` (allowed: `scripts/saas/phase3/`)

---

## Phase 3.3 — Additive per-tenant unique constraint tags

- `phase330-per-tenant-unique-constraints` (allowed: `scripts/saas/phase3/`, `prisma/`)
- `phase330-additive-unique-indexes` (allowed: `scripts/saas/phase3/`, `prisma/`)
- `phase330-global-unique-retained` (allowed: `scripts/saas/phase3/`, `prisma/`)

---

## Phase 3.4 — Global Employee UNIQUE drop tags

- `phase340-drop-employee-global-uniques` (allowed: `scripts/saas/phase3/`, `prisma/`)
- `phase340-global-unique-drop` (allowed: `scripts/saas/phase3/`, `prisma/`)
- `phase340-per-tenant-unique-retained` (allowed: `scripts/saas/phase3/`, `prisma/`)

---

## Phase 3.5 — PlatformAdmin backfill tags

- `phase350-platform-admin-backfill` (allowed: `scripts/saas/phase3/`, `src/`)
- `phase350-platform-admin-audit-log` (allowed: `scripts/saas/phase3/`, `src/`)
- `phase350-agency-is-system-retirement` (allowed: `scripts/saas/phase3/`, `src/`)

---

## Phase 3.6 — PlatformAdmin dual-read guard tags

- `phase360-platform-admin-dual-read` (allowed: `scripts/saas/phase3/`, `src/`)
- `phase360-agency-is-system-inventory` (allowed: `scripts/saas/phase3/`, `src/`)
- `phase360-platform-audit-log-deferred` (allowed: `scripts/saas/phase3/`, `src/`)

---

## Phase 3.7 — JWT dual-read tags

- `phase370-platform-admin-jwt-dual-read` (allowed: `scripts/saas/phase3/`, `src/`)
- `phase370-agency-is-system-derived-field` (allowed: `scripts/saas/phase3/`, `src/`)
- `phase370-platform-audit-log-deferred` (allowed: `scripts/saas/phase3/`, `src/`)

---

## Phase 3.7B — Bake verification tags

- `phase37b-platform-admin-signal-agreement` (allowed: `scripts/saas/phase3/`, `src/`)
- `phase37b-platform-admin-jwt-bake-check` (allowed: `scripts/saas/phase3/`, `src/`)

---

## Phase 3.8 — Runtime retirement tags

- `phase380-platform-admin-runtime-retirement` (allowed: `scripts/saas/phase3/`, `src/`)
- `phase380-agency-is-system-fallback` (allowed: `scripts/saas/phase3/`, `src/`)
- `phase380-agency-is-system-inventory` (allowed: `scripts/saas/phase3/`, `src/`)

---

## Phase 3.9 — Agency.isSystem removal tags

- `phase390-drop-agency-is-system` (allowed: `scripts/saas/phase3/`, `src/`, `prisma/`)
- `phase390-platform-admin-only-authority` (allowed: `scripts/saas/phase3/`, `src/`, `prisma/`)
- `phase390-agency-is-system-removed` (allowed: `scripts/saas/phase3/`, `src/`, `prisma/`)

---

## Phase 3.10 — Cleanup + PlatformAuditLog migration tags

- `phase310-platform-admin-cleanup` (allowed: `scripts/saas/phase3/`, `src/`, `prisma/`)
- `phase310-platform-audit-log-migration` (allowed: `scripts/saas/phase3/`, `src/`, `prisma/`)
- `phase310-platform-audit-log-emission-deferred` (allowed: `scripts/saas/phase3/`, `src/`, `prisma/`)

---

## Phase 3.11 — Grant/revoke service tags

- `phase311-platform-admin-grant-revoke` (allowed: `scripts/saas/phase3/`, `src/`)
- `phase311-platform-audit-log-emission` (allowed: `scripts/saas/phase3/`, `src/`)
- `phase311-platform-admin-super-only` (allowed: `scripts/saas/phase3/`, `src/`)

---

## Phase 3.12 — Controller tags

- `phase312-platform-admin-controller` (allowed: `scripts/saas/phase3/`, `src/`)
- `phase312-platform-admin-http-gate` (allowed: `scripts/saas/phase3/`, `src/`)

---

## Phase 3.13 — Tenant-aware login tags

- `phase313-tenant-aware-login` (allowed: `scripts/saas/phase3/`, `src/`)

---

## Phase 3.14 — Frontend tenant-login tags

- `phase314-frontend-tenant-login` (allowed: `scripts/saas/phase3/`, `src/`, `../src/`)
