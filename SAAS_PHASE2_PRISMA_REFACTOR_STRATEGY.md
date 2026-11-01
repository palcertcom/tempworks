# Phase 2 — Prisma Runtime Refactor Strategy

> Goal: replace **793 direct `prisma.<model>.<op>`** call sites with `tenantPrisma.client.<model>.<op>` across 28 modules, **without changing observable behaviour** until `TENANT_PRISMA_ENFORCEMENT=true` flips per-environment.

---

## 1. Migration model

Each call site goes through one of three transitions:

```
A.  prisma.x.findMany(...)             →  tenantPrisma.client.x.findMany(...)
B.  prisma.x.findUnique({ email })    →  tenantPrisma.client.x.findFirst({ email })  // tenant injected
C.  prisma.$queryRaw`...`             →  source registry (reports) OR tenantPrisma.withTenant(tx => tx.$queryRaw`...`)
```

Type **A** is mechanical (~85% of sites). Type **B** appears wherever a previously global unique key (e.g. `Employee.email`) becomes tenant-scoped (`@@unique([tenantId, email])`). Type **C** is rare (17 sites) and routes through the reports refactor (ADR-007).

## 2. Module-by-module order

Per `SAAS_PHASE2_RUNTIME_REFACTOR_INVENTORY.md` §9:

| Wave | Modules | Effort |
|---|---|---|
| 2.0 (this PR) | scaffolding only | ½ week |
| 2.1 | `reports` (P0, raw SQL) | 2 weeks |
| 2.2 | `notifications` (P0, scheduler) | 1 week |
| 2.3 | entity-keyed: `documents`, `finance`, `compliance` | 1 week |
| 2.4 | domain: `applicants`, `employees`, `pipeline`, `vehicles`, `workflow` | 2 weeks |
| 2.5 | utility: `recycle-bin`, `users`, `roles`, `agencies`, `attendance`, etc. | 1 week |
| 2.6 | RLS audit-mode + `TENANT_PRISMA_ENFORCEMENT=true` per env | ½ week + 7-day observation |
| 2.7 | RLS `FORCE` per-table | ½ week + per-table observation |

## 3. Codemod strategy

**No automated codemod is shipped.** The replacement is module-by-module, by code-owner, with every PR touching one bounded context.

Why: an automated `prisma. → tenantPrisma.client.` rewrite would be:

- correct in 95% of cases,
- subtly wrong in the remaining 5% (interactive transactions, places that rely on `findUnique(email)`, raw SQL),
- and visually impossible to review per call site.

Instead each module PR includes:

1. The mechanical rewrite (find-and-replace within a single module folder).
2. Any required `findUnique → findFirst` adjustments where the unique constraint is becoming tenant-scoped.
3. The new `applyAgencyScope(where, 'agencyId', ctx)` helper invocation on every list/read endpoint that targets an agency-scoped model.
4. A two-tenant isolation test for that module.
5. A read-equivalence test (§5).

## 4. Scanner strictness phases

The advisory scanner (`saas:scan` + `saas:scan:raw-sql`) tightens over phases:

| Phase | `saas:scan` | `saas:scan:raw-sql` | CI gate |
|-------|-------------|---------------------|---------|
| 0 (current) | report-only | report-only | none |
| 2.0 (this PR) | report-only | report-only | none |
| 2.1 | strict for `backend/src/reports/` | strict for `backend/src/reports/` | only `reports` module fails on regression |
| 2.4 (after entity-keyed + domain modules) | strict for `documents`, `applicants`, `employees`, `pipeline`, `notifications`, `reports` | strict on the same allow-list | gates per-module |
| 2.6 | strict everywhere | strict everywhere | full repo gate |
| Phase 3 | the legacy `prisma` import is forbidden outside `infra/prisma/*` and explicitly reviewed sites | same | hard gate |

## 5. Read-equivalence testing (the safety net)

For every module migration, a "before / after" test against the SAFE_CLONE staging fixture:

```
1. Capture: list 50 representative queries (URL + params) per module.
2. Run them on the legacy code path; serialise the response (sorted JSON).
3. Apply the migration.
4. Re-run the same queries; serialise again.
5. Diff. The only acceptable deltas are:
     - row order (if the test query had no ORDER BY) — re-run with explicit ORDER BY
     - new tenant-scoped indexes ⇒ different default sort — accept after review
   Anything else is a regression and the migration PR is rejected.
```

The harness lives at `backend/src/saas/__validation__/read-equivalence/` (added per-module in Phase 2.1+).

## 6. `// @tenant-reviewed` policy

A single comment suppresses scanner findings on a line:

```ts
// @tenant-reviewed: <reason>
const u = await this.prisma.user.findUnique({ where: { email } });
```

Mandatory rules:

- The reason must reference one of: `R-1..R-12` (in `docs/saas/phase0/TENANT_ISOLATION_RULES.md`), an ADR (`ADR-NNN`), or an explicit Phase 2 ticket id.
- "TODO" is **never** a reason. Use a tracked ticket instead.
- Code-owner approval is required on the PR; the scanner reports comments without a `<reason>` separately.
- The list of reviewed lines is enumerated at boot (Phase 2.5) and a metric is exported (`saas.reviewed_prisma_sites`).

Categories where `@tenant-reviewed` is the **right answer**:

- `auth/`, `users/`, `identity/` — login is global. `findUnique({ email })` on `User` is the legitimate global identity lookup.
- `platform-admin/` — by design.
- migration scripts under `prisma/run-*.ts` — they execute against the live DB outside the wrapped client.

Anywhere else, `@tenant-reviewed` is a smell — prefer the wrapper.

## 7. Avoiding accidental behaviour changes

### 7.1 Pass-through default

`TenantPrismaService.client` is a **pass-through** to the underlying Prisma client when `TENANT_PRISMA_ENFORCEMENT=false`. Phase 2.0–2.5 ship with the flag OFF. The mechanical rewrite is therefore behaviourally identical to the legacy code; only the import path changes.

### 7.2 `findUnique` → `findFirst` rule

Wherever the unique key includes `tenantId` after Phase 2 backfill, every `findUnique({ where: { email } })` becomes `findFirst({ where: { email } })` (the wrapper auto-injects `tenantId`). The migration PR includes a one-line ESLint rule that flags `findUnique({ email | code | slug })` for tenant-scoped models and refers to this guidance.

### 7.3 Test gate

A migration PR cannot merge until:

- `npm run saas:validate` passes (28 → growing).
- `npm run saas:schema-lint` passes.
- The module's read-equivalence test passes (above).
- The module's two-tenant isolation test passes.
- The module's raw-SQL count drops to 0 OR every site has `@tenant-reviewed`.

## 8. Rollback strategy

Every migration PR is a single squash-merge commit. To roll back:

1. Revert the commit.
2. Run `npm run saas:validate` to confirm the SaaS suites still pass.
3. The flag remains OFF, so the legacy code path is what runs in production.

Because the migration is mechanically equivalent (under flag OFF), the cost of revert is the cost of one deploy, not a data migration.

## 9. Tracking & telemetry

Per-module migration PR description includes:

- Pre-migration count from `saas:phase2-runtime-inventory` for that module.
- Post-migration count (target: 0 unreviewed direct prisma sites).
- Read-equivalence test result (rows compared, deltas explained).
- Two-tenant isolation test passing screenshot/log.

Rolling progress dashboard published to `backend/reports/saas/phase2/migration-progress.json` (regenerated on each merge).

## 10. Hard rules

## 11. Phase 2.6 pilot landed

The first pilot module (`src/roles`, GLOBAL) shipped in the Phase 2.6 PR.
Key artefacts:

- `src/saas/prisma/pilot-prisma.accessor.ts` — per-call routing helper.
- `TENANT_PRISMA_PILOT_ENABLED` flag (default false).
- `RolesService` rewired to use the accessor (legacy semantics preserved).
- `saas:phase2-tenantprisma-pilot-equivalence` (13/13 PASS).
- `saas:phase2-tenantprisma-pilot-isolation` (9/9 PASS).
- `SAAS_PHASE2_TENANTPRISMA_PILOT_SELECTION.md`,
  `SAAS_PHASE2_TENANTPRISMA_REFACTOR_PATTERN.md`,
  `SAAS_PHASE2_TENANTPRISMA_PILOT_RESULTS.md`.

## 11.1 Phase 2.7 pilot landed

