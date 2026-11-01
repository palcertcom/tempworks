# Phase 2.27 — Workflow Mutation Scope Decision

> Per-method classification for the Phase 2.27 mutation pilot.

---

## Classification

| Method | Class | Reason |
|--------|-------|--------|
| `updateEmployeeWorkflowStage` | **INCLUDED_NOW** | NEW `findEmployeeOrFail` parent gate (tenant-scoped via pilot client). The by-key `EmployeeStage` update never reaches a foreign row. |
| `setEmployeeCurrentStage` | **INCLUDED_NOW** | Same parent gate. The `StageTemplate` lookup remains global (`phase226-global`). The by-employeeId `EmployeeStage` updateMany + upsert are gated by parent. |
| `createWorkPermit` | **INCLUDED_NOW** | Parent employee gate + `scope.tenantData()` on the new `WorkPermit`. |
| `updateWorkPermit` | **INCLUDED_NOW** | NEW pre-check via `this.prisma.workPermit.findFirst({ id, ...t })` to close a real cross-tenant mutation gap. |
| `createVisa` | **INCLUDED_NOW** | Parent-entity gate (`findEmployeeOrFail` for EMPLOYEE; `findApplicantOrFail` for APPLICANT) + `scope.tenantData()`. |
| `updateVisa` | **INCLUDED_NOW** | NEW pre-check via `this.prisma.visa.findFirst({ id, ...t })`. |
| `auditLog.create` (helper) | **LEGACY_ONLY** | Global by design; cross-module audit phase. |
| `StageTemplate.*` reads inside mutations | **LEGACY_ONLY** (`phase226-global`) | Global catalog; per-tenant override deferred to Phase 3. |

## Rationale — INCLUDED_NOW

Each mutation either:

(a) **closes a real cross-tenant mutation gap** (`updateEmployeeWorkflowStage`, `setEmployeeCurrentStage`, `updateWorkPermit`, `updateVisa` — all had by-id pre-checks with no tenant filter), OR

(b) **writes a new row** that needs `tenantId` populated (`createWorkPermit`, `createVisa`).

The fix in both cases is the smallest change that uses the established patterns from finance 2.17 / documents 2.21 / vehicles 2.24:

- Add a `findEmployeeOrFail` / `findApplicantOrFail` private helper that loads the parent through the pilot client with `tenantWhere()`.
- Either (a) tag by-id mutation as `phase227-pilot-scope-precheck`, or (b) spread `scope.tenantData()` into create data and tag `phase227-pilot-scope`.

## Rationale — DEFERRED

None for Phase 2.27. The workflow service has no template-clone, approval, or storage paths to defer.

`StageTemplate` schema-side changes (per-tenant override / clone) remain a Phase 3 product question per `SAAS_PHASE2_WORKFLOW_SYSTEM_TEMPLATE_DECISION.md`.

## Helpers added in Phase 2.27

```ts
private async findEmployeeOrFail(id: string) {
  const t = this.scope().tenantWhere();
  const e = await this.prisma.employee.findFirst({ where: { id, deletedAt: null, ...t } });
  if (!e) throw new NotFoundException('Employee not found');
  return e;
}

private async findApplicantOrFail(id: string) {
  const t = this.scope().tenantWhere();
  const a = await this.prisma.applicant.findFirst({ where: { id, deletedAt: null, ...t } });
  if (!a) throw new NotFoundException('Applicant not found');
  return a;
}
```

In legacy mode `tenantWhere()` returns `{}` and both helpers reduce to plain by-id lookups — same behaviour as today's `findUnique` calls.

## Out-of-scope safeguards

- No schema change.
- No new feature flag.
- No `tenantId` column added to `EmployeeStage` (gated through parent).
- No `StageTemplate` per-tenant override.
- No cross-module integration changes (documents `checkAndAutoCompleteStage` stays `phase220-excluded-mutation`).
