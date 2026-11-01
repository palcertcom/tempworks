# Phase 2.36 — agencies mutation equivalence

**10/10 PASS**

- PASS — 1. create legacy: response shape preserved — id=c5d08200
- PASS — 2. create legacy: tenantId NULL — tenantId=null
- PASS — 3. create pilot + ALS A: tenantId = A — tenantId=11111111-1111-1111-1111-111111111111
- PASS — 4. update mutates field — phone=+99
- PASS — 6. uploadLogo same-tenant: 1 storage call + logoUrl set — uploads=1 url=true
- PASS — 7. setPermissionOverride creates record — allow=true
- PASS — 8. removePermissionOverride returns OK — Permission override removed
- PASS — 9. setManager updates managerId — mgr=true
- PASS — 5. remove sets deletedAt — deletedAt=true
- PASS — 10. pilot create with no ALS: tenantId NULL (System Admin fallback) — tenantId=null
