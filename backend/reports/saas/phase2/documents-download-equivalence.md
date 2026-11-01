# Phase 2.22 — Documents Download Equivalence

Generated: 2026-05-10T07:22:04.785Z
Environment: SAFE_CLONE (localhost + fixture pattern (db=saas_phase1_fixture))
Tenant A: `11111111-1111-1111-1111-111111111111`

- Cases passed: **6** / 6
- Cases failed: 0

| # | Case | Result | Detail |
|--:|------|:------:|--------|
| 1 | readDocumentBytes: response shape preserved (buffer + mimeType + name) | PASS | legacy.shape=true pilot.shape=true |
| 2 | readDocumentBytes: exactly 1 storage read in both modes | PASS | legacy=1 pilot=1 |
| 3 | createBulkDownloadArchive: same-tenant 2-id list yields 2 entries in both modes | PASS | legacy.entries=2 pilot.entries=2 |
| 4 | createBulkDownloadArchive: 2 storage reads in both modes for same-tenant 2-id list | PASS | legacy.downloads=2 pilot.downloads=2 |
| 5 | readDocumentBytes: NotFoundException for missing id in both modes | PASS | legacy=NotFoundException pilot=NotFoundException |
| 6 | createBulkDownloadArchive: empty input yields empty zip + 0 storage reads in both modes | PASS | legacy={entries:0,downloads:0} pilot={entries:0,downloads:0} |