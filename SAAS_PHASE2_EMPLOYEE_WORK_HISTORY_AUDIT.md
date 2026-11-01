# Phase 2.7 — Employee Work History Module Audit

> Pre-refactor audit of `src/employee-work-history`. The first
> tenant-scoped pilot.

---

## 1. Files in module

| File | Lines | Role |
|------|------|------|
| `employee-work-history.module.ts` | 12 | Nest module |
| `employee-work-history.controller.ts` | 94 | HTTP surface (CRUD + attachments) |
| `employee-work-history.service.ts` | 198 | business logic |
| `dto/work-history.dto.ts` | (small) | input shapes |

Total: ~310 lines. Smallest tenant-scoped module currently in the codebase.

## 2. Prisma call sites (pre-refactor)

13 direct `this.prisma.*` call sites across the service:

| Method | Calls |
|---|---|
| `assertEmployeeExists` | 1 (`employee.findFirst`) |
| `list` | 1 (`employeeWorkHistory.findMany`) |
| `listEventTypes` | 1 (`workHistoryEventTypeSetting.findMany`) |
| `create` | 1 (`employeeWorkHistory.create`) |
| `update` | 2 (`findFirst` + `update`) |
| `remove` | 2 (`findFirst` + `update`) |
| `addAttachment` | 2 (`employeeWorkHistory.findFirst` + `employeeWorkHistoryAttachment.create`) |
| `removeAttachment` | 2 (`employeeWorkHistoryAttachment.findFirst` + `update`) |
| `auditLog` | 1 (`auditLog.create`) |

`auditLog.create` is intentionally kept on the **legacy** `PrismaService`
post-refactor — audit writes are global by design, and the audit log
must not block the main flow.

## 3. Models used

- `Employee` — read-only ownership probe (`assertEmployeeExists`).
- `EmployeeWorkHistory` — full CRUD. Tenant-scoped via Phase 2.3 `tenantId` denorm.
- `EmployeeWorkHistoryAttachment` — full CRUD. Tenant-scoped via Phase 2.3 denorm.
- `WorkHistoryEventTypeSetting` — read-only catalog. **Global**, no `tenantId`.
- `AuditLog` — write-only side effect. **Global**.

## 4. Tenant ownership path

The natural ownership chain is:

```
EmployeeWorkHistory.employeeId → Employee.tenantId
EmployeeWorkHistoryAttachment.workHistoryId → EmployeeWorkHistory.employeeId → Employee.tenantId
```

After Phase 2.3 the denorm columns `EmployeeWorkHistory.tenantId` and
`EmployeeWorkHistoryAttachment.tenantId` are populated for any rows
created against the production schema. Legacy rows may have NULL
`tenantId`; the pilot's WHERE filter (`tenantId = $ctx`) intentionally
excludes them — this is the documented Phase 2.3 acceptance contract
for entity-keyed denorms.

## 5. Use of `tenantId`

- Schema: nullable on both tables (Phase 2.3 ALTER TABLE).
- Indexes: `@@index([tenantId])` on both tables.
- Pre-refactor: not consulted by the service.
- Post-refactor (pilot active): the service spreads
  `scope.tenantWhere()` into every read/update/delete `where` clause
  and `scope.tenantData()` into every create `data` object. With pilot
  inactive, both helpers return `{}` — call sites are byte-identical to
  legacy.

## 6. Mutations

| Surface | Effect | Tenant constraint (pilot mode) |
|---------|--------|--------------------------------|
| `create` | inserts a row with `employeeId` + denormalized `tenantId` | `tenantId` = active tenant |
| `update` | updates via `id` lookup; pre-checked by `findFirst` with `employeeId` AND `tenantId` | cross-tenant `id` ⇒ `NotFoundException` |
| `remove` | soft-delete (sets `deletedAt`); same pre-check | cross-tenant `id` ⇒ `NotFoundException` |
| `addAttachment` | uploads to S3 + inserts attachment row | parent lookup is tenant-scoped |
| `removeAttachment` | sets `deletedAt`, deletes file in S3 | parent lookup is tenant-scoped |

The `update` and `remove` flows do a tenant-scoped `findFirst` before the
mutation, then mutate by `id` only. This is safe because the prior
lookup proved the row belongs to the active tenant; the mutation's `where: { id }`
cannot then leak to a different tenant.

## 7. File / document relations

`EmployeeWorkHistoryAttachment` is the only file-bearing relation. It
holds an S3 URL (`fileUrl`). On removal the service deletes the file
via `StorageService.deleteFileByUrlOrKey`. Storage operations are
unchanged by the pilot — the pilot only changes Prisma access, not
storage.

## 8. Permissions

Permissions are enforced at the controller via the standard guards.
The pilot does NOT change auth, RBAC, or HTTP status codes. A
cross-tenant access attempt presents as `NotFoundException` (404), not
`ForbiddenException` (403) — because in tenant-safe mode a foreign
tenant's resources should be *invisible*, not *forbidden*. This is
consistent with the report engine's contract.

## 9. Current risks (pre-refactor)

- Cross-tenant `entryId` reuse: in legacy mode, a caller with a guess
  for an `entryId` could theoretically read/update across tenants if
  the controller's permission check doesn't guard the tenant boundary
  itself. The pilot closes this hole.
- Storage path includes `employeeId`: this is fine in itself; tenant-
  scoping is via the DB ownership probe, not the storage key.
- `assertEventTypeConfigured` soft-fails open when the catalog is
  empty — kept as-is; the pilot does not change validation logic.

## 10. Refactor plan (executed in this PR)

1. Inject `PilotPrismaAccessor` alongside the existing `PrismaService`.
2. Rename `this.prisma` to `this.legacyPrisma` (kept for the audit-log
   write only). Add `private get prisma()` returning `pilot.client()`.
3. Add `scope = getPilotScope(this.pilot)` at the top of every method
   that touches a tenant-scoped table.
4. Spread `scope.tenantWhere()` into reads/updates/deletes; spread
   `scope.tenantData()` into create payloads.
5. Annotate every retained `this.prisma.*` line with
   `// @tenant-reviewed: phase27-pilot-scope` so the scanner shows the
   module as fully reviewed.
6. Add a Phase 2.7 fixture extension (`phase27-ewh-extension.sql`) so
   the harnesses can run against the local fixture.
7. Build the equivalence + isolation harnesses.

Acceptance: legacy behaviour unchanged when `TENANT_PRISMA_PILOT_ENABLED=false`;
tenant-safe behaviour proven when the flag is on AND the env classifies
as SAFE_CLONE / SAFE_STAGING AND a tenant is in ALS.
