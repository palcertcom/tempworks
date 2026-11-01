# Phase 2.35 — agencies equivalence

**12/12 PASS**

- PASS — 1. pilot active when flag ON + module allowed — {"active":true,"reason":"pilot ON, env=SAFE_CLONE"}
- PASS — 2. legacy findAll: union across tenants — total=14
- PASS — 3. pilot findAll(A): total reduced — legacy=14 pilot=7
- PASS — 4. findOne resolves tenant A id — id=aaaaaaa1
- PASS — 5. findOne(missing) raises NotFound — NotFound
- PASS — 6. search "Agency B" under A: no foreign-tenant rows — count=0
- PASS — 7. getUsers parent-gated returns array — count=1
- PASS — 8. getEmployees parent-gated returns array — count=8
- PASS — 9. getStats parent-gated returns counts — users=1 emp=8
- PASS — 10. listPermissionOverrides parent-gated returns array — count=0
- PASS — 11. listPublic stays globally visible (>= legacy total) — count=14
- PASS — 12. response shape preserved — data,meta
