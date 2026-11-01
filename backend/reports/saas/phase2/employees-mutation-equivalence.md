# Phase 2.34 — employees mutation equivalence

**10/10 PASS**

- PASS — 1. create legacy: response shape — id=691e2437
- PASS — 2. create legacy: tenantId NULL — tenantId=null
- PASS — 3. create pilot: tenantId = A — tenantId=11111111-1111-1111-1111-111111111111
- PASS — 4. update mutates field — phone=+99
- PASS — 5. updateStatus mutates status — status=ACTIVE
- PASS — 6. remove sets deletedAt — deletedAt=true
- PASS — 7. uploadPhoto pilot same-tenant: 1 storage call + photoUrl set — uploads=1 url=true
- PASS — 8. grantAgencyAccess returns grant — view=true edit=true
- PASS — 9. updateAgencyAccess flips canEdit — edit=false
- PASS — 10. revokeAgencyAccess returns OK — Access revoked