The first TENANT-SCOPED pilot module (`src/employee-work-history`)
shipped in the Phase 2.7 PR. Key artefacts:

- `src/saas/prisma/tenant-pilot-scope.ts` — `getPilotScope()` helper
  exposing spreadable `tenantWhere()` / `tenantData()`.
- `EmployeeWorkHistoryService` rewired with `private get prisma() { return pilot.client(); }`
  and `scope.tenantWhere() / .tenantData()` spreads at every call site.
- `phase27-ewh-extension.sql` fixture: seeds two-tenant collisions plus
  one NULL-tenant legacy row.
- `saas:phase2-ewh-equivalence` (12/12 PASS) — legacy vs pilot for
  list / event-types / create / update / remove.
- `saas:phase2-ewh-isolation` (8/8 PASS) — cross-tenant 404, write-
  refusal, concurrent ALS frame separation, pilot-OFF legacy path.
- `SAAS_PHASE2_EMPLOYEE_WORK_HISTORY_AUDIT.md`,
  `SAAS_PHASE2_EMPLOYEE_WORK_HISTORY_PILOT_RESULTS.md`.

The next recommended pilot is `src/compliance` (read-only views of
`compliance_alerts`).

## 11.2 Phase 2.8 pilot landed

The second TENANT-SCOPED pilot module (`src/compliance`) shipped in
the Phase 2.8 PR. Key artefacts:

- `getPilotScope(pilot, moduleName)` extended with module allow-list
  via `TENANT_PRISMA_PILOT_MODULES`.
- `ComplianceService` rewired with the same `private get prisma()` +
  `private scope()` pattern as EWH; 23 retained call sites annotated.
- `phase28-compliance-extension.sql` fixture: adds Postgres enums
  (AlertStatus, AlertSeverity, EntityType, DocumentStatus,
  WorkPermitStatus, VisaStatus) + missing columns on
  compliance_alerts/documents/document_types/work_permits/visas/employees,
  then seeds two-tenant compliance alerts plus one NULL-tenant legacy.
- `saas:phase2-compliance-equivalence` (12/12 PASS).
- `saas:phase2-compliance-isolation` (7/7 PASS).
- Phase 2.7 EWH harness still 12/12 + 8/8 PASS (no regression).
- `SAAS_PHASE2_COMPLIANCE_AUDIT.md`,
  `SAAS_PHASE2_COMPLIANCE_PILOT_RESULTS.md`.

The next recommended pilot is `src/job-ads` — single-table CRUD,
low mutation rate, no file/storage interactions.

## 11.3 Phase 2.9 pilot landed

The third TENANT-SCOPED pilot module (`src/job-ads`) shipped in the
Phase 2.9 PR. First pilot to ship a schema migration alongside the
service refactor. Key artefacts:

- `prisma/migrations/saas_phase29_jobads_tenantid/migration.sql` —
  additive nullable `tenantId` + two indexes; reverse migration
  provided.
- `JobAdsService` rewired (10 call sites) with the same pattern as
  Phase 2.7/2.8.
- `phase29-jobads-extension.sql` fixture: materialises the columns
  the staging fixture lacks + seeds two-tenant + one NULL-tenant
  ads.
- `saas:phase2-job-ads-equivalence` (13/13 PASS) including public
  listing equivalence.
- `saas:phase2-job-ads-isolation` (9/9 PASS) including same-slug-in-
  two-tenants behaviour and public-listing cross-tenant visibility.
- `SAAS_PHASE2_JOB_ADS_AUDIT.md`,
  `SAAS_PHASE2_JOB_ADS_SLUG_SAFETY.md`,
  `SAAS_PHASE2_JOB_ADS_PILOT_RESULTS.md`.

Phase 2.6/2.7/2.8 harnesses still green (regression-clean).

The next recommended pilot is `src/notifications` (read-mostly views
of notification rules and recent notifications).

## 11.4 Phase 2.10 pilot landed (partial scope)

The fourth TENANT-SCOPED pilot module (`src/notifications`, read paths
only) shipped in the Phase 2.10 PR. First pilot to deliberately split
a service into "in scope" and "explicitly excluded" — proving the
pattern handles partial refactors. Key artefacts:

- `NotificationsService` rewired (7 read sites under pilot scope; 19
  background sites annotated `phase210-excluded-background` and
  routed via `legacyPrisma`; 2 preferences sites `phase210-global`).
- `phase210-notifications-extension.sql` fixture extension.
- `saas:phase2-notifications-equivalence` (11/11 PASS).
- `saas:phase2-notifications-isolation` (8/8 PASS) including a
  source-level meta-assertion that the scheduler `check*` methods
  remain on `legacyPrisma`.
- `SAAS_PHASE2_NOTIFICATIONS_AUDIT.md`,
  `SAAS_PHASE2_NOTIFICATIONS_SCOPE_SPLIT.md`,
  `SAAS_PHASE2_NOTIFICATIONS_PILOT_RESULTS.md`.

Phase 2.6/2.7/2.8/2.9 harnesses still green (regression-clean).

The Phase 2.11+ scheduler/job-context refactor is documented in
`SAAS_PHASE2_NOTIFICATIONS_SCOPE_SPLIT.md`. The next pilot module is
`src/recycle-bin` (small, read-mostly, no scheduler).

## 11.5 Phase 2.11 pilot landed (multi-service, multi-entity)

The fifth TENANT-SCOPED pilot module (`src/recycle-bin`) shipped in the
Phase 2.11 PR. First pilot to span four services and 16 entity types
in a single module — proves the pattern scales beyond single-table
services. Key artefacts:

- `tenant-scope-map.ts` — module-local registry of tenant-scoped vs.
  global entity types (10 vs. 6).
- `RecycleBinService` rewired (107 sites) with `tenantWhereFor()` per
  entity-type spread.
- `RestoreService` (45 sites) + `HardDeleteService` (37 sites) gated
  by a single `assertTenantOwnership(entityType, id)` pre-check.
- `DatabaseCleanupService` (52 sites) annotated
  `phase211-excluded-platform` — System Admin global wipe stays
  platform-wide.
- `saas:phase2-recycle-bin-equivalence` (11/11 PASS).
- `saas:phase2-recycle-bin-isolation` (7/7 PASS).
- `SAAS_PHASE2_RECYCLE_BIN_AUDIT.md`,
  `SAAS_PHASE2_RECYCLE_BIN_SCOPE_MAP.md`,
  `SAAS_PHASE2_RECYCLE_BIN_PILOT_RESULTS.md`.

Phase 2.6/2.7/2.8/2.9/2.10 harnesses still green. The next phase will
either tackle the Phase 2.10-flagged scheduler/job-context work or
split `src/finance` reads-first.

## 11.6 Phase 2.12 consolidation landed

Six pilots prompted enough copy-paste that Phase 2.12 consolidates the
shared scaffolding before larger modules begin:

- **Harness library** — `backend/scripts/saas/phase2/lib/harness.ts`
  exports `getDatabaseUrl`, `abortUnlessStaging`, `withFlags`,
  `discoverPilotTenants`, `discoverUserForTenant`,
  `discoverEmployeeForTenant`, `writeReport`. Two existing harnesses
  (`tenantprisma-pilot-isolation`, `recycle-bin-equivalence`) were
  refactored to use the helpers as proof.
- **Annotation policy** — `SAAS_PHASE2_SCANNER_ANNOTATION_POLICY.md`
  enumerates every `@tenant-reviewed:` reason tag with allowed paths
  and expiry conditions. Adding a new tag requires updating both the
  policy doc and `KNOWN_REASONS` in the scanner.
- **Annotation scanner** — `npm run saas:scan:annotations` validates
  each annotation against the policy. Reports `UNKNOWN_REASON` /
  `WRONG_PATH` findings; WARN-only by default; `--strict-annotations`
  fails the build.
- **Pilot regression** — `npm run saas:phase2-pilot-regression` runs
  all 12 existing pilot harnesses sequentially. Today: 12/12 PASS.
- **Pattern audit + next-module template** —
  `SAAS_PHASE2_TENANTPRISMA_PATTERN_AUDIT.md` and
  `SAAS_PHASE2_NEXT_MODULE_TEMPLATE.md` codify the standard so the
  next pilot lands in a single PR with a predictable shape.

No business logic changed. No flags flipped. No new module under
pilot. Validation suite still green:

- saas:scan unchanged at 576.
- saas:scan:annotations: 0 findings.
- saas:phase2-pilot-regression: 12/12 PASS.

