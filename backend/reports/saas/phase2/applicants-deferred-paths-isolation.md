# Phase 2.31 — applicants deferred-paths isolation

**9/9 PASS**

- PASS — 1. uploadPhoto cross-tenant rejected; no storage call — threw=true uploads=0
- PASS — 2. uploadPhoto same-tenant succeeds; 1 storage call — id=00000000-0000-0000-0000-0000000aa001 uploads=1
- PASS — 3. publicSubmit ALS A + agencyId A: tenantId=A — tenantId=11111111-1111-1111-1111-111111111111
- PASS — 4. ALS A + agencyId B: TENANT_MISMATCH; no row — threw=true code=APPLICANT.PUBLIC_SUBMIT_TENANT_MISMATCH dup=false
- PASS — 5. pilot no ALS no agencyId: NO_TENANT; no row — threw=true code=APPLICANT.PUBLIC_SUBMIT_NO_TENANT dup=false
- PASS — 6. agencyId B (no ALS) → tenantId=B; tenant A cannot see it — tenantId=22222222-2222-2222-2222-222222222222 aSees=false
- PASS — 7. legacy: tenantId NULL (pre-2.31 behaviour) — tenantId=null
- PASS — 8. concurrent ALS frames isolated — a=11111111-1111-1111-1111-111111111111 b=22222222-2222-2222-2222-222222222222
- PASS — 9. source-level: phase231 patterns present — OK
