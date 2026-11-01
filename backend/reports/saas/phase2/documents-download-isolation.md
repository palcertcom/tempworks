# Phase 2.22 — Documents Download Isolation

Generated: 2026-05-10T07:22:19.818Z
Environment: SAFE_CLONE (localhost + fixture pattern (db=saas_phase1_fixture))
Tenants: A=`11111111-1111-1111-1111-111111111111` B=`22222222-2222-2222-2222-222222222222`

- Cases passed: **8** / 8
- Cases failed: 0

| # | Case | Result | Detail |
|--:|------|:------:|--------|
| 1 | DOWNLOAD GUARD: pilot ON, tenant A readDocumentBytes(tenantB-id) raises NotFoundException; 0 storage reads | PASS | err=NotFoundException downloads=0 |
| 2 | pilot ON, tenant A readDocumentBytes(tenantA-id) succeeds; 1 storage read | PASS | bytes=true downloads=1 |
| 3 | ARCHIVE GUARD: pilot ON, tenant A archive of cross-tenant-only ids ⇒ empty zip; 0 storage reads | PASS | entries=0 downloads=0 |
| 4 | ARCHIVE GUARD: pilot ON, tenant A archive of mixed ids ⇒ 2 entries (A only); 2 storage reads; no tenant-B file names | PASS | entries=2 downloads=2 names=Alice_Anderson/PASSPORT/Alice_Passport.pdf|Alice_Anderson/VISA/Alice_Visa.pdf |
| 5 | pilot ON, tenant A: same-tenant archive ⇒ 2 entries; 2 storage reads | PASS | entries=2 downloads=2 |
| 6 | pilot OFF: legacy archive of mixed ids returns 4 entries (gate disengages) | PASS | entries=4 downloads=4 |
| 7 | concurrent ALS frames isolated: T_A archive has 2 A entries; T_B archive has 2 B entries | PASS | aEntries=2 bEntries=2 |
| 8 | source: download sites carry phase222-download-guard and route through pilot client | PASS | all patterns matched |