The next phase will pick up the Phase 2.10-flagged scheduler/
job-context work, or — if a no-scheduler pilot is preferred —
`src/finance` reads-first.

## 11.7 Phase 2.13 — job-context framework landed

The cron / scheduler blocker called out in Phase 2.10 + 2.12 is now
addressed at the infrastructure layer:

- New module `backend/src/saas/jobs/`:
  - `tenant-job.payload.ts` — `TenantJobPayload<T>` envelope,
    `assertTenantJobPayload`, `buildTenantJobPayload`,
    `buildRetryPayload`, `makeIdempotencyKey`.
  - `tenant-job-context.ts` — `runForTenant`, `runForTenantBatch`,
    `currentJobTenantId`, gated by `TENANT_AWARE_JOBS_ENABLED` +
    env classifier.
  - `tenant-job-fanout-planner.ts` — `TenantJobFanoutPlanner.plan(...)`
    returns an `ExecutionPlan` with `dryRun`, `maxTenants`, system /
    inactive / duplicate filters.
- Two new flags: `TENANT_AWARE_JOBS_ENABLED`,
  `TENANT_JOB_FANOUT_ENABLED` — both default `false`.
- New harness `saas:phase2-job-context-harness` (11/11 PASS):
  ALS attachment, concurrent-frame isolation, fanout limits, env
  refusal, retry preservation, idempotency-key stability.
- New docs:
  - `SAAS_PHASE2_JOB_CONTEXT_ARCHITECTURE.md`
  - `SAAS_PHASE2_NOTIFICATIONS_SCHEDULER_ADAPTER_PLAN.md` (Phase 2.14)
  - `SAAS_PHASE2_JOB_CONTEXT_OBSERVABILITY.md`

NO existing scheduler is wired to this yet. Notifications
scheduler / `notify*` writers / cron orchestrators continue to use
their pre-pilot legacy code paths.

The next phase is **Phase 2.14**: notifications scheduler adapter
following `SAAS_PHASE2_NOTIFICATIONS_SCHEDULER_ADAPTER_PLAN.md`.
Alternative path: `src/finance` reads-first split (no scheduler).

## 11.8 Phase 2.14 / 2.14.1 / 2.15 — notifications background fully narrowed

The notifications module's background paths are now tenant-narrowed
end-to-end:

- 2.14: orchestrator + ALS adapter + fanout-writer guards.
- 2.14.1: per-method narrowing of the four `check*` methods +
  tenant-aware dedupe key.
- 2.15: fanout writers (`notifyUploaderAndRoles`,
  `notifyUsersByRoles`) narrow their User scans + persist `tenantId`
  on creates + validate uploader belongs to the active tenant.

**Zero `phase210-excluded-background` annotations remain in
`src/notifications`.** All 28 scheduler-harness cases pass; all 10
isolation cases pass; all 12 pilot-regression cases pass; the
job-context-harness still passes 11/11.

The next phase is **Phase 2.16** (TBD): either `src/finance`
reads-first or Phase 3 prep (`TenantPrismaService.client` `$extends`
implementation).

## 11.1 Phase 2.16 — Finance reads-first pilot (shipped)

`src/finance` reads-first split shipped: 9 read sites narrowed via
`getPilotScope(this.pilot, 'finance').tenantWhere()`; `findOne` /
`getHistory` migrated from `findUnique` to `findFirst` to admit the
tenant predicate; mutation paths kept on `legacyPrisma` and tagged
`phase216-excluded-mutation`. See
`SAAS_PHASE2_FINANCE_AUDIT.md`,
`SAAS_PHASE2_FINANCE_SCOPE_SPLIT.md`, and
`SAAS_PHASE2_FINANCE_PILOT_RESULTS.md`.

## 11.2 Phase 2.17 — Finance mutation pilot (shipped)

`src/finance` mutation paths brought into the pilot:

- `create` writes `tenantId` via `scope.tenantData()` in pilot
  mode (`phase217-pilot-scope`).
- `update`, `remove`, `updateStatus`, `addDeduction`,
  `addAttachment`, `removeAttachment` rely on the tenant-scoped
  `findOne` pre-check (`phase217-pilot-scope-precheck`).
- `removeDeduction` adds a NEW parent tenant pre-check
  (`phase217-pilot-scope`) to close a pre-existing cross-tenant
  gap.
- `auditLog.create` and `checkAndNotifyHighBalance` deferred
  (`LEGACY_ONLY` / `DEFERRED_HIGH_RISK`).

New harnesses: `finance-mutation-equivalence` (8 cases),
`finance-mutation-isolation` (8 cases). Scanner policy adds
`phase217-pilot-scope` and `phase217-pilot-scope-precheck`. See
`SAAS_PHASE2_FINANCE_MUTATION_AUDIT.md` and
`SAAS_PHASE2_FINANCE_MUTATION_SCOPE_DECISION.md`.

The next phase is **Phase 2.18** (TBD): finance helper enrichment
narrowing, cross-entity-reassignment guard on `update`, or the
audit-log tenancy phase.

## 11.3 Phase 2.17.1 — Real DB execution + helper guard close (shipped)

`src/finance` harnesses ran against a real SAFE_CLONE for the
first time. Found and closed a real cross-tenant create
vulnerability in `resolvePersonIdentity` (helper looked up
entities by id without tenant predicate). Three helpers narrowed:
`attachEntityNames`, `resolvePersonIdentity`,
`resolveEntityNameForNotif`. New tag: `phase2171-helper-narrowed`.
Defensive scrub added to `update`. See
`SAAS_PHASE2171_*` docs.

## 11.4 Phase 2.18 — APPLICANT helper coverage (shipped)

Added APPLICANT-typed real-DB harness coverage (cases 11+12+13).
No service code change. See
`SAAS_PHASE218_FINANCE_APPLICANT_HELPER_COVERAGE.md`.

## 11.5 Phase 2.19 — AGENCY helper coverage (shipped)

Added AGENCY-typed real-DB harness coverage (cases 14+15+16).
Per-entity coverage matrix complete. See
`SAAS_PHASE219_FINANCE_AGENCY_HELPER_COVERAGE.md`.

## 11.6 Phase 2.20 — Documents reads-first pilot (shipped)

`src/documents` reads-first split shipped:

- 9 read sites narrowed via `getPilotScope(this.pilot,
  'documents').tenantWhere()`.
- `findOne` and `readDocumentBytes` migrated from `findUnique` to
  `findFirst` to admit the tenant predicate.
- 6 `DocumentType` / `DocumentTypePermission` catalog sites
  annotated `phase220-global` (no `tenantId` column; per-tenant
  catalog deferred to Phase 3).
- All mutation, upload, download, audit, and helper sites kept on
  `legacyPrisma` with explicit exclusion tags.

New harnesses (19/19 cases PASS on real DB):
`saas:phase2-documents-equivalence` (10), `…-isolation` (9 incl.
source-level meta-assertion + `readDocumentBytes` cross-tenant
gate verification).

The pattern from finance carries over with no surprises. The next
phase is **Phase 2.21** (documents mutation pilot — most complex
write path encountered so far due to upload + transactional
insert + storage side effects) OR a new module pilot
(`vehicles`, `workflow`, `applicants`).

## 11.7 Phase 2.21 — Documents mutation pilot (shipped)

`src/documents` mutation paths brought into the pilot:

- `create` adds a STORAGE GUARD
  (`assertEntityOwnedByActiveTenant`) BEFORE `storage.uploadFile`
  + spreads `scope.tenantData()` into the new row. This closes a
  cross-tenant orphan-file attack vector identified in the
  storage side-effect review.
- `publicCreate` adds the same guard (active only with ALS) +
  `tenantData()` spread.
- `update` / `verify` / `remove` rely on the Phase 2.20
  tenant-scoped `findOne` pre-check.
- `renew` same gate + `tenantData()` on the new renewal row.
- `complianceAlert.create` writes `tenantId` (column denormed in
  Phase 2.3).
- `checkAndAutoCompleteStage` (cross-module workflow),
  `upsertDocTypePermission` (catalog),
  `createBulkDownloadArchive` (download), `auditLog.create`
  (global) remain deferred.

