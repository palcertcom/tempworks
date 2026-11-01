# Phase 2.19 — Finance Helper Coverage: Agency Entity Case

> Last unproven entity branch. Code already symmetric — this phase
> closes the test-coverage matrix.

---

## 1. Question

Phase 2.17.1 narrowed all three `entityType` branches in
`resolvePersonIdentity`. Phase 2.18 proved the APPLICANT branch on
real DB. This phase proves the AGENCY branch.

## 2. Code review — AGENCY branch

`finance.service.ts:1090-1099`:

```ts
if (entityType === 'AGENCY') {
  const ag = await this.prisma.agency.findFirst({
    where: { id: entityId, ...t },          // ← tenant-narrowed
    select: { id: true, deletedAt: true },
  });
  if (!ag || ag.deletedAt !== null) throw new NotFoundException(`Agency ${entityId} not found`);
  return { applicantId: null, stageAtCreation: 'AGENCY' };
}
```

`resolveEntityNameForNotif` AGENCY branch (line ~1124):

```ts
if (entityType === 'AGENCY') {
  const ag = await this.prisma.agency.findFirst({
    where: { id: entityId, ...t },          // ← tenant-narrowed
    select: { name: true },
  });
  return ag?.name ?? 'Unknown Agency';
}
```

`attachEntityNames` AGENCY branch:

```ts
agencyIds.length
  ? this.prisma.agency.findMany({
      where: { id: { in: agencyIds }, ...t },
      select: { id: true, name: true },
    })
  : [],
```

All three paths use the same shape as the APPLICANT and EMPLOYEE
branches. No code gap.

## 3. Tenant ownership path

`prisma/schema.prisma`:

```prisma
model Agency {
  id        String  @id @default(uuid())
  name      String
  ...
  tenantId  String?
  ...
  @@map("agencies")
}
```

`Agency.tenantId` is denormed (Phase 2.3). The
`phase2171-finance-seed.sql` already created two tenant-scoped
agencies (`aaaaaaa1-…` on tenant A, `bbbbbbb2-…` on tenant B), so
the only missing piece is one AGENCY-typed financial record on
tenant A so that legacy reads naturally see one and the harness
can probe `update`/notification helpers as well.

## 4. Cross-tenant risk

| Pilot state | Behaviour |
|-------------|-----------|
| OFF | `where: { id }` — same as pre-2.17.1. Cross-tenant lookup succeeds (legacy semantics). |
| ON, ALS attached | `where: { id, tenantId: <ALS> }` — cross-tenant `entityId` returns null ⇒ `NotFoundException`. |
| ON, no ALS tenant | `tenantWhere()` returns `{}` (legacy fallback). |

## 5. Existing coverage

| Entity | Real-DB harness coverage |
|--------|--------------------------|
| EMPLOYEE | case 9 (Phase 2.17.1) |
| APPLICANT | cases 11+12+13 (Phase 2.18) |
| AGENCY | **MISSING** |

Phase 2.19 adds three AGENCY cases (14, 15, 16) following the
APPLICANT template.

## 6. Decision

**No service-code change required.** The 2.17.1 narrowing already
covers the AGENCY branch symmetrically. This phase is pure
coverage completion:

1. Fixture extension `phase219-finance-agency-seed.sql` adds one
   AGENCY-typed financial record on tenant A. Tenant B agency row
   already exists from `phase2171-finance-seed.sql`.
2. New isolation cases:
   - **case 14**: pilot ON, tenant A, `create({ AGENCY,
     tenantB-agency })` ⇒ `NotFoundException`, no row inserted.
   - **case 15**: pilot ON, tenant A, `create({ AGENCY,
     tenantA-agency })` ⇒ success; persists `tenantId=A`,
     `applicantId=null`, `stageAtCreation='AGENCY'`.
   - **case 16**: pilot ON, tenant A, `update` on the AGENCY-typed
     record keeps `entityId` tenant-scoped (proves
     `resolveEntityNameForNotif` AGENCY branch is safe inside
     update flows).

If the harness reveals an actual bug, only then will the service
be touched.

## 7. After Phase 2.19

The per-entity coverage matrix is complete:

| Entity | Code (2.17.1) | Real-DB harness |
|--------|:------:|:------:|
| EMPLOYEE | ✓ | ✓ (2.17.1) |
| APPLICANT | ✓ | ✓ (2.18) |
| AGENCY | ✓ | ✓ (**2.19**) |

The Phase 2.17.1 helper-narrowing fix can be considered
end-to-end proven across all supported entity types on real DB.

## 8. Production safety

No code change. No DTO change. No schema change. Production
defaults remain identical: `TENANT_PRISMA_PILOT_ENABLED=false` ⇒
`scope.tenantWhere()` returns `{}` ⇒ AGENCY lookups behave as in
legacy.
