# Audit F — Storage

- **Status:** WARN
- **Started:** 2026-05-09T14:53:00.973Z
- **Duration:** 76 ms

## Metrics

| Key | Value | Note |
|-----|-------|------|
| `documents.total` | 52 |  |
| `documents.with-storageKey` | 0 |  |
| `documents.with-storageUrl` | 51 |  |
| `documents.missing-storage` | 1 |  |
| `documents.legacy-local` | 1 |  |
| `documents.public-spaces` | 50 |  |
| `documents.not-tenant-prefixed` | 0 |  |

## Findings

- **[WARN]** `storage.missing-pointer` — 1 documents have neither storageKey nor storageUrl. Investigate; rekey-skip on Phase 3.
- **[WARN]** `storage.local-path` — 1 documents reference a legacy local /uploads path (sample: /uploads/documents/legacy.pdf).
- **[WARN]** `storage.public-spaces` — 50 documents stored as public-readable Spaces URLs (no signature). Will be rekeyed to tenants/<tenantId>/... in Phase 3.

## Notes
- Phase 1 does NOT migrate any object. The audit just sizes the Phase 3 rekey + ACL flip job.
- Per ADR-006, frontend cutover precedes ACL flip.