New tags: `phase221-pilot-scope`, `phase221-pilot-scope-precheck`,
`phase221-storage-guard`. New harnesses
(`documents-mutation-equivalence`, `documents-mutation-isolation`).
Real-DB results: 38/38 documents cases PASS; 79/79 finance +
documents combined. See
`SAAS_PHASE2_DOCUMENTS_MUTATION_AUDIT.md`,
`SAAS_PHASE2_DOCUMENTS_MUTATION_SCOPE_DECISION.md`,
`SAAS_PHASE2_DOCUMENTS_STORAGE_SIDE_EFFECT_REVIEW.md`.

The next phase is **Phase 2.22** (documents download pilot —
`createBulkDownloadArchive` + storage authz) OR a new module
pilot (`vehicles`, `workflow`, `applicants`).

## 11.8 Phase 2.22 — Documents download pilot (shipped)

Closes the documents-module pilot. `createBulkDownloadArchive`
no longer leaks tenant-B file bytes when a tenant-A caller
includes B's ids in the input list. New tag:
`phase222-download-guard` on `readDocumentBytes` (re-tagged from
`phase220-pilot-scope` for taxonomy clarity) and on
`createBulkDownloadArchive` (switched from `legacyPrisma` to
`this.prisma` with `...t` spread; cross-tenant ids silently
filtered).

New harnesses (real-DB SAFE_CLONE):
- documents-download-equivalence: 6/6 PASS
- documents-download-isolation: 8/8 PASS

Combined documents totals: **52/52 cases PASS** across 6
harnesses. Finance + documents combined: **93/93** on real
Postgres 16. Production behaviour unchanged.

The documents module is now fully proven on real DB across
reads, writes (with storage guard), and downloads (with
download guard). The next phase is a **new module pilot**
(`vehicles`, `workflow`, `applicants`) or the cross-module
audit-log tenancy phase. See `SAAS_PHASE2_DOCUMENTS_DOWNLOAD_AUDIT.md`
and `SAAS_PHASE2_DOCUMENTS_DOWNLOAD_SIDE_EFFECT_REVIEW.md`.

## 11.9 Phase 2.23 — Vehicles reads-first pilot (shipped)

`src/vehicles` joins the pilot. Reads only; mutations / driver
assignments / maintenance / vehicle documents / storage deferred.

- 24 read sites narrowed via
  `getPilotScope(this.pilot, 'vehicles').tenantWhere()`. Tag
  `phase223-pilot-scope`.
- `findVehicleOrFail` (private mutation pre-check) is also
  tenant-scoped — every mutation method that uses it now
  inherits an INCLUDED_WITH_GUARD posture for Phase 2.24.
- `getMaintenanceRecord` migrated `findUnique`→`findFirst` to
  admit the tenant predicate.
- `getDriverHistory` is parent-gated (`VehicleDriverAssignment`
  has no `tenantId` column today).
- `Workshop` and `MaintenanceType` tagged `phase223-global`
  (tenant-less catalogs; per-tenant catalog deferred to Phase 3).
- 22 mutation sites + 5 storage sites stay on `legacyPrisma` with
  `phase223-excluded-mutation` / `phase223-excluded-storage`.
- `registrationNumber` remains globally `@unique` (per-tenant
  uniqueness is a Phase 3 schema change).

Real-DB run: vehicles-equivalence 11/11, vehicles-isolation
10/10 = **21/21 cases PASS**. Combined with finance + documents:
**114/114 on real Postgres 16**. See
`SAAS_PHASE2_VEHICLES_AUDIT.md`,
`SAAS_PHASE2_VEHICLES_SCOPE_SPLIT.md`,
`SAAS_PHASE2_VEHICLES_PILOT_RESULTS.md`.

The next phase is **Phase 2.24** (vehicles mutation pilot) OR a
new module pilot (`workflow`, `applicants`).

## 11.10 Phase 2.24 — Vehicles mutation pilot (shipped)

Closes the vehicles module pilot. New tags:
- `phase224-pilot-scope` (createVehicle tenantData spread,
  assignDriver employee probe, createMaintenanceRecord
  tenantData spread, update/delete maintenance pre-checks).
- `phase224-pilot-scope-precheck` (by-id mutations gated by
  prior tenant-scoped findVehicleOrFail or maintenance-record
  pre-check).

Real bug closed: `updateMaintenanceRecord` and
`deleteMaintenanceRecord` had a by-id `findUnique` pre-check
that allowed cross-tenant mutation in pilot mode. Phase 2.24
switches the pre-check to `findFirst({ id, ...t })`.

`registrationNumber` remains globally `@unique`; per-tenant
uniqueness is a Phase 3 schema change. See
`SAAS_PHASE2_VEHICLES_REGISTRATION_NUMBER_SAFETY.md`.

New harnesses (real-DB SAFE_CLONE):
- vehicles-mutation-equivalence: 12/12 PASS
- vehicles-mutation-isolation: 14/14 PASS

Combined vehicles totals: **47/47 cases PASS**. Cumulative:
finance 41 + documents 52 + vehicles 47 = **140/140** on real
Postgres 16. Production behaviour unchanged.

Storage paths (`addDocument`, `addMaintenanceAttachment`)
remain deferred to Phase 2.25. Catalog mutations
(`MaintenanceType`, `Workshop`) remain deferred (Phase 3
product). The next phase is **Phase 2.25** (vehicle-document
storage guard) OR a new module pilot (`workflow`, `applicants`).

## 11.11 Phase 2.25 — Vehicles storage pilot (shipped)

Closes the vehicles module pilot. New tags:
- `phase225-pilot-scope` (addDocument tenantData spread).
- `phase225-pilot-scope-precheck` (update/deleteDocument by-id
  mutations gated by NEW explicit findVehicleOrFail).
- `phase225-storage-guard` (reserved for future storage-bound
  refactors; today the guard is the parent vehicle gate).

Real bugs closed: `updateDocument` and `deleteDocument` allowed
cross-tenant mutation in pilot mode (the prior
`findFirst({ id, vehicleId })` had no tenant filter — both ids
could be foreign). Phase 2.25 adds explicit
`findVehicleOrFail(vehicleId)` first.

`addMaintenanceAttachment` / `deleteMaintenanceAttachment`
remain stubs — DEFERRED_HIGH_RISK until the attachments
migration ships.

New harnesses (real-DB SAFE_CLONE):
- vehicles-storage-equivalence: 10/10 PASS
- vehicles-storage-isolation: 8/8 PASS

Combined vehicles totals: **65/65 cases PASS** across 6
harnesses. Cumulative finance + documents + vehicles:
**158/158** on real Postgres 16. Production behaviour
unchanged.

Three modules (finance, documents, vehicles) are now fully
proven on real DB across reads + writes + storage. The next
phase is a **new module pilot** (`workflow`, `applicants`) or
the cross-module audit-log tenancy phase.

## 11.12 Phase 2.26 — Workflow reads-first pilot (shipped)

`src/workflow` joins the pilot. Reads only; mutations deferred
to Phase 2.27+.

- `StageTemplate` tagged `phase226-global` (catalog; per-tenant
  override deferred to Phase 3 — see
  `SAAS_PHASE2_WORKFLOW_SYSTEM_TEMPLATE_DECISION.md`).
- `EmployeeStage` aggregates narrowed via `employee: { tenantId }`
  relation filter (no `tenantId` column on EmployeeStage).
- `getTimeline` migrated `findUnique` → `findFirst` + tenant
  predicate.
- WorkPermit + Visa reads narrowed on direct tenantId.
- Mutations stay on legacyPrisma with `phase226-excluded-mutation`.

Real-DB run: workflow-equivalence 11/11 + workflow-isolation
11/11 = **22/22 PASS**. Cumulative finance + documents +
vehicles + workflow: **180/180** on real Postgres 16.

The next phase is **Phase 2.27** (workflow mutation pilot) OR a
new module pilot (`applicants`).

## 11.13 Phase 2.27 — Workflow mutation pilot (shipped)

Closes the workflow module pilot. New helpers
`findEmployeeOrFail` / `findApplicantOrFail` gate every
mutation. New tags `phase227-pilot-scope` (parent-gate +
tenantData create) and `phase227-pilot-scope-precheck`
(by-id/by-key mutations gated by the prior pre-check).

Real bugs closed:
- updateEmployeeWorkflowStage / setEmployeeCurrentStage allowed
  cross-tenant mutation in pilot mode.
- createWorkPermit / createVisa left tenantId NULL on new rows.
- updateWorkPermit / updateVisa allowed cross-tenant mutation.

`StageTemplate` decision unchanged: global catalog (Phase 3
product question).

