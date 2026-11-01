# Phase 2.22 — Documents Download Side-Effect Review

> Reading bytes is a side effect on the storage tier. The tenant
> check must come first.

---

## 1. Why downloads are a storage read side effect

`storage.uploadFile` mutates the bucket. `storage.downloadByUrlOrKey`
(invoked indirectly via `fetchDocumentBuffer`) does not mutate, but:

- It performs a billable network/disk read.
- It reveals the object's existence and bytes to the caller.
- Once bytes are returned to the application, they are
  effectively in the caller's possession — there is no recall.

A cross-tenant byte read is therefore a real information
disclosure even though no DB row was mutated.

The Phase 2.22 guarantee: in pilot mode, no
`fetchDocumentBuffer` call is issued for a document URL the
active tenant does not own.

## 2. Tenant check ordering

Both methods must follow:

```
1. resolve metadata (Prisma lookup, tenant-scoped in pilot mode)
2. if metadata empty / cross-tenant ⇒ return early or filter out
3. fetch bytes (storage call) — only for URLs the metadata returned
```

`readDocumentBytes` already does this (Phase 2.20). The metadata
lookup raises 404 BEFORE `fetchDocumentBuffer`.

`createBulkDownloadArchive` did NOT do this in pre-2.22: the
Prisma lookup used `legacyPrisma`, so cross-tenant ids in the
input list returned cross-tenant rows whose URLs were then
fetched. Phase 2.22 fixes this by routing the lookup through
`this.prisma` with the tenant predicate spread.

## 3. Bulk archive — pre-filter design

Choice between pre-filter (silent) vs reject (loud) — see the
audit document §5. Phase 2.22 picks pre-filter because:

- The archive's `try/catch...continue` block already tolerates
  per-row failures (e.g. a deleted file in storage). Silent
  filtering of cross-tenant ids matches that semantic.
- The caller's UX is preserved: a partial archive is returned;
  the user sees only files they own.
- A noisy reject would regress legitimate calls that happen to
  include stale ids (e.g. a recently soft-deleted doc).

The harness verifies that:

1. A pure cross-tenant id list returns an archive with **0
   entries** and triggers **0 storage reads**.
2. A mixed-tenant id list returns an archive containing only the
   active-tenant entries and triggers **N storage reads where N
   = active-tenant id count**.
3. A pure same-tenant id list behaves identically to legacy
   (same entry count, same names).

## 4. Mixed-tenant id behaviour — explicit contract

Caller passes `ids = [A1, A2, B1, B2]` from tenant A's request.

Pre-2.22 behaviour:

- `legacyPrisma.findMany({ id: { in: [A1, A2, B1, B2] } })` →
  4 rows.
- 4 `fetchDocumentBuffer` calls.
- ZIP contains 4 entries including B's bytes. **LEAK.**

Post-2.22 behaviour (pilot mode, ALS = A):

- `this.prisma.findMany({ id: { in: [A1, A2, B1, B2] }, tenantId: A })`
  → 2 rows (A1, A2).
- 2 `fetchDocumentBuffer` calls (A1, A2 only).
- ZIP contains 2 entries: A1, A2.

Post-2.22 behaviour (legacy mode):

- `this.prisma` = legacy prisma (pilot inactive).
- `tenantWhere()` = `{}`.
- `findMany({ id: { in: [A1, A2, B1, B2] } })` → 4 rows.
- ZIP contains 4 entries. **Same as pre-2.22.**

Production behaviour byte-identical to pre-2.22. Pilot mode
silently filters foreign-tenant ids without an error path.

## 5. ACL / signed URL — UNCHANGED

This phase does NOT:

- introduce signed URLs,
- change object ACL,
- change storage key format,
- change bucket configuration,
- change download endpoint authentication,
- change permission resolution.

Those changes belong to a future phase (`Phase 3+ — storage
authz refactor`). Phase 2.22 reuses the existing public-URL
download model and only adds a tenant pre-filter on the metadata
lookup.

## 6. Future signed-URL migration relationship

When the codebase migrates to signed URLs, the Phase 2.22 guard
remains useful:

- The metadata lookup still happens server-side; the tenant
  predicate still narrows the candidate set.
- The signed URL would then be issued only for active-tenant
  document ids — same property, different transport.

So Phase 2.22 is forward-compatible with a future signing
migration without lock-in.

## 7. Storage-read counters in tests

The `documents-download-isolation` harness substitutes the real
`StorageService` with a stub whose `downloadByUrlOrKey` /
`uploadFile` increment a counter. The harness asserts:

- Cross-tenant `readDocumentBytes` triggers **0** storage reads.
- Cross-tenant-only `createBulkDownloadArchive` triggers **0**
  storage reads.
- Mixed-tenant `createBulkDownloadArchive` triggers exactly the
  count of active-tenant ids in the input list.

Storage stub is the same shape used by Phase 2.21 mutation
harnesses. Same interface, same counter pattern.

## 8. Production safety

`TENANT_PRISMA_PILOT_ENABLED=false` (default) ⇒
`scope().tenantWhere()` returns `{}` ⇒ findMany matches by `id:
{ in: [...] }` alone ⇒ legacy behaviour. No bucket configuration
change. No URL format change. No new flag.
