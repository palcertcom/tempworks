# Phase 2.35 — agencies isolation

**11/11 PASS**

- PASS — 1. findAll under tenant A: no tenant B rows (system agencies allowed) — count=8
- PASS — 2. findOne(tenantB-id) cross-tenant 404 — NotFound
- PASS — 3. search "Agency B" under A does not leak B — count=0
- PASS — 4. getUsers(tenantB-id) blocked at parent gate — NotFound
- PASS — 5. getEmployees(tenantB-id) blocked at parent gate — NotFound
- PASS — 6. getStats(tenantB-id) blocked at parent gate — NotFound
- PASS — 7. listPermissionOverrides(tenantB-id) blocked at parent gate — NotFound
- PASS — 8. system agency visible under both A and B (decision §6) — seenA=true seenB=true
- PASS — 9. concurrent ALS frames isolated — aNoB=true bNoA=true
- PASS — 10. legacy: returns union across tenants — tenants=3 total=15
- PASS — 11. source-level: phase235 tags + mutation/storage on legacyPrisma — read=true mut=true storage=true global=true create=true update=true