Real-DB results: workflow-equivalence 11/11 +
workflow-isolation 11/11 + workflow-mutation-equivalence 11/11
+ workflow-mutation-isolation 11/11 = **44/44 cases PASS**.

Combined cumulative finance + documents + vehicles + workflow:
**202/202** on real Postgres 16. Production behaviour unchanged.

Four modules (finance, documents, vehicles, workflow) are now
fully proven on real DB across reads + writes. The next phase is
a **new module pilot** (`applicants`) or the cross-module
audit-log tenancy phase.

## 11.14 Phase 2.28 — Applicants reads-first pilot (shipped)

`src/applicants` joins the pilot. Reads only; mutations deferred
to Phase 2.29+.

- 7 read sites narrowed via `getPilotScope(this.pilot, 'applicants').tenantWhere()`,
  including `findAll`, `findOne` (migrated `findUnique`→`findFirst`),
  parent-gated `getFinancialProfile` / `getAgencyHistory`,
  exports, and `getDeleteRequests` via `applicant: { tenantId }`
  relation filter.
- External-actor agency filter UNCHANGED — pilot tenant
  predicate is additive.
- ~37 mutation sites tagged `phase228-excluded-mutation`;
  `Applicant.email @unique` stays globally unique (Phase 3
  product question for per-tenant uniqueness).
- New `findApplicantOrFail` private gate (mirrors
  `findEmployeeOrFail` pattern from workflow).

Real-DB run: applicants-equivalence 12/12 + applicants-isolation
10/10 = **22/22 PASS**. Cumulative finance + documents +
vehicles + workflow + applicants: **224/224** on real Postgres 16.

The next phase is **Phase 2.29** (applicants mutation pilot —
largest mutation surface piloted yet, including the
`convertToEmployee` cross-module transactional conversion) OR
the cross-module audit-log tenancy phase.

## 11.15 Phase 2.29 — Applicants mutation pilot (shipped)

Closes the applicants reads-then-writes split. New helpers
(`findAgencyOrFail`); `create` + `convertToEmployee.employee.create`
write `tenantId` via `scope.tenantData`; 30+ by-id mutations
retagged `phase229-pilot-scope-precheck`; `bulkAction` adds
pre-filter (`phase229-bulk-filter`); `reviewDeleteRequest` uses
parent applicant relation filter.

Deferred: `publicSubmit` (DEFERRED_PUBLIC_ENTRY — no ALS frame),
`uploadPhoto` (DEFERRED_HIGH_RISK — storage upload precedes
tenant gate; Phase 2.30+).

Conversion semantics UNCHANGED. Email uniqueness UNCHANGED.
Agency-scope filter UNCHANGED.

Real-DB results: applicants-equivalence 12/12 +
applicants-isolation 10/10 + applicants-mutation-equivalence
10/10 + applicants-mutation-isolation 11/11 = **43/43 cases
PASS**. Cumulative finance + documents + vehicles + workflow +
applicants: **245/245** on real Postgres 16.

Five modules now fully proven on real DB across reads + writes.
The next phase is **Phase 2.30** (applicants storage path:
`uploadPhoto`) OR the cross-module audit-log tenancy phase.

## 12. Hard rules

- **Never enable `TENANT_PRISMA_ENFORCEMENT=true` in production until every P0/P1/P2 module has migrated.** Enabling it with a half-migrated codebase makes the un-migrated services start filtering by tenant when their callers don't expect it.
- **Never ship a `Prisma.raw` outside the registry** during Phase 2.1+. The scanner blocks new ones; existing ones are migrated, not copied.
- **Always preserve the legacy code path** behind the flag. Removing the legacy code is Phase 3.

## 11.3 Phase 2.30 — cross-module audit-log tenancy pilot

Consolidates audit emissions across the five piloted modules behind
a shared `TenantAuditLogService`. Adds an additive nullable
`AuditLog.tenantId` column gated by a new
`TENANT_AUDIT_LOG_PILOT_ENABLED` flag (default false). 8/8 cases on
real DB. Cumulative: **253/253**.

## 11.4 Phase 2.31 — applicants deferred paths closed

Closes the two paths Phase 2.29 deferred:

- `uploadPhoto` — pilot-aware parent tenant gate before
  `storage.uploadFile`. No bytes for cross-tenant ids.
  `phase231-storage-guard`.
- `publicSubmit` — hybrid Option A + B attribution (ALS first, agency
  fallback, reject otherwise in pilot mode). NULL-tenant rows
  preserved in legacy. New error codes
  `APPLICANT.PUBLIC_SUBMIT_NO_TENANT`,
  `APPLICANT.PUBLIC_SUBMIT_TENANT_MISMATCH`,
  `APPLICANT.PUBLIC_SUBMIT_AGENCY_NOT_FOUND`.
  `phase231-public-submit-attribution`.

No new flag. No schema change. Storage keys / ACLs / signed-URL
behaviour unchanged. Email uniqueness unchanged.

Real-DB: equivalence 6/6 + isolation 9/9 = 15/15. Cumulative across
modules: **261/261**.

The applicants module has no deferred paths remaining. The natural
next phase is the **cross-module conversion gate** for
`convertToEmployee` (Document / FinancialRecord / Employee target
tenant must equal active tenant).

## 11.5 Phase 2.32 — applicants cross-module conversion gate

Hardens `convertToEmployee` so cross-module re-link calls cannot
smuggle foreign-tenant rows across the conversion boundary.

- `Document.updateMany` and `FinancialRecord.updateMany` where-clauses
  spread `scope.tenantWhere()`. Strict `tenantId` equality in pilot
  mode; `{}` in legacy.
- `Employee.create` already writes `tenantId` via `scope.tenantData()`
  (Phase 2.29) — unchanged.
- Annotation tag `phase232-conversion-gate`.
- No new flag, no schema change, no transaction-boundary change, no
  conversion-flow redesign.

Real-DB: equivalence 7/7 + isolation 9/9 = 16/16. Cumulative across
modules: **277/277**.

The applicants module's cross-module surface is now tenant-safe.
The natural next phase is the **first non-applicant module audit
on real production-shape data** (compliance, employees, attendance,
pipeline, or agencies — pick by risk profile) OR a Phase 3 audit
of `Applicant.email` / `Employee.email` per-tenant uniqueness.

## 11.6 Phase 2.33 — employees reads-first pilot

`src/employees` brought into the pilot following the
finance/documents/vehicles/workflow/applicants pattern.

- `findAll`, `findOne`, `listAgencyAccess`, `getFinancialProfile`,
  `getDocuments`, `getWorkflow`, `getCompliance`, `getCertifications`,
  `getTraining`, `getPerformance`, `exportExcel` — `tenantWhere()`
  spread or parent-gated via tenant-scoped `findOne`.
- Mutation / lifecycle / agency-access write / storage / global
  uniqueness / sequence sites tagged `phase233-excluded-mutation`,
  `phase233-excluded-storage`, or `phase233-global` and routed through
  `legacyPrisma`.

`Employee.email` and `Employee.employeeNumber` stay globally unique
(see `SAAS_PHASE2_EMPLOYEES_UNIQUENESS_REVIEW.md`). External-actor
agency-grant visibility preserved.

Real-DB: equivalence 12/12 + isolation 11/11 = 23/23. Cumulative
across modules: **307/307**.

The natural next phase is the **employees mutation pilot (Phase
2.34)** — `findEmployeeOrFail` parent gate, `Employee.create`
tenantId, `uploadPhoto` storage-guard, agency-access write paths.

## 11.7 Phase 2.34 — employees mutation + storage + agency-access pilot

Closes the employees reads-then-writes split.

- `findEmployeeOrFail(id)` + `findAgencyOrFail(id)` parent gates added.
- `Employee.create` writes `tenantId` via `scope.tenantData()`.
- `update` / `remove` / `updateStatus` rely on Phase 2.33
  tenant-scoped `findOne` pre-check.
- `uploadPhoto` storage-guard: tenant lookup BEFORE `storage.uploadFile`.
- `grantAgencyAccess` / `updateAgencyAccess` / `revokeAgencyAccess`
  add dual target gates (employee + agency).

`Employee.email` / `Employee.employeeNumber` stay globally unique
(Phase 3). Storage keys / ACLs / signed URLs unchanged.

Real-DB: equivalence 10/10 + isolation 12/12 = 22/22. Cumulative
across modules: **329/329**.

The employees module has no deferred paths. Six modules now fully
proven on real DB across reads + writes.

