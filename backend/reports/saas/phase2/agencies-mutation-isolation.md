# Phase 2.36 — agencies mutation isolation

**9/9 PASS**

- PASS — 1. update(tenantB-id) rejected; B.phone unchanged — phone=+49
- PASS — 2. remove(tenantB-id) rejected; B.deletedAt unchanged — deletedAt=null
- PASS — 3. uploadLogo cross-tenant rejected; NO storage call — threw=true uploads=0
- PASS — 4. setPermissionOverride(tenantB-id) rejected; no override row — threw=true row=false
- PASS — 5. removePermissionOverride(tenantB-id) rejected — NotFound
- PASS — 6. setManager(tenantB-id) rejected; B.managerId unchanged — threw=true
- PASS — 7. legacy: cross-tenant update succeeds (preserved) — phone=+legacy-mp0ajkqv
- PASS — 8. concurrent ALS create A→A, B→B — a=11111111-1111-1111-1111-111111111111 b=22222222-2222-2222-2222-222222222222
- PASS — 9. source-level: phase236 tags + tenantAuditLog routing present — OK
