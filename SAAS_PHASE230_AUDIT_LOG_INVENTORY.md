# Phase 2.30 — Audit Log Inventory

> Every `auditLog.create` site across the five piloted modules.

---

## 1. Per-module summary

| Module | Direct `auditLog.create` sites | Wrapped via private helper | Total audit emissions |
|--------|------:|------:|------:|
| `finance` | 0 | 9 (via `private auditLog()` at line 1184) | 9 |
| `documents` | 6 | 0 | 6 |
| `vehicles` | 0 | 0 | 0 (no audit) |
| `workflow` | 4 | 0 | 4 |
| `applicants` | 0 | 11+ (via `private auditLog()` at ~line 1180) | 11+ |
| **Total** | 10 direct | 20+ wrapped | 30+ |

## 2. Per-site detail

### Finance (`src/finance/finance.service.ts`)

Single private helper `private async auditLog(actorId, action, entityId, changes?)` at L1184 wraps all 9 emissions. Helper currently calls `legacyPrisma.auditLog.create` directly.

- L376 `FINANCIAL_RECORD_CREATED` — entityId = financial record id (tenant-scoped row from Phase 2.16 onwards).
- L448 `FINANCIAL_RECORD_UPDATED`.
- L477 `FINANCIAL_RECORD_DELETED`.
- L527 `FINANCIAL_RECORD_STATUS_CHANGED`.
- L620 `FINANCIAL_RECORD_DEDUCTION_ADDED`.
- L692 `FINANCIAL_RECORD_DEDUCTION_REMOVED`.
- L728 `FINANCIAL_ATTACHMENT_ADDED`.
- L754 `FINANCIAL_ATTACHMENT_REMOVED`.
- (1 more inside the high-balance check.)

All callers operate inside the Phase 2.16/2.17 tenant gate. **Tenant attribution: ALS.** All **INCLUDED**.

### Documents (`src/documents/documents.service.ts`)

Inline `auditLog.create` x6:

- L532 inside `update` (gated by Phase 2.20 `findOne`).
- L608 inside `verify` (gated).
- L653 inside `renew` (gated).
- L728 inside `remove` (gated).
- L749 inside `uploadDocumentVersion` flow.
- L877 inside `checkAndAutoCompleteStage` private helper (cross-module side effect; gated indirectly via `verify`).

All **INCLUDED** — every site runs inside a tenant-scoped flow.

### Vehicles (`src/vehicles/vehicles.service.ts`)

No `auditLog.create` calls. Vehicles module is exempt from this phase.

### Workflow (`src/workflow/workflow.service.ts`)

Inline `auditLog.create` x4:

- L169 inside `updateEmployeeWorkflowStage` (gated by Phase 2.27 `findEmployeeOrFail`).
- L204 inside `setEmployeeCurrentStage` (gated).
- L336 inside `createWorkPermit` (gated by `findEmployeeOrFail`).
- L391 inside `createVisa` (gated by `findEmployeeOrFail`/`findApplicantOrFail`).

All **INCLUDED**.

### Applicants (`src/applicants/applicants.service.ts`)

Single private helper `private async auditLog(actorId, action, entityId, changes?)` wraps all 11+ emissions. Helper currently calls `legacyPrisma.auditLog.create` directly.

- L227 `CREATE` (after Phase 2.29 `tenantData`-spread create).
- L275 `UPDATE` (after Phase 2.29 gate).
- L323 `STATUS_CHANGE`.
- L335 `DELETE`.
- L431 `WORKFLOW_STAGE_UPDATE`.
- L450 `APPROVE_CANDIDATE`.
- L466 `REJECT_CANDIDATE`.
- L538 `CONVERT_LEAD_TO_CANDIDATE`.
- L589 `REASSIGN_AGENCY`.
- L621 `UPSERT_FINANCIAL_PROFILE`.
- (Plus emissions inside `bulkAction`, `convertToEmployee`, `requestDelete`, `reviewDeleteRequest`.)

All **INCLUDED** — every site runs inside the Phase 2.29 mutation gate.

## 3. Tenant attribution path

For every site listed above:
- The mutation is gated by a tenant-scoped `findOne` / `findEmployeeOrFail` / `findApplicantOrFail` / `findVehicleOrFail` (depending on module).
- The active ALS frame (`TenantContext.optional?.()`) carries the active tenant id when pilot is active.
- The shared helper reads ALS and writes `tenantId` only when the pilot is active.

In legacy mode the spread is `{}` and the row does not carry `tenantId` — byte-identical to today.

## 4. Out-of-scope sites

- `documents.checkAndAutoCompleteStage` cross-module side effect at L877 — included via the workflow gate from `verify`. Same tenant-attribution path.
- Audit-log READ sites (e.g. `finance.getHistory` reads `auditLog.findMany`) — out of scope; reads stay legacy until a separate Phase 3 audit-read pilot.

## 5. Decision

Apply the shared helper to every site listed in §2. No site is deferred. The shared helper safely degrades to legacy when:

- pilot flag off
- ALS has no tenant
- explicit `tenantId` not provided for system jobs

Phase 2.30 introduces `TENANT_AUDIT_LOG_PILOT_ENABLED=false` as a separate flag so audit-log tenancy can be rolled out independently of the Prisma-pilot flag.
