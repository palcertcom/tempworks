# Phase 2.21 — Documents Storage Side-Effect Review

> Files do not roll back. The tenant check must come first.

---

## 1. Pre-2.21 storage timing

`create(dto, file, uploadedById)`:

```
1. legacyPrisma.documentType.findUnique     # auth
2. resolveEntityName                         # informational
3. storage.uploadFile(file.buffer, ...)      # ← BYTES TO STORAGE
4. legacyPrisma.$transaction:
     - documentIdService.generate
     - tx.document.create
5. auditLog.create
6. (optional) complianceAlert.create + notifications
```

If step 4 fails (DB error, sequence collision, anything), the
file written in step 3 is NOT deleted. Today this is acceptable
because the operator has already authenticated and supplied a
valid `entityId`. Phase 2.21 must keep this property in legacy
mode AND extend it to pilot mode without introducing new orphans.

`publicCreate(file, entityId, ...)`:

```
1. (photo short-circuit) storage.uploadFile  # BYTES if 'photo'
2. documentType resolution                   # multiple lookups
3. user.findFirst (system uploader)
4. storage.uploadFile(...)                   # ← BYTES TO STORAGE
5. legacyPrisma.$transaction (document.create)
```

Same orphan pattern.

`renew(originalId, dto, file, ...)`:

```
1. findOne(originalId)                       # ← Phase 2.20 tenant gate
2. (optional) storage.uploadFile             # already gated by step 1
3. legacyPrisma.$transaction (document.create)
```

`renew` was already safe because the `findOne` gate runs BEFORE
any storage upload.

## 2. Post-2.21 storage timing — `create`

```
1. prisma.documentType.findUnique
2. assertEntityOwnedByActiveTenant(...)      # ← NEW Phase 2.21 GATE
3. resolveEntityName
4. storage.uploadFile                        # ← only reached if gate passes
5. legacyPrisma.$transaction:
     - documentIdService.generate
     - tx.document.create({ ..., ...tdata })  # ← Phase 2.21 writes tenantId
6. auditLog.create
7. (optional) complianceAlert.create({ ..., ...tdata })
```

The new `assertEntityOwnedByActiveTenant` does:

```ts
const t = this.scope().tenantWhere();
const found = await this.prisma.<entityType>.findFirst({ where: { id, ...t }, select: { id: true } });
if (!found) throw new NotFoundException('Entity not found');
```

In legacy mode (`tenantWhere()` returns `{}`) this reduces to the
same lookup `resolveEntityName` already did internally — no new
behaviour, same result. In pilot mode a cross-tenant `entityId`
raises `NotFoundException` BEFORE step 4 — no orphan file.

## 3. Post-2.21 storage timing — `publicCreate`

```
1. photo short-circuit:
     a. (if pilot scope active) prisma.applicant.findFirst({ id, ...t })
     b. storage.uploadFile (photo)
     c. applicant.updateMany({ photoUrl })
2. documentType resolution
3. (if pilot scope active) prisma.applicant.findFirst({ id, ...t })  # ← guard
4. user.findFirst (system uploader)
5. storage.uploadFile
6. legacyPrisma.$transaction (document.create with ...tdata)
```

The public flow typically runs without an ALS tenant frame, so
`scope().active` is false and the guard is a no-op. When a future
caller attaches an ALS frame, the guard kicks in.

## 4. Rollback for storage files

**Unchanged.** Storage files are still NOT deleted on DB failure.
Phase 2.21 only REDUCES the surface area for orphans by gating
on tenant BEFORE the upload. A DB failure after upload still
leaves a file. That existing failure mode is documented but not
addressed in this phase.

A future phase (`Phase 2.22+ download/storage refactor`) could
add a try/catch around the DB transaction with a best-effort
storage delete, but that is a behaviour change worth its own
review. Out of scope here.

## 5. Tenant validation order

**Tenant check → storage write → DB write.** Locked in for
`create` and `publicCreate` (when pilot active).

`renew` already had `findOne → storage → DB`; unchanged.

## 6. Orphan-file scenarios after Phase 2.21

| Scenario | Pre-2.21 | Post-2.21 |
|----------|----------|-----------|
| Cross-tenant `entityId` (pilot ON) | orphan file written | **no file written** ✓ |
| Same-tenant `entityId`, DB tx fails | orphan file (existing behaviour) | orphan file (unchanged) |
| Bad `documentTypeId` | no orphan (auth check first) | no orphan (unchanged) |
| Bad `entityType` | orphan (validation was after upload) | **no file written** ✓ — `assertEntityOwnedByActiveTenant` raises BadRequestException for unknown entityType BEFORE storage |
| Storage upload itself fails | no DB row (existing) | no DB row (unchanged) |

## 7. Storage architecture — UNCHANGED

- Storage key format: unchanged.
- Storage bucket / driver: unchanged.
- ACL: unchanged (no signing in this phase).
- Bulk download: deferred to Phase 2.22.
- Single-doc download (`readDocumentBytes`): metadata-narrowed in
  Phase 2.20; storage byte fetch unchanged.

## 8. Decision

Implement only `assertEntityOwnedByActiveTenant` as the storage
guard. No other storage behaviour change. This is the smallest
safe intervention that closes the cross-tenant orphan-file
attack vector identified during the mutation audit.

The harness's `documents-mutation-isolation` case 1 verifies the
guard end-to-end: cross-tenant `create` raises
`NotFoundException` and the storage stub records ZERO upload
calls.