## 11.8 Phase 2.35 — agencies reads-first pilot

`src/agencies` brought into the pilot following the
finance/documents/vehicles/workflow/applicants/employees pattern.

- `findAll`, `findOne`, `getUsers`, `getEmployees`, `getStats`,
  `listPermissionOverrides` — narrowed via `tenantWhereOrSystem()`
  (active tenant `OR isSystem: true`) or parent-gated.
- `listPublic` stays global by design (apply-form contract).
- Mutation / permission / storage / manager-set / audit-write sites
  routed through `legacyPrisma` and tagged
  `phase235-excluded-mutation` or `phase235-excluded-storage`.

`Agency` has no `@unique` columns → no Phase 3 uniqueness debt.

Real-DB: equivalence 12/12 + isolation 11/11 = 23/23. Cumulative
across modules: **352/352**.

The natural next phase is the **agencies mutation pilot (Phase
2.36)** — `findAgencyOrFail` parent gate, `Agency.create` `tenantData`,
`uploadLogo` storage-guard, permission-override / manager-set gates.

## 11.9 Phase 2.36 — agencies mutation + storage + permission + manager pilot

Closes the agencies reads-then-writes split.

- `Agency.create` writes `tenantId` via `scope.tenantData()` (NULL
  fallback when no ALS).
- `update` / `remove` gated by Phase 2.35 `findOne`.
- `uploadLogo` storage-guard (Phase 2.35 gate already in place).
- `setPermissionOverride` / `removePermissionOverride` gated by parent
  `findOne`.
- `setManager` adds NEW parent gate before user lookup.
- All audit emissions routed through `TenantAuditLogService`.

Storage keys / ACLs / signed URLs / system-agency semantics /
parent-child / `isDefault` all unchanged.

Real-DB: equivalence 10/10 + isolation 9/9 = 19/19. Cumulative
across modules: **371/371**.

The agencies module has no remaining mutation paths within its
current method surface. System-agency, parent-child, and isDefault
semantics are Phase 3.

## 11.10 Phase 2.37 — compliance reads-first reaffirmation

Compliance was the **second** module ever piloted (Phase 2.8). Phase
2.37 is the formal reads-first audit + harness reaffirmation:

- Read paths (`getDashboard`, `getAlerts`, `getEmployeeCompliance`,
  `getExpiringDocuments`) and the gated write paths (`updateAlert`
  pre-check, `generateAlerts` scan + create) are all already
  routed through `PilotPrismaAccessor` and tagged
  `phase28-pilot-scope`.
- The `phase28-compliance-extension.sql` fixture seed was patched so
  it stamps `updatedAt = now()` on insert (a later schema migration
  made the column NOT NULL).
- Real-DB: equivalence 12/12 + isolation 7/7 = 19/19. Cumulative
  across modules: **390/390**.

Eight reads-first modules (finance, documents, vehicles, workflow,
applicants, employees, agencies, compliance) are now formally
verified. The pattern stands.

Audit emission for `updateAlert` and scheduled background-scan ALS
frame attach are reserved for Phase 2.38+.

## 11.11 Phase 2.38 — compliance audit routing + scheduler-safe entrypoint

Closes the two gaps Phase 2.37 left open.

- `updateAlert` audit retagged `phase238-audit-log-pilot`; routed
  through `TenantAuditLogService`. Audit row carries `tenantId` only
  when audit pilot + ALS frame are on. NULL-tenant otherwise —
  byte-identical to pre-2.38.
- NEW `generateAlertsForTenant(tenantId)` entrypoint. Refuses to run
  outside SAFE_CLONE/SAFE_STAGING + compliance pilot active. Wraps
  the existing `generateAlerts` body in a fresh ALS frame.
  Tag `phase238-scheduler-routing`.
- No scheduler wiring; no fan-out helper. The contract for future
  scheduling is "one tenant per call".

Real-DB: 9/9 audit+scheduler harness; existing 12/12 + 7/7 still
green. Cumulative: **399/399**.

## 11.12 Phase 2.39 — tenant-aware job dispatch (compliance)

`dispatchComplianceAlertGenerationForTenants()` shipped on
`ComplianceService`. Refuses by default
(`TENANT_JOB_FANOUT_ENABLED=false`); when both fan-out and the
compliance pilot are active, enumerates ACTIVE tenants and calls
`generateAlertsForTenant(tenantId)` per tenant. Per-tenant fault
isolation; source-level meta-assertion that the dispatch body never
calls raw `generateAlerts()`.

No real scheduler is wired. The dispatch helper is the contract for
any future scheduler.

Real-DB: `compliance-tenant-job-dispatch` 9/9. Cumulative: **408/408**.

## 11.13 Phase 2.40 — compliance real scheduler entry-point

`ComplianceScheduler.runScheduledComplianceAlertGeneration()` shipped
on the compliance module. Disabled by default
(`COMPLIANCE_ALERT_SCHEDULER_ENABLED=false`). Calls only
`dispatchComplianceAlertGenerationForTenants()`. Source-level
meta-assertion proves the scheduler body never calls raw
`generateAlerts()` or `generateAlertsForTenant()`.

Tag: `phase240-compliance-real-scheduler`.

Real-DB: `compliance-real-scheduler` — 11/11 PASS. Cumulative:
**419/419**.

No cron framework is wired this phase. The scheduler entry-point is
the contract for any future schedule.

## 11.14 Phase 2.41 — compliance cron framework wired

`@nestjs/schedule` added as a runtime dependency.
`ScheduleModule.forRoot()` registered once in `app.module.ts`.
`ComplianceCron` provider with a single `@Cron(...)` entry-point
delegates to `ComplianceScheduler.runScheduledComplianceAlertGeneration()`.

Tag: `phase241-compliance-cron-framework`.

Real-DB: `compliance-cron-framework` — 14/14 PASS. Cumulative:
**433/433**.

The four-layer flag chain (`COMPLIANCE_ALERT_SCHEDULER_ENABLED` →
`TENANT_JOB_FANOUT_ENABLED` → pilot → env) is unchanged from
Phase 2.40. The decorator fires on schedule; every layer below
remains a no-op until all four flags are on.

## 11.15 Phase 2.42 — notifications reads-first reaffirmation

Notifications was the **fourth** module piloted (Phase 2.10 reads +
Phase 2.14/2.15 scheduler/fan-out). Phase 2.42 is the formal
reaffirmation:

- Re-applied the notifications fixture extension on the SAFE_CLONE
  DB; seeded the Recruiter role + tenant-A and tenant-B Recruiter
  users + per-user notification preferences so the fan-out case can
  exercise a real recipient query.
- Added Phase 2.42 npm aliases for the existing harnesses.
- Reserved tags `phase242-notifications-pilot-scope`,
  `phase242-notifications-fanout-deferred`,
  `phase242-notifications-audit-log`.

`NotificationPreference` stays per-user global (Phase 3 product
question). Audit-log emission is not in scope (no mutation surface
emits audit rows today). Real email/SMS sending stays in
`EmailModule` and is not exercised by any harness.

Real-DB: equivalence 11/11 + isolation 10/10 = 21/21. Cumulative
across modules: **454/454**.

## 11.16 Phase 2.43 — compliance → notifications event coupling

Optional, default-off coupling between per-tenant compliance alert
generation and tenant-safe notification fan-out.

- New flag `COMPLIANCE_NOTIFY_ON_ALERT=false`.
- New helper `ComplianceService.maybeNotifyOnAlertGeneration(total)`
  invoked from `generateAlertsForTenant` INSIDE the per-tenant ALS
  frame.
- Uses existing `NotificationsService.notifyUsersByRoles` —
  recipients narrowed by `agency.tenantId`; `Notification.tenantId`
  stamped from ALS; no external provider invoked.
- Crash-safe: notification failures captured as `{ error }`; no
  rollback.

Tags: `phase243-compliance-notification-coupling`,
`phase243-compliance-notification-fanout`,
`phase243-compliance-notification-deferred-provider`.

Real-DB: `compliance-notification-coupling` — 12/12 PASS.
Cumulative: **466/466**.

## 11.17 Phase 2.44 — operator-visible scheduler health signal

Adds a normalized `ScheduledHealthSummary` shape to
`ComplianceScheduler.runScheduledComplianceAlertGeneration` and emits
a single `compliance.scheduler.health` log line per tick.

- Counts only (no PII).
- No external alerting provider invoked.
- Cron handler unchanged.
- Status rules: `skipped` / `ok` / `partial_failure` / `failed`.

