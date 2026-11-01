# Phase 2.33 — employees isolation

**11/11 PASS**

- PASS — 1. findAll under tenant A returns A only — count=6 allA=true
- PASS — 2. findOne(tenantB-id) cross-tenant 404 — NotFound
- PASS — 3. agencyId=tenantB filter under A returns 0 — total=0
- PASS — 4. search "Bob" under A does not leak B — count=0
- PASS — 5. getDocuments(tenantB-id) blocked at parent gate — NotFound
- PASS — 6. getCompliance(tenantB-id) blocked at parent gate — NotFound
- PASS — 7. listAgencyAccess(tenantB-id) blocked at parent gate — NotFound
- PASS — 8. exportExcel by-id [A,B] under A includes only A rows — bytes=7199 listAllA=true
- PASS — 9. concurrent ALS frames isolated (A, B) — aAll=true bAll=true
- PASS — 10. legacy: returns union across tenants — tenants=3 total=10
- PASS — 11. source-level: phase233/234 read+mutation+global+storage tags present — read=true mut=true global=true storage=true create=true update=true
