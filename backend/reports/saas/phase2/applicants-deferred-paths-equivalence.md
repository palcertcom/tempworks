# Phase 2.31 — applicants deferred-paths equivalence

**6/6 PASS**

- PASS — 1. uploadPhoto legacy: shape preserved — id=00000000-0000-0000-0000-0000000aa001 hasPhotoUrl=true uploads=1
- PASS — 2. uploadPhoto pilot: shape preserved — id=00000000-0000-0000-0000-0000000aa001 hasPhotoUrl=true
- PASS — 3. uploadPhoto pilot same-tenant: 1 storage call — uploads=1
- PASS — 4. publicSubmit legacy: tenantId = NULL — id=b034759e-9c42-4631-a900-d0505feabd80 tenantId=null
- PASS — 5. publicSubmit pilot + agencyId (no ALS): tenantId = A — tenantId=11111111-1111-1111-1111-111111111111
- PASS — 6. publicSubmit pilot + ALS A: tenantId = A — tenantId=11111111-1111-1111-1111-111111111111
