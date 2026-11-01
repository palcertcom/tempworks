# Phase 2.17.1 — Finance Cross-Entity Reassignment Guard Review

> Can a finance `update` repoint a record at an entity in another tenant?
> The DTO says no. The service inherits that guarantee.

---

## 1. Question

Phase 2.17 listed a cross-entity reassignment guard as a candidate
follow-up: ensure that an `update` cannot change `entityType`,
`entityId`, or `applicantId` to a target in another tenant. Does
the guard need to ship in 2.17.1?

## 2. Finding — DTO already forbids the change

`src/finance/dto/update-financial-record.dto.ts`:

```ts
/** All fields optional; entityType and entityId cannot be changed
 *  after creation. */
export class UpdateFinancialRecordDto extends PartialType(
  OmitType(CreateFinancialRecordDto, ['entityType', 'entityId'] as const),
) {}
```

The DTO is `PartialType(OmitType(CreateFinancialRecordDto,
['entityType', 'entityId']))`. Both fields are structurally
absent — they are not part of the type and are not declared. With
NestJS's default `ValidationPipe`, properties not on the DTO are
either ignored (default) or rejected (whitelist mode). Either way
they cannot reach the service.

`applicantId` is computed by `resolvePersonIdentity` at create time
and is NOT in `CreateFinancialRecordDto` either — it cannot be set
by a caller.

`stageAtCreation` similarly is computed at create time only.

## 3. Service body inspection

`FinanceService.update` (`src/finance/finance.service.ts:407-454`):

```ts
const existing = await this.findOne(id);   // tenant-scoped pre-check
const data: any = { ...dto };
if (dto.transactionDate) data.transactionDate = new Date(...);
const updated = await this.legacyPrisma.financialRecord.update({
  where: { id }, data, include: this.recordInclude,
});
```

Spread `...dto` could in principle carry stray fields. If a future
DTO refactor accidentally re-introduced `entityType` or `entityId`,
the spread would propagate the change. To prevent that, this phase
adds a defensive runtime delete of the three reassignment-sensitive
fields immediately before the `legacyPrisma.update` call. The
deletion is a no-op today (DTO does not contain them) and stays a
no-op until/unless someone changes the DTO contract.

## 4. Decision

| Aspect | Decision |
|--------|----------|
| Guard needed at service level? | **NO** (structurally impossible via DTO) |
| Defensive scrub in `update`? | **YES** (one-liner; protects against DTO regression) |
| Harness coverage? | **YES** (new isolation case attempts a smuggled `entityType`/`entityId`/`applicantId` via `as any` and asserts the row's identity columns are unchanged) |
| Schema-level protection? | NOT in scope (would require triggers / columns immutable; deferred) |

## 5. Implementation

`finance.service.ts` `update`:

```ts
const data: any = { ...dto };
// Phase 2.17.1 — defensive scrub. The UpdateFinancialRecordDto
// structurally omits entityType / entityId. applicantId and
// stageAtCreation are computed at create time only. Deleting them
// here protects the cross-entity invariant against future DTO drift.
delete data.entityType;
delete data.entityId;
delete data.applicantId;
delete data.stageAtCreation;
if (dto.transactionDate) data.transactionDate = new Date(dto.transactionDate);
```

This is a no-op today (the DTO omits these fields) and remains a
no-op until/unless a future PR changes the DTO. The corresponding
isolation test smuggles those fields through with `as any` and
asserts that the persisted row keeps its original entityType /
entityId / applicantId.

## 6. Production behavior

Unchanged. The defensive scrub only deletes already-undefined
properties. No new feature flag, no new database column, no new
schema migration.

## 7. Future work — Phase 2.18+

If the product ever needs explicit entity reassignment (for
example, moving a financial record from APPLICANT to EMPLOYEE on
conversion), it must be added as a separate explicit method
(`reassignEntity(id, newType, newId)`) which validates the new
target's tenant and writes an audit log. It must NOT be a hidden
side-effect of `update`.
