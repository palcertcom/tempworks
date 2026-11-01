# Phase 2.22 — Documents Download/Bulk Archive Audit

> Last documents-module path. Two methods. The smallest possible
> change closes the cross-tenant byte-read attack vector.

---

## 1. Methods in scope

| Method | Lines | Storage call | DB call |
|--------|------:|--------------|---------|
| `readDocumentBytes(id)` | 284-298 | `fetchDocumentBuffer(doc.fileUrl)` | `prisma.document.findFirst({ id, ...t })` |
| `createBulkDownloadArchive(ids[])` | 761-796 | `fetchDocumentBuffer(doc.fileUrl)` ×N | `legacyPrisma.document.findMany({ id: { in: ids } })` |
| `fetchDocumentBuffer(fileUrl)` (helper) | 81-96 | `fetch(url)` or `fs.readFile(diskPath)` | none |

`fetchDocumentBuffer` is a pure helper — given a URL it returns
bytes (HTTP fetch for Spaces URLs, fs read for legacy `/uploads/`
paths). It has NO database lookup. Tenant safety must come from
the caller filtering URLs to active-tenant docs only.

## 2. Pre-2.22 state per method

### 2.1 `readDocumentBytes` — already partially covered (Phase 2.20)

Phase 2.20 narrowed the metadata `findFirst({ id, ...t })`. In
pilot mode a cross-tenant id raises `NotFoundException` BEFORE
`fetchDocumentBuffer` is called — so no storage byte fetch occurs.

```ts
const doc = await this.prisma.document.findFirst({       // ← tenant-scoped (2.20)
  where: { id, deletedAt: null, ...t },
  select: { id: true, name: true, fileUrl: true, mimeType: true },
});
if (!doc) throw new NotFoundException('Document not found');  // ← gates storage
const buffer = await this.fetchDocumentBuffer(doc.fileUrl);  // ← only on success
```

Phase 2.22 re-tags this site as `phase222-download-guard` to
mark it as part of the download guard taxonomy (the metadata
narrowing was always meant to gate the byte fetch; making the
intent explicit avoids reviewers misclassifying it later).

### 2.2 `createBulkDownloadArchive` — UNNARROWED, real bug

The findMany at line 762 uses `legacyPrisma`:

```ts
const docs = await this.legacyPrisma.document.findMany({  // @phase220-excluded-download
  where: { id: { in: ids }, deletedAt: null },
  include: { documentType: { select: { name: true } } },
});
// then for each doc: fetchDocumentBuffer(doc.fileUrl)
```

In pilot mode today a tenant-A caller can pass a list of ids that
includes tenant-B documents; the findMany returns the tenant-B
rows; the loop calls `fetchDocumentBuffer` on tenant-B URLs;
tenant-B file bytes end up in tenant A's ZIP archive.

This is a real cross-tenant byte-read vulnerability that Phase
2.22 closes.

### 2.3 `fetchDocumentBuffer` — no change

It only needs a URL. The caller controls which URLs it sees.
Phase 2.22 changes the callers' Prisma lookups so the URL list
never contains foreign-tenant URLs in pilot mode. The helper
itself stays untouched.

## 3. Tenant ownership path

`Document.tenantId` was denormed in Phase 2.3 with
`@@index([tenantId])` and `@@index([tenantId, status])`. The
download guard reuses the same scope helper as every other 2.20+
narrowing: `getPilotScope(this.pilot, 'documents').tenantWhere()`.

## 4. Cross-tenant risk matrix (pre-Phase-2.22)

| Method | Pilot OFF | Pilot ON, single id | Pilot ON, mixed-tenant id list |
|--------|-----------|----------------------|-------------------------------|
| `readDocumentBytes` | unchanged | NotFoundException, **0 storage reads** ✓ (Phase 2.20) | n/a (single id) |
| `createBulkDownloadArchive` | unchanged | tenant-B file bytes leak into A's archive ✗ | tenant-B file bytes leak into A's archive ✗ |

After Phase 2.22 (post-fix):

| Method | Pilot OFF | Pilot ON, single id | Pilot ON, mixed-tenant id list |
|--------|-----------|----------------------|-------------------------------|
| `readDocumentBytes` | unchanged | unchanged ✓ | n/a |
| `createBulkDownloadArchive` | unchanged | only A's bytes returned ✓ | A's ids retained, B's ids silently filtered out by tenant predicate; **0 storage reads for filtered ids** ✓ |

## 5. Mixed-id behavior decision

Two options:

- **(a) Filter silently** — pilot-mode findMany has `tenantId =
  ALS.id` predicate; cross-tenant ids in the input list simply
  don't appear in the result; the loop never sees them and never
  fetches their files. Same caller-API shape; no new error path.
- **(b) Reject loudly** — if `result.length < ids.length`, raise
  `BadRequestException`.

Phase 2.22 chooses **(a) Filter silently**. Reasons:

- Smallest change matches the Phase 2.16 read-pilot pattern.
- Caller-facing API shape unchanged: returns a Buffer of the
  archive containing only authorised entries.
- Loud rejection introduces a new error path that breaks the UI's
  bulk-download UX (which currently tolerates partially missing
  files via the `try/catch ... continue` block in the loop). A
  legitimate same-tenant call that happens to include a recently
  deleted doc id would now error out — regression.
- Operators wanting "loud" behaviour can still detect mismatch
  client-side by comparing the requested id count against the
  archive's entry count.

The harness exercises BOTH a pure cross-tenant id list (expects
empty archive, 0 storage reads for foreign ids) AND a mixed
list (expects only A's entries, 0 storage reads for B's ids).

## 6. Storage-read timing

Both methods fetch storage bytes ONLY after the Prisma metadata
lookup succeeds. The Phase 2.22 change is therefore localised to
the metadata lookup:

- `readDocumentBytes`: already correct (Phase 2.20).
- `createBulkDownloadArchive`: switch `legacyPrisma` →
  `this.prisma` and spread `...t` into the where clause.

No storage-architecture change. No ACL change. No signed-URL
introduction. Storage-key format unchanged.

## 7. Rollback behavior

Pure configuration. `TENANT_PRISMA_PILOT_ENABLED=false` ⇒
`tenantWhere()` returns `{}` ⇒ both methods reduce to legacy
behaviour: `readDocumentBytes` matches by id alone,
`createBulkDownloadArchive` returns the union of all requested
ids. No migration. No DB state introduced.

## 8. Included / Deferred summary

| Path | Disposition |
|------|-------------|
| `readDocumentBytes` | INCLUDED (re-tagged from `phase220-pilot-scope` to `phase222-download-guard` for taxonomy clarity; behaviour unchanged from 2.20) |
| `createBulkDownloadArchive` (Prisma findMany) | INCLUDED — switched to `this.prisma` + `...t` spread; re-tagged `phase222-download-guard` |
| `createBulkDownloadArchive` (storage loop) | NO CHANGE — already operates only on URLs the (now tenant-scoped) findMany returned |
| `fetchDocumentBuffer` helper | NO CHANGE — pure URL → bytes |
| ACL / signed URLs | DEFERRED — out of scope per Phase 2.22 strict rules |
| Storage key format | DEFERRED — out of scope |
| Per-tenant download authz beyond tenantId | DEFERRED — Phase 3 product |