Tag: `phase244-compliance-scheduler-health`.

Real-DB: `compliance-scheduler-health` — 12/12 PASS. Cumulative:
**478/478**.

## 11.18 Phase 2.45 — per-recipient notification dedup

Optional, default-off dedup helper inside `NotificationsService`.
`notifyUsersByRoles` and `notifyUploaderAndRoles` now return
`{ created, deduped }`. Compliance coupling forwards the count;
scheduler health summary surfaces `notifyDeduped`.

Tag: `phase245-notifications-dedup`.

Real-DB: `notifications-dedup` — 12/12 PASS. Cumulative: **490/490**.

## 11.19 Phase 2.46 — internal `check*` notification scan dedup

Routes the four internal scans through the Phase 2.45
`createInAppWithDedup` helper:
- `checkExpiringCompliance`
- `checkServiceDue`
- `checkOverdue`
- `checkScheduledMaintenance`

Identity is the existing `(tenantId, userId, type, relatedEntity,
relatedEntityId)` triple — no new identity strings, no schema
migration. Pre-existing 24h "already-created" probe inside each
scan is preserved; the helper adds a configurable layer on top.

Tag: `phase246-notifications-internal-scan-dedup`.

Real-DB: `notifications-internal-scan-dedup` — 13/13 PASS.
Cumulative: **503/503**.

## 11.20 — Phase 2.47: Attendance reads-first TenantPrisma pilot

`src/attendance` joins the `getPilotScope(this.pilot, 'attendance')`
pattern. Read paths (`listEmployeesWithStats`, `getEmployeeAttendance`)
spread `tenantWhere()` into both the `Employee` parent and the
`AttendanceRecord` child query (denormalised `tenantId` since Phase
2.3). Mutation paths (`upsertRecord`, `bulkApply`, `updateRecord`,
`deleteRecord`) gain a pilot-aware parent gate
(`findEmployeeForMutationOrFail` / `findRecordForMutationOrFail`)
that reduces to a plain by-id lookup with the flag off — byte-
identical legacy behaviour.

`AttendanceLockedPeriod` is intentionally global; export-excel and
audit emission are deferred to follow-up phases.

Tags: `phase247-attendance-pilot-scope`, `phase247-attendance-mutation-scope`,
`phase247-attendance-audit-log`, `phase247-attendance-deferred-export`.

Real-DB: `attendance-equivalence` 12/12 + `attendance-isolation`
12/12. Cumulative: **527/527**.

## 11.21 — Phase 2.48: Attendance mutation pilot

`upsertRecord` stamps `tenantId` via `scope().tenantData()` on the
create-branch (legacy reduces to `{}`). Audit routing flips from
`legacyPrisma.auditLog.create` to `TenantAuditLogService.write` so
audit rows are tenant-attributed when `TENANT_AUDIT_LOG_PILOT_ENABLED=true`
and remain legacy/NULL-tenant compatible when off. `exportExcel`
applies `scope().tenantWhere()` to both the parent `Employee`
lookup and the bulk `attendanceRecord.findMany`. `AttendanceLockedPeriod`
sites are re-tagged `phase248-attendance-lock-deferred` and remain
intentionally global.

Tags: `phase248-attendance-mutation-pilot`,
`phase248-attendance-audit-log-pilot`,
`phase248-attendance-export-scope`,
`phase248-attendance-lock-deferred`.

Real-DB: `attendance-mutation-isolation` 17/17 + 2.47 sentinels
green. Cumulative: **544/544**.

## 11.22 — Phase 2.49: AttendanceLockedPeriod tenant scoping

Schema migration adds nullable `AttendanceLockedPeriod.tenantId`;
unique replaced by `@@unique([tenantId, year, month])`; partial
unique `(year, month) WHERE tenantId IS NULL` preserves the legacy
global invariant. Service lock APIs scope by `tenantWhere()` in
pilot mode and by `tenantId IS NULL` in legacy mode.

Tags: `phase249-attendance-lock-period-tenant-scope`,
`phase249-attendance-lock-period-migration`,
`phase249-attendance-lock-period-backfill`.

Real-DB: `attendance-lock-period-isolation` 13/13 + 2.47/2.48
sentinels green. Cumulative: **557/557**.

## 11.23 — Phase 2.50: Historic Attendance audit-log tenant backfill

Adds a dry-run-first script that maps historic NULL-tenant
`audit_logs(entity='AttendanceRecord')` rows to a `tenantId`
derived from the joined `attendance_records.tenantId`. Apply mode
is double-gated by `ATTENDANCE_AUDIT_BACKFILL_APPLY=true` AND
SAFE_CLONE/SAFE_STAGING classification. UPDATE is idempotent.

Tag: `phase250-attendance-audit-backfill`. Raw SQL in `scripts/`
(not in `src/`), so the `saas:scan:raw-sql` baseline is unchanged.

Real-DB harness: 13/13. Cumulative: **570/570**.

## 11.24 — Phase 2.51: Cross-module audit-log tenant backfill

Generalises the Phase 2.50 attendance template to six target
entities — `Document`, `FinancialRecord`, `WorkPermit`, `Visa`,
`ComplianceAlert`, `Notification`. Each target table carries
`tenantId` directly (Phase 2.3+), so derivation is a direct join
with no ambiguity.

Apply double-gated by `CROSS_MODULE_AUDIT_BACKFILL_APPLY=true` AND
SAFE_CLONE/SAFE_STAGING classification. Per-entity UPDATE inside a
single transaction; idempotent.

Tag: `phase251-cross-module-audit-backfill`. Raw SQL lives in
`scripts/`, so the `saas:scan:raw-sql` baseline is unchanged.

Real-DB harness: 20/20. Cumulative: **590/590**.

## 11.25 — Phase 2.52: Audit-log tenant-scoped read API + retention preview

`src/logs/logs.service.ts` joins the TenantPrisma pilot pattern.
`findAll` and `getStats` add `getPilotScope(this.pilot, 'audit-logs').tenantWhere()`
to their where clauses. Mutation paths (`clearLogs`, `deleteOne`)
remain on `legacyPrisma` and are unchanged.

`TenantAuditLogService` gains four new read-only helpers:
`listForTenant`, `countForTenant`, `getByIdForTenant`, and
`previewRetention`. The retention preview is a count-only helper —
no destructive Prisma calls.

Tags: `phase252-audit-log-read-pilot`,
`phase252-audit-log-retention-preview`,
`phase252-audit-log-export-deferred`.

Real-DB: `audit-log-read-equivalence` 14/14,
`audit-log-read-isolation` 10/10, `audit-log-retention-preview`
10/10. Cumulative: **624/624**.

## 11.26 — Phase 2.53: Audit-log retention enforcement (soft-delete)

`scripts/saas/phase2/audit-log-retention-enforce.ts` introduces a
dry-run-first enforcement step that sets `audit_logs.deletedAt =
now()` on rows older than the configured cutoff. Apply requires
THREE gates: `AUDIT_LOG_RETENTION_ENABLED=true` AND
`AUDIT_LOG_RETENTION_APPLY=true` AND a SAFE classification. The
`AUDIT_LOG_RETENTION_SCOPE` env (`tenant` | `null-tenant` | `all`)
controls which rows are eligible. Hard-delete is forbidden by
source-level harness assertion.

Tag: `phase253-audit-log-retention-enforce`. Raw SQL lives in
`scripts/`, baseline unchanged.

Real-DB harness: 17/17. Cumulative: **641/641**.

## 11.27 — Phase 2.54: Audit-log hard-delete (post-soft-delete grace)

`scripts/saas/phase2/audit-log-hard-delete.ts` introduces a
dry-run-first hard-delete pass for rows already soft-deleted by
Phase 2.53. Apply requires `AUDIT_LOG_HARD_DELETE_ENABLED=true` AND
`AUDIT_LOG_HARD_DELETE_APPLY=true` AND a SAFE classification AND
(for scope=tenant) an explicit tenant id. `AUDIT_LOG_HARD_DELETE_GRACE_DAYS`
defaults to 90; eligibility is `deletedAt IS NOT NULL AND deletedAt < cutoff`.

Tag: `phase254-audit-log-hard-delete`. Raw SQL lives in `scripts/`,
baseline unchanged. The harness verifies that `DELETE FROM
audit_logs` exists only in this script plus the pre-existing
`src/recycle-bin/database-cleanup.service.ts` System Admin path
(tagged `phase211-excluded-platform`).

