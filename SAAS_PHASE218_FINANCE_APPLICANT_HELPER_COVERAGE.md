# Phase 2.18 — Finance Helper Coverage: Applicant Entity Case

> The Phase 2.17.1 fix narrowed all three `entityType` branches in
> `resolvePersonIdentity`. The EMPLOYEE branch was exercised on
> real DB. This phase proves the APPLICANT branch the same way.

---

## 1. Question

Phase 2.17.1 closed a cross-tenant create vulnerability in
`resolvePersonIdentity` by routing all entity-id lookups through
`this.prisma` and spreading `scope.tenantWhere()`. The new
isolation case 9 exercised the EMPLOYEE branch end-to-end on a
SAFE_CLONE. Does the APPLICANT branch behave identically?

## 2. Code review — all three branches use the same shape

`finance.service.ts:1066-1100`:

```ts
const t = this.scope().tenantWhere();

if (entityType === 'APPLICANT') {
  const a = await this.prisma.applicant.findFirst({
    where: { id: entityId, ...t },          // ← tenant-narrowed
    select: { firstName: true, lastName: true, tier: true, deletedAt: true },
  });
  if (!a || a.deletedAt !== null)
    throw new NotFoundException(`Applicant ${entityId} not found or has been converted`);
  const stageAtCreation = (a.tier as string) === 'LEAD' ? 'LEAD' : 'CANDIDATE';
  return { applicantId: entityId, stageAtCreation };
}

if (entityType === 'EMPLOYEE') {
  const e = await this.prisma.employee.findFirst({
    where: { id: entityId, deletedAt: null, ...t },   // ← tenant-narrowed
    ...
  });
  ...
}

if (entityType === 'AGENCY') {
  const ag = await this.prisma.agency.findFirst({
    where: { id: entityId, ...t },          // ← tenant-narrowed
    ...
  });
  ...
}
```

All three branches go through `this.prisma.X.findFirst({ where: {
id, ...t } })`. In pilot mode the tenant predicate is appended; in
legacy mode the spread collapses to `{}`. The behaviour is
symmetric across the three entity types — no APPLICANT-specific
gap remains in service code.

`resolveEntityNameForNotif` (`finance.service.ts:1112-1124`)
mirrors the same shape for the three branches. APPLICANT lookup is
narrowed identically.

`attachEntityNames` does an `in:` clause for each entityType's
ids, also routed through `this.prisma` with `...t`.

## 3. Tenant ownership path for applicants

`prisma/schema.prisma`:

```prisma
model Applicant {
  id           String   @id @default(uuid())
  firstName    String
  lastName     String
  email        String
  phone        String
  agencyId     String?
  tenantId     String?  // Phase 2.3 denorm
  tier         ApplicantTier  @default(LEAD)
  deletedAt    DateTime?
  convertedToEmployeeId String?
  ...
  @@map("applicants")
}
```

The `tenantId` column was denormed in Phase 2.3 along with the
other entity-keyed tables. The schema is ready; the helpers (post
2.17.1) honour it.

## 4. Cross-tenant risk for the APPLICANT path

| Pilot state | Behaviour |
|-------------|-----------|
| OFF | `where: { id }` — same as pre-2.17.1. Cross-tenant lookup succeeds (legacy semantics). |
| ON, ALS attached | `where: { id, tenantId: <ALS> }` — cross-tenant `entityId` returns null ⇒ `NotFoundException`. |
| ON, no ALS tenant | `tenantWhere()` returns `{}` (legacy fallback). |

The existing Phase 2.17.1 fix already covers the APPLICANT branch.
What was missing: a real-DB harness case proving it.

## 5. Existing 2.17.1 coverage

`finance-mutation-isolation` case 9 (added in 2.17.1) exercises
EMPLOYEE only:

```ts
const empB = await prisma.employee.findFirst({ where: { tenantId: tB } });
await svc.create({ entityType: 'EMPLOYEE', entityId: empB.id, ... });
// expects NotFoundException
```

No APPLICANT analogue existed. That's the gap this phase closes.

## 6. Remaining gaps (after Phase 2.18)

Per-entity coverage in mutation-isolation:

| Entity | Pre-2.17.1 | Post-2.17.1 | Post-2.18 |
|--------|-----------|-------------|-----------|
| EMPLOYEE | not tested | case 9 PASS | case 9 PASS |
| APPLICANT | not tested | not tested | **case 11 (this phase)** |
| AGENCY | not tested | not tested | **closed in Phase 2.19 (cases 14, 15, 16)** — see `SAAS_PHASE219_FINANCE_AGENCY_HELPER_COVERAGE.md` |

`resolveEntityNameForNotif` is also exercised indirectly through
the new APPLICANT case via the `create` notification side effect:
the failing create path raises before the notification fires, so
no cross-tenant name reaches a notification body.

## 7. Decision

**No service-code change required for Phase 2.18.** The
2.17.1 fix already narrows the APPLICANT branch. This phase adds:

1. A fixture extension (`phase218-finance-applicant-seed.sql`)
   that seeds one applicant per tenant.
2. A new isolation case (`case 11` in
   `finance-mutation-isolation`) proving the APPLICANT cross-
   tenant create raises `NotFoundException` and inserts no row.
3. A complementary case (`case 12`) proving the same-tenant
   APPLICANT create succeeds and persists `tenantId=A`.
4. A `resolveEntityNameForNotif` direct-probe case (`case 13`)
   proving the helper returns `'Unknown'` when called from the
   wrong tenant frame.

If the harness reveals an actual bug, only then will the service
be touched; otherwise the harness alone proves coverage.

## 8. Production safety

No service change. No DTO change. No schema change. Production
defaults remain identical: `TENANT_PRISMA_PILOT_ENABLED=false` ⇒
`scope.tenantWhere()` returns `{}` ⇒ APPLICANT lookups behave as
in legacy.