Real-DB harness: 17/17. Cumulative: **658/658**.

## 11.28 — Phase 2.55: Operator-facing audit retention runbook

Documentation-only phase. New runbook at
`docs/runbooks/audit-retention-rollout.md` (top-level pointer at
`AUDIT_LOG_RETENTION_RUNBOOK.md`) stitches Phases 2.50 → 2.54 into
one production rollout sequence: backfill → read validation →
soft-delete → grace-window wait → hard-delete. Includes go/no-go
gates, snapshot capture commands, monitoring fields, timing
guidance, rollback policy table, and an operator sign-off table.

A doc-level check script (`scripts/saas/phase2/audit-retention-runbook-check.ts`)
asserts the runbook covers all five phases plus the
soft-delete-only and grace-cutoff invariants of the destructive
scripts. Tag: `phase255-audit-retention-runbook`. No DB I/O.

Real-DB harness: 22/22 (doc + source-level checks).
Cumulative: **680/680**.

## 11.29 — Phase 2.56: Audit-log RBAC tenant binding

`LogsService` gains `assertAuditReadAccess(scope)`,
`auditTenantWhereForActor(scope)`, and `isGlobalReadEnabled()`.
With pilot active and `audit-logs` allow-listed, tenant-scoped
roles (and FULL_ACCESS without the explicit global-read gate)
require an active ALS tenant frame; otherwise `ForbiddenException`.
With `AUDIT_LOG_GLOBAL_READ_ENABLED=true`, FULL_ACCESS roles
(System Admin, HR Manager, Compliance Officer) bypass the tenant
predicate. Tag chain:
`phase256-audit-log-rbac-tenant-binding`,
`phase256-audit-log-global-read-gate`,
`phase256-audit-log-actor-scope`.

Real-DB harness: 15/15. Cumulative: **695/695**.

## 11.30 — Phase 2.57: Tenant-scoped audit HTTP endpoints

`src/logs/tenant-audit.controller.ts` (new) exposes four read-only
routes under `/admin/tenant-audit`. `LogsService` gains
`findOneForActor(id, scope)` and `previewRetentionForActor(scope, days?)`,
both reusing the Phase 2.56 RBAC contract. `LogsModule` imports
`TenantAuditLogModule` and registers the new controller.
Constructor of `LogsService` now takes the audit service.

Tags: `phase257-audit-log-http-read`,
`phase257-audit-log-http-retention-preview`,
`phase257-audit-log-http-no-destructive-routes`.

Real-DB harness: 18/18. Cumulative: **713/713**.

## 11.31 — Phase 2.58: Tenant-scoped audit CSV export

`LogsService` gains `exportCsvForActor(filters, scope)` and two
module-private helpers: `resolveExportMaxRows()` (env fallback to
50000) and `renderAuditCsv(rows)` (RFC-4180-style escaping with
CRLF line endings). The new `GET /admin/tenant-audit/export.csv`
route on `TenantAuditController` returns the body with response
headers `X-Audit-Export-Row-Count`, `X-Audit-Export-Max-Rows`,
`X-Audit-Export-Capped`.

Tags: `phase258-audit-log-export-csv`,
`phase258-audit-log-export-row-cap`,
`phase258-audit-log-export-no-destructive`.

Real-DB harness: 17/17. Cumulative: **730/730**.

## 11.32 — Phase 2.59: Per-tenant audit HTTP rate limit

`src/logs/audit-log-rate-limiter.service.ts` (new) — in-memory
fixed-window limiter. `TenantAuditController` adds private
`rateLimitKey(caller)` (tenant-keyed by default; global-keyed
under `AUDIT_LOG_GLOBAL_READ_ENABLED=true` for FULL_ACCESS) and
`enforceRateLimit(caller, res?)` invoked at the top of every GET
handler. Throws `HttpException(429)` on exhaustion BEFORE the
data path runs. Default-OFF.

Tags: `phase259-audit-log-http-rate-limit`,
`phase259-audit-log-rate-limit-keying`,
`phase259-audit-log-rate-limit-disabled-default`.

Real-DB harness: 17/17. Cumulative: **747/747**.

## 11.33 — Phase 2.60: Retry-After header + structured 429 envelope

`AuditLogRateLimiter` gains `tryConsume(key)` (non-throwing).
`TenantAuditController.enforceRateLimit(caller, res?)` now:
- attaches `X-RateLimit-*` headers when enabled (Phase 2.59),
- on rejection sets `Retry-After: <retryAfterSeconds>` and throws
  `HttpException(<envelope>, 429)` where the envelope is
  `{ error: 'rate_limited', message, retryAfterSeconds, limit,
  remaining, windowSeconds }`.
All five GET handlers declare `@Res({ passthrough: true })`
(except `exportCsv` which already manages its own response).

Tags: `phase260-audit-log-rate-limit-envelope`,
`phase260-audit-log-retry-after-header`.

Real-DB harness: 17/17. Cumulative: **764/764**.

## 11.34 — Phase 2.61: Pipeline reads-first TenantPrisma pilot

`src/pipeline` joins the `getPilotScope(this.pilot, 'pipeline')`
pattern. Workflow CONFIGURATION (Workflow, WorkflowStage,
WorkflowStageUser, WorkflowStageRequiredDoc, WorkflowAccessUser)
is GLOBAL by design — no `tenantId` column on those tables. The
tenant-bound surface is the *assignment* layer
(`CandidateWorkflowAssignment.tenantId`,
`EmployeeWorkflowAssignment.tenantId`, denormed in Phase 2.3).

Three read paths apply `scope.tenantWhere()`:
- `getWorkflowCandidates` — direct on `CandidateWorkflowAssignment`.
- `getWorkflowBoardView` — direct on `EmployeeWorkflowAssignment` +
  nested `assignment.tenantId` on `CandidateStageProgress`.
- `getWorkflowStats` — `count` / `findMany` on assignments and
  nested `assignment.tenantId` on progress.

Mutations + transitions + audit emission are deferred to a
follow-up phase. Tags: `phase261-pipeline-pilot-scope`,
`phase261-pipeline-mutation-deferred`,
`phase261-pipeline-audit-log`,
`phase261-pipeline-export-deferred`,
`phase261-pipeline-transition-deferred`.

Real-DB: `pipeline-equivalence` 12/12 + `pipeline-isolation`
12/12. Cumulative: **788/788**.

## 11.35 — Phase 2.62: Pipeline mutation + transition pilot

`assignCandidate` stamps `tenantId` via `scope().tenantData()` on
the `CandidateWorkflowAssignment.create` data block. Parent gates
added for assignment + progress paths
(`findCandidateForPipelineMutationOrFail`,
`findCandidateAssignmentForMutationOrFail`,
`findProgressForMutationOrFail`) wired into `assignCandidate`,
`advanceToStage`, `updateProgress`, `toggleProgressFlag`,
`submitApproval`. All 14 active `auditLog.create` sites now route
through a private `auditLog(...)` helper that delegates to
`TenantAuditLogService.write`. Workflow / WorkflowStage CRUD
remains global (no `tenantId` column).

Tags: `phase262-pipeline-mutation-pilot`,
`phase262-pipeline-transition-pilot`,
`phase262-pipeline-audit-log-pilot`,
`phase262-pipeline-workflow-config-global`,
`phase262-pipeline-stage-config-global`.

Real-DB: `pipeline-mutation-isolation` 17/17 + 2.61 sentinels
green. Cumulative: **805/805**.

---

## Phase 2.63 — Workflow tenant scope schema migration

Workflows promoted from a globally shared table to a per-tenant
construct. `Workflow.tenantId text NULL` + `workflows_tenantId_idx`.
Strategy A: NULL-tenant rows remain readable as global templates but
mutation is refused. `WorkflowStage` derives tenant via its parent —
no direct column. See `SAAS_PHASE2_WORKFLOW_TENANT_SCOPE.md`.

---

## Phase 3.0 — Product migration readiness

Per-tenant uniqueness audit + duplicate-detection machinery in place.
No schema or data changes. Per-tenant unique constraints are deferred
to Phase 3.3 after duplicate cleanup. PlatformAdmin foundation
documented; `Agency.isSystem` retirement scheduled for Phase 3.5–3.8.
See SAAS_PHASE3_UNIQUENESS_AUDIT.md and
SAAS_PHASE3_PLATFORM_ADMIN_FOUNDATION.md.